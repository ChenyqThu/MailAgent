"""提案失效判据收窄：只有「提案触及的对象/字段」与后续写入**有重叠**时才 stale。

旧语义 = matter.version 前进即作废 —— owner 在评审自己的提案期间点了 12 次
「接受资料建议」+ 4 次改标签，就把正等着自己审的提案作废了（活库实证 stale_at 与他
的点击相差 4 毫秒）。新语义按 changes_json 推导目标集比对，推导不出一律 fail closed。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.proposal_scope import (
    SCOPE_EVERYTHING,
    SCOPE_NOTHING,
    proposal_scope,
    scope_from_matter_columns,
    scope_from_resources,
)
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import MatterError

STATUS_CHANGE = {
    "id": "chg_status",
    "kind": "field",
    "target": {"entity": "matter", "field": "status"},
    "operation": "replace",
    "after": "active",
    "sources": [],
}


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "scope.db"
    SyncStore(str(path))
    service = MatterRunService(MatterRepository(path), clock_ms=lambda: 55_000)
    created = service.create_matter(
        {"title": "Scope Matter"}, idempotency_key="create", source="desktop_ui"
    )
    return service, created["matter"]["public_id"], str(path)


def _propose(service, pid, changes, *, summary="提案摘要", key="run-1"):
    version = service.get_matter(pid)["matter"]["version"]
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key=key, source="desktop_ui"
    )["run"]
    assert service.mark_started(run["id"])
    result = service.propose_update(
        pid, run["id"], {"summary": summary, "changes": changes}
    )
    return result["update_id"], run["id"]


def _is_stale(path, update_id):
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT is_stale FROM matter_update WHERE id=?", (update_id,)
        ).fetchone()
    return bool(row["is_stale"])


def _force_changes(path, update_id, raw_changes_json):
    """绕过 service 直接改 changes_json（模拟形状认不出的历史行）。"""
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter_update SET changes_json=? WHERE id=?",
            (raw_changes_json, update_id),
        )
        conn.commit()


# ── 端到端：service 层的收窄语义 ─────────────────────────────────────────────


def test_unrelated_field_write_keeps_proposal_acceptable(env):
    """改标签（提案碰不到的字段）→ 提案仍可接受。"""
    service, pid, path = env
    update_id, _ = _propose(service, pid, [STATUS_CHANGE])
    version = service.get_matter(pid)["matter"]["version"]
    service.patch_matter(
        pid,
        {"tags": ["客户", "紧急"]},
        expected_version=version,
        idempotency_key="patch-tags",
        source="desktop_ui",
    )
    assert _is_stale(path, update_id) is False
    result = service.accept_update(
        pid,
        update_id,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="acc-1",
        source="desktop_ui",
    )
    assert result["update"]["review_status"] == "accepted"
    assert result["matter"]["status"] == "active"


def test_accepting_resource_suggestions_keeps_proposal_acceptable(env):
    """owner 的原始现场：连点「接受资料建议」把 version 推前，提案不该因此作废。"""
    service, pid, path = env
    version = service.get_matter(pid)["matter"]["version"]
    added = service.add_resource(
        pid,
        {
            "provider": "notion",
            "kind": "doc",
            "external_key": "doc-1",
            "title": "方案稿",
        },
        expected_version=version,
        idempotency_key="add-res",
        source="desktop_ui",
    )
    resource_id = added["resources"][0]["resource"]["id"]
    update_id, _ = _propose(service, pid, [STATUS_CHANGE])
    for index in range(3):
        service.patch_resource(
            pid,
            resource_id,
            {"pinned": index % 2 == 0},
            expected_version=service.get_matter(pid)["matter"]["version"],
            idempotency_key=f"confirm-{index}",
            source="desktop_ui",
        )
    assert _is_stale(path, update_id) is False
    result = service.accept_update(
        pid,
        update_id,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="acc-1",
        source="desktop_ui",
    )
    assert result["update"]["review_status"] == "accepted"


def test_overlapping_field_write_still_stales_and_rejects_accept(env):
    """提案要改 status，随后有人也改 status → 仍然 stale 且拒绝接受。"""
    service, pid, path = env
    update_id, _ = _propose(service, pid, [STATUS_CHANGE])
    version = service.get_matter(pid)["matter"]["version"]
    service.patch_matter(
        pid,
        {"status": "waiting"},
        expected_version=version,
        idempotency_key="patch-status",
        source="desktop_ui",
    )
    assert _is_stale(path, update_id) is True
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid,
            update_id,
            expected_version=service.get_matter(pid)["matter"]["version"],
            idempotency_key="acc-1",
            source="desktop_ui",
        )
    assert excinfo.value.code == "E_UPDATE_STALE"


def test_item_touched_by_proposal_stales_when_that_item_changes(env):
    """提案触及某 item，该 item 被改 → stale；改另一条 item 不影响。"""
    service, pid, path = env
    version = service.get_matter(pid)["matter"]["version"]
    target = service.create_item(
        pid,
        {"kind": "action", "title": "催客户回信"},
        expected_version=version,
        idempotency_key="item-1",
        source="desktop_ui",
    )["item"]
    other = service.create_item(
        pid,
        {"kind": "action", "title": "另一条"},
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="item-2",
        source="desktop_ui",
    )["item"]
    update_id, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_item",
                "kind": "action",
                "target": {"entity": "item", "id": target["id"]},
                "after": {"status": "done"},
                "sources": [],
            }
        ],
    )
    service.update_item(
        pid,
        other["id"],
        {"title": "改了不相干的条目"},
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="upd-other",
        source="desktop_ui",
    )
    assert _is_stale(path, update_id) is False
    service.update_item(
        pid,
        target["id"],
        {"title": "用户自己改了这条"},
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="upd-target",
        source="desktop_ui",
    )
    assert _is_stale(path, update_id) is True


def test_summaryless_proposal_cannot_silently_overwrite_a_fresher_summary(env):
    """无 summary 的提案 + 用户刚写的 current_summary + accept 带 `edited_summary`。

    accept 接口允许**任意**提案携带 `edited_summary`，service 会把它落成
    `matter.current_summary`。若按「提案自己有没有 summary」推目标集，这份提案不会被
    用户改摘要标 stale，接受时却能把刚写的摘要静默覆盖 —— contracts §2.10
    「stale proposal 不允许静默应用」正是要防这个，而它是**收窄判据新开出来的**口子
    （收窄前 version 一变就全废，撞不上）。
    """
    service, pid, path = env
    item = service.create_item(
        pid,
        {"kind": "action", "title": "催客户回信"},
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="item-1",
        source="desktop_ui",
    )["item"]
    update_id, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_item",
                "kind": "action",
                "target": {"entity": "item", "id": item["id"]},
                "after": {"status": "done"},
                "sources": [],
            }
        ],
        summary=None,
    )
    service.patch_matter(
        pid,
        {"current_summary": "用户刚写的最新摘要"},
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="patch-summary",
        source="desktop_ui",
    )
    assert _is_stale(path, update_id) is True
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid,
            update_id,
            edited_summary="提案里的旧摘要",
            expected_version=service.get_matter(pid)["matter"]["version"],
            idempotency_key="acc-1",
            source="desktop_ui",
        )
    assert excinfo.value.code == "E_UPDATE_STALE"
    assert (
        service.get_matter(pid)["matter"]["current_summary"] == "用户刚写的最新摘要"
    )


def test_unparsable_change_shape_fails_closed(env):
    """change 形状无法解析 → fail closed 标 stale（宁可多作废一次）。"""
    service, pid, path = env
    update_id, _ = _propose(service, pid, [STATUS_CHANGE])
    _force_changes(path, update_id, '[{"kind": "field", "target": {"field": 42}}]')
    version = service.get_matter(pid)["matter"]["version"]
    # tags 与任何提案目标都不重叠；只有 fail-closed 才会让它 stale。
    service.patch_matter(
        pid,
        {"tags": ["客户"]},
        expected_version=version,
        idempotency_key="patch-tags",
        source="desktop_ui",
    )
    assert _is_stale(path, update_id) is True


def test_rejecting_one_proposal_does_not_stale_the_sibling(env):
    """拒绝一份提案不写任何业务状态 —— 不该顺带作废并排等审的另一份。"""
    service, pid, path = env
    first_id, first_run = _propose(service, pid, [STATUS_CHANGE], summary="第一份", key="run-a")
    service.finish_run(first_run, "ok")
    second_id, _ = _propose(service, pid, [STATUS_CHANGE], summary="第二份", key="run-b")
    service.reject_update(
        pid,
        first_id,
        reason="不采纳",
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="rej-1",
        source="desktop_ui",
    )
    assert _is_stale(path, second_id) is False


# ── 纯函数：目标集推导与 fail-closed 分支 ───────────────────────────────────


def test_scope_from_matter_columns_drops_bookkeeping_and_untouchable_columns():
    scope = scope_from_matter_columns(
        {"updated_at": 1, "last_activity_at": 1, "title": "x", "tags_json": "[]"}
    )
    assert scope.fields == frozenset()
    assert scope.overlaps(proposal_scope([STATUS_CHANGE])) is False
    assert scope_from_matter_columns(
        {"waiting_context_json": None}
    ).fields == frozenset({"waiting_context"})


def test_proposal_scope_ignores_fact_inference_and_item_creation():
    scope = proposal_scope(
        [
            {"kind": "fact", "text": "客户确认"},
            {"kind": "inference", "text": "大概率延期"},
            {"kind": "action", "text": "新建一条行动项"},
        ]
    )
    # 留档类 change 与新建 item 都不加任何目标；只剩恒在的 current_summary（下条测试）。
    assert scope.item_ids == frozenset()
    assert scope.resource_ids == frozenset()
    assert scope.wildcard is False
    assert scope.fields == frozenset({"current_summary"})


def test_proposal_scope_always_touches_current_summary():
    """accept 允许**任意**提案携带 `edited_summary` ⇒ 目标集恒含 current_summary。

    按提案自己有没有 summary 推会漏掉这条调用方带进来的写入面 —— 见
    `test_summaryless_proposal_cannot_silently_overwrite_a_fresher_summary`。
    """
    for changes in ([], [STATUS_CHANGE]):
        scope = proposal_scope(changes)
        assert "current_summary" in scope.fields
        assert (
            scope.overlaps(scope_from_matter_columns({"current_summary": "新的"}))
            is True
        )


@pytest.mark.parametrize(
    "raw",
    [
        "not-json",
        '"a string is valid json but not a change list"',
        '[{"kind": "field", "target": "not-a-mapping"}]',
        '[{"kind": "field", "target": {"field": "description"}}]',
        '[{"kind": "action", "target": {"id": "not-an-int"}}]',
        '[{"kind": "resource", "target": {}}]',
        '[{"kind": "brand_new_kind"}]',
        "[42]",
    ],
)
def test_proposal_scope_fail_closed_shapes(raw):
    assert proposal_scope(raw) == SCOPE_EVERYTHING


def test_scope_overlap_matrix():
    assert SCOPE_NOTHING.overlaps(SCOPE_NOTHING) is False
    assert SCOPE_NOTHING.overlaps(SCOPE_EVERYTHING) is True
    assert SCOPE_EVERYTHING.overlaps(SCOPE_NOTHING) is True
    assert scope_from_resources([1]).overlaps(scope_from_resources([2])) is False
    assert scope_from_resources([1, 2]).overlaps(scope_from_resources([2])) is True
    assert scope_from_resources(["oops"]) == SCOPE_EVERYTHING
