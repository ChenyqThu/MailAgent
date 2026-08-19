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

SPEC_URL = "https://example.com/spec"
NEW_RESOURCE_CHANGE = {
    "id": "chg_res_new",
    "kind": "resource",
    "resource": {
        "provider": "web",
        "kind": "url",
        "external_key": SPEC_URL,
        "title": "规格稿",
    },
    "sources": [],
}


def _link_state(path, external_key):
    """(link 是否活着, confirmed_at) —— 复活会同时翻这两项。"""
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT mr.deleted_at, mr.confirmed_at FROM matter_resource mr "
            "JOIN resource r ON r.id=mr.resource_id WHERE r.external_key=?",
            (external_key,),
        ).fetchone()
    if row is None:
        return None
    return (row["deleted_at"] is None, row["confirmed_at"])


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


def test_accepting_an_old_proposal_cannot_revive_a_link_owner_just_removed(env):
    """🔴 owner 在评审期间解除关联 → 那份提案里的同一份资料**不许**被接受时静默复活。

    `_apply_new_resource_link` 对 soft-deleted 的 link 走的是「复活那一行 + 标 confirmed」，
    所以带 `resource` 的 change **不是**无条件的纯追加：只要本事项曾经有过这份资料的 link，
    接受就会覆盖 owner 刚做的决定。把它当纯追加 ⇒ 解除关联那次写入（scope={resource_id}）
    与提案 scope 不重叠 ⇒ 提案不 stale ⇒ 覆盖静默发生。`expected_version` 补不了这个洞：
    它只保护「请求发出之后」的并发。
    """
    service, pid, path = env
    added = service.add_resource(
        pid,
        {
            "provider": "web",
            "kind": "url",
            "external_key": SPEC_URL,
            "title": "规格稿",
        },
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="add-web",
        source="desktop_ui",
    )
    resource_id = added["resources"][0]["resource"]["id"]
    update_id, _ = _propose(service, pid, [NEW_RESOURCE_CHANGE])
    service.unlink_resource(
        pid,
        resource_id,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="unlink-web",
        source="desktop_ui",
    )
    assert _link_state(path, SPEC_URL) == (False, None)

    assert _is_stale(path, update_id) is True
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid,
            update_id,
            expected_version=service.get_matter(pid)["matter"]["version"],
            idempotency_key="acc-revive",
            source="desktop_ui",
        )
    assert excinfo.value.code == "E_UPDATE_STALE"
    # owner 的解除仍然成立 —— 没有被旧提案静默翻回来。
    assert _link_state(path, SPEC_URL) == (False, None)


def test_rejected_suggestion_cannot_be_revived_by_an_old_proposal(env):
    """同一个洞的第二个形态：owner 点的是「忽略这条建议」（soft delete + 记抑制）。"""
    service, pid, path = env
    added = service.add_resource(
        pid,
        {"provider": "web", "kind": "url", "external_key": SPEC_URL, "title": "规格稿"},
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="add-web",
        source="desktop_ui",
    )
    resource_id = added["resources"][0]["resource"]["id"]
    update_id, _ = _propose(service, pid, [NEW_RESOURCE_CHANGE])
    service.reject_resource_suggestion(
        pid,
        resource_id,
        reason="与本事项无关",
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="reject-web",
        source="desktop_ui",
    )

    assert _is_stale(path, update_id) is True
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid,
            update_id,
            expected_version=service.get_matter(pid)["matter"]["version"],
            idempotency_key="acc-revive",
            source="desktop_ui",
        )
    assert excinfo.value.code == "E_UPDATE_STALE"
    assert _link_state(path, SPEC_URL) == (False, None)


def test_a_genuinely_new_resource_proposal_stays_pure_append(env):
    """🔴 反向闸：**真·全新**资料（本事项从没关联过）仍是纯追加。

    否则收窄就退回了「任何一次无关写入都把带新资料的提案作废」那个钝化代理 —— 正是
    本模块当初要消灭的东西。这里改的是**另一条**资料的关联状态。
    """
    service, pid, path = env
    other = service.add_resource(
        pid,
        {
            "provider": "web",
            "kind": "url",
            "external_key": "https://example.com/other",
            "title": "别的资料",
        },
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="add-other",
        source="desktop_ui",
    )
    other_id = other["resources"][0]["resource"]["id"]
    update_id, _ = _propose(service, pid, [NEW_RESOURCE_CHANGE])
    service.unlink_resource(
        pid,
        other_id,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="unlink-other",
        source="desktop_ui",
    )

    assert _is_stale(path, update_id) is False
    result = service.accept_update(
        pid,
        update_id,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="acc-new",
        source="desktop_ui",
    )
    assert result["update"]["review_status"] == "accepted"
    # 接受确实把这份新资料关联上了（纯追加语义没被误伤）。
    assert _link_state(path, SPEC_URL)[0] is True


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


NEW_RESOURCE_CHANGES = [
    {
        "id": "chg_res",
        "kind": "resource",
        "resource": {
            "provider": "notion",
            "kind": "doc",
            "external_key": "page:abc",
        },
    }
]


def test_new_resource_link_is_pure_append_only_when_never_linked():
    """`kind=resource` 带 `resource`（新建关联）的三种解析结果。

    · 解析器说「本事项没关联过」→ 纯追加，不进目标集（不进 = 无关写入不作废这份提案，
      正是本模块要收窄掉的钝化代理）；
    · 解析器交出既有 resource_id（含 owner 解除过的 soft-deleted 行）→ 进目标集；
    · 没给解析器 → fail closed（身份断不出来时不许猜"它是全新的"）。
    带 target.id 的确认形态不变。
    """
    fresh = proposal_scope(NEW_RESOURCE_CHANGES, resolve_new_resource=lambda spec: None)
    assert fresh.wildcard is False
    assert fresh.resource_ids == frozenset()
    assert fresh.overlaps(scope_from_resources([7])) is False

    known = proposal_scope(NEW_RESOURCE_CHANGES, resolve_new_resource=lambda spec: 7)
    assert known.wildcard is False
    assert known.resource_ids == frozenset({7})
    assert known.overlaps(scope_from_resources([7])) is True

    assert proposal_scope(NEW_RESOURCE_CHANGES) == SCOPE_EVERYTHING
    # 确认既有 link 的老形态照旧进目标集（不经解析器）
    confirm = proposal_scope([{"kind": "resource", "target": {"entity": "resource", "id": 7}}])
    assert confirm.resource_ids == frozenset({7})


@pytest.mark.parametrize(
    "resolver",
    [
        lambda spec: (_ for _ in ()).throw(ValueError("identity undecidable")),
        lambda spec: "7",
        lambda spec: True,
    ],
    ids=["raises", "not-an-int", "bool-is-not-an-id"],
)
def test_new_resource_identity_failures_fail_closed(resolver):
    """解析器抛异常 / 交出认不出的东西 → wildcard，绝不退回"纯追加"。"""
    assert (
        proposal_scope(NEW_RESOURCE_CHANGES, resolve_new_resource=resolver)
        == SCOPE_EVERYTHING
    )


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
        # S3 起 `description` 进了提案白名单 —— 这条语料要的是「白名单**外**的字段」，
        # 换成 `title`（提案结构上永远碰不到它）。
        '[{"kind": "field", "target": {"field": "title"}}]',
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
