"""批量确认 / 忽略资料建议（0812 dogfood P0 第二条）。

盯三件事：
1. **一次版本推进** —— 逐条口是「一份建议一次 bump」，Agent 一轮挂十几份就等于把版本号
   推十几格，中间任何一次错位都会撞乐观锁。
2. **逐条不整批失败** —— 批里混进已确认 / 已删 / 不属于本事项的 id 要如实分开计数。
3. **忽略走 rejection 语义** —— 只删 link 不记 evidence_fingerprint 的话，下一次同证据的
   提案会把它们原样推回来。

🔴 task 08-25：关键词命中式的 `discover_resource_suggestions` 已退役，unconfirmed 建议
改由测试直接以 agent 身份关联（形状与会议结束提案链落下来的行逐字一致：
`added_by_kind='agent'` + `confirmed_at IS NULL` + provenance 带 evidence 与 fingerprint）。
被测的批量口一个字节没动。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.events import (
    RESOURCE_SUGGESTION_ACCEPTED,
    RESOURCE_SUGGESTION_REJECTED,
)
from src.matters.repository import MatterRepository
from src.matters.resource_identity import evidence_fingerprint, rejection_resource_key
from src.matters.service import Actor, MatterError, MatterService


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "matter-bulk.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)
    return service, path


def _mutation(version: int, key: str) -> dict[str, object]:
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def _insert_email(path, internal_id: int, *, thread_id: str, subject: str) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO email_metadata "
            "(internal_id,message_id,thread_id,subject,sender,to_addr,date_received,snippet) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                internal_id,
                f"message-{internal_id}",
                thread_id,
                subject,
                "lead@example.com",
                "owner@example.com",
                f"2026-08-{internal_id:02d}T12:00:00Z",
                "",
            ),
        )
        conn.commit()


def _suggestion_provenance(external_key: str) -> dict[str, object]:
    """Agent 提案链落下来的 provenance 形状（`propose_calendar_event_resource` 同款）。"""
    evidence = ["thread:bulk-thread", "stakeholder:lead@example.com"]
    return {
        "reason": "与已关联邮件处于同一线程",
        "evidence": evidence,
        "evidence_fingerprint": evidence_fingerprint(
            rejection_resource_key("mailagent", "email", external_key), evidence
        ),
    }


def _matter_with_suggestions(service, path, count: int):
    """建一个事项 + 一封人工关联的锚点邮件 + `count` 条 agent 挂上来的**未确认**建议。"""
    _insert_email(path, 1, thread_id="bulk-thread", subject="Anchor")
    created = service.create_matter(
        {"title": "Bulk suggestions"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {"provider": "mailagent", "kind": "email", "external_key": "email:1"},
        **_mutation(created["version"], "link-anchor"),
    )
    version = linked["version"]
    suggestions = []
    for index in range(2, 2 + count):
        _insert_email(path, index, thread_id="bulk-thread", subject=f"Reply {index}")
        external_key = f"email:{index}"
        added = service.add_resource(
            public_id,
            {
                "provider": "mailagent",
                "kind": "email",
                "external_key": external_key,
                "confidence": 0.62,
                "provenance": _suggestion_provenance(external_key),
            },
            actor=Actor(kind="agent"),
            **_mutation(version, f"suggest-{index}"),
        )
        version = added["version"]
        suggestions.append(added["resources"][0])
    assert len(suggestions) == count
    assert all(item["link"]["confirmed_at"] is None for item in suggestions)
    assert all(item["link"]["added_by_kind"] == "agent" for item in suggestions)
    return public_id, suggestions, version


def test_bulk_confirm_advances_version_once(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 4)
    ids = [item["resource"]["id"] for item in suggestions]

    result = service.bulk_resolve_resource_suggestions(
        public_id, ids, "confirm", **_mutation(version, "bulk-confirm")
    )

    assert result["counts"] == {"applied": 4, "skipped": 0}
    assert sorted(result["applied"]) == sorted(ids)
    # 🔴 4 份资料，版本只前进 1 —— 逐条口这里会是 +4。
    assert result["version"] == version + 1
    assert len(result["event_ids"]) == 4
    listed = {
        item["resource"]["id"]: item["link"] for item in service.list_resources(public_id)
    }
    assert all(listed[resource_id]["confirmed_at"] is not None for resource_id in ids)
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT kind, happened_at FROM matter_event WHERE kind=?",
            (RESOURCE_SUGGESTION_ACCEPTED,),
        ).fetchall()
    assert len(rows) == 4
    # 同毫秒同 kind ⇒ 时间线的 burst 分组把它们合成一句「采纳了 4 条资料建议」。
    assert len({row["happened_at"] for row in rows}) == 1


def test_bulk_reject_writes_rejection_memory_and_suppresses_rediscovery(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 3)
    ids = [item["resource"]["id"] for item in suggestions]

    result = service.bulk_resolve_resource_suggestions(
        public_id, ids, "reject", **_mutation(version, "bulk-reject")
    )

    assert result["counts"] == {"applied": 3, "skipped": 0}
    assert result["version"] == version + 1
    # 三条建议的 link 都软删了，只剩人工关联的那封锚点邮件。
    remaining = service.list_resources(public_id)
    assert [item["resource"]["external_key"] for item in remaining] == ["email:1"]
    with sqlite3.connect(path) as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM matter_event WHERE kind=?",
                (RESOURCE_SUGGESTION_REJECTED,),
            ).fetchone()[0]
            == 3
        )
        fingerprints = [
            row[0]
            for row in conn.execute(
                "SELECT evidence_fingerprint FROM matter_resource_rejection"
            ).fetchall()
        ]
    assert len(fingerprints) == 3
    assert all(fingerprint for fingerprint in fingerprints)
    # 🔴 记的账要能真的挡住下一次 —— 抑制判据是「同 resource_key 且同 evidence_fingerprint」
    # （`propose_calendar_event_resource` 与 `_email_resource_candidates` 共用的那一条）。
    # 只断言「有三行」会放过「记了但记的是别的指纹」这种静默失效。
    with service.repository.connect() as conn:
        matter_id = service.get_matter(public_id)["matter"]["id"]
        for item in suggestions:
            external_key = item["resource"]["external_key"]
            canonical_key = rejection_resource_key("mailagent", "email", external_key)
            remembered = service.repository.get_resource_rejection(
                conn, matter_id, canonical_key
            )
            assert remembered is not None
            assert (
                remembered["evidence_fingerprint"]
                == _suggestion_provenance(external_key)["evidence_fingerprint"]
            )


def test_bulk_confirm_classifies_bad_ids_without_failing_the_batch(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 3)
    ids = [item["resource"]["id"] for item in suggestions]
    already = service.patch_resource(
        public_id, ids[0], {"confirmed": True}, **_mutation(version, "single-confirm")
    )

    result = service.bulk_resolve_resource_suggestions(
        public_id,
        [ids[0], ids[1], 987_654, ids[2], ids[2]],
        "confirm",
        **_mutation(already["version"], "bulk-mixed"),
    )

    assert result["counts"] == {"applied": 2, "skipped": 2}
    assert sorted(result["applied"]) == sorted([ids[1], ids[2]])
    assert result["skipped"] == [
        {"resource_id": ids[0], "reason": "already_confirmed"},
        {"resource_id": 987_654, "reason": "not_linked"},
    ]
    assert result["version"] == already["version"] + 1


def test_bulk_replay_is_a_no_op_and_does_not_advance_version(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 2)
    ids = [item["resource"]["id"] for item in suggestions]

    first = service.bulk_resolve_resource_suggestions(
        public_id, ids, "reject", **_mutation(version, "bulk-replay")
    )
    replay = service.bulk_resolve_resource_suggestions(
        public_id, ids, "reject", **_mutation(version, "bulk-replay")
    )

    assert first["counts"] == {"applied": 2, "skipped": 0}
    # 🔴 重放时 link 已经被软删 —— 若先判「找不到」就会把「已经做过」谎报成 not_linked。
    assert replay["counts"] == {"applied": 0, "skipped": 2}
    assert {entry["reason"] for entry in replay["skipped"]} == {"already_applied"}
    assert replay["version"] == first["version"]


def test_bulk_reuse_of_key_for_the_other_action_is_rejected(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 2)
    ids = [item["resource"]["id"] for item in suggestions]
    confirmed = service.bulk_resolve_resource_suggestions(
        public_id, ids, "confirm", **_mutation(version, "bulk-shared-key")
    )

    with pytest.raises(MatterError) as exc_info:
        service.bulk_resolve_resource_suggestions(
            public_id, ids, "reject", **_mutation(confirmed["version"], "bulk-shared-key")
        )
    assert exc_info.value.code == "E_IDEMPOTENCY_CONFLICT"


def test_bulk_with_nothing_applicable_keeps_the_version(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 1)
    ids = [item["resource"]["id"] for item in suggestions]
    confirmed = service.bulk_resolve_resource_suggestions(
        public_id, ids, "confirm", **_mutation(version, "bulk-first")
    )

    nothing = service.bulk_resolve_resource_suggestions(
        public_id, ids, "confirm", **_mutation(confirmed["version"], "bulk-second")
    )

    assert nothing["counts"] == {"applied": 0, "skipped": 1}
    assert nothing["skipped"] == [{"resource_id": ids[0], "reason": "already_confirmed"}]
    # 空转不推进版本 —— 版本号是提案失效的判据，白 bump 会作废别人正等着审的提案。
    assert nothing["version"] == confirmed["version"]
    assert nothing["event_ids"] == []


def test_bulk_version_conflict_is_reported_once_for_the_whole_batch(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 2)
    ids = [item["resource"]["id"] for item in suggestions]

    with pytest.raises(MatterError) as exc_info:
        service.bulk_resolve_resource_suggestions(
            public_id, ids, "confirm", **_mutation(version - 1, "bulk-stale")
        )

    assert exc_info.value.code == "E_VERSION_CONFLICT"
    # 冲突时一条都没落库（整笔事务回滚）。
    assert all(
        item["link"]["confirmed_at"] is None
        for item in service.list_resources(public_id)
        if item["resource"]["id"] in ids
    )


def test_bulk_rejects_invalid_action_and_empty_ids(env):
    service, path = env
    public_id, suggestions, version = _matter_with_suggestions(service, path, 1)
    ids = [item["resource"]["id"] for item in suggestions]

    with pytest.raises(MatterError) as invalid_action:
        service.bulk_resolve_resource_suggestions(
            public_id, ids, "delete", **_mutation(version, "bulk-bad-action")
        )
    assert invalid_action.value.code == "E_INVALID_ARG"

    with pytest.raises(MatterError) as empty:
        service.bulk_resolve_resource_suggestions(
            public_id, [], "confirm", **_mutation(version, "bulk-empty")
        )
    assert empty.value.code == "E_INVALID_ARG"
