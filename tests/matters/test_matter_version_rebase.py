"""0813 A2 —— 子实体写入的 stale-base auto-rebase（bounded，按版本账本 gap scan）。

owner 实录：agent 创建事项后并行发 9 个子实体写（2×item + 6×stakeholder + 1×resource），
第 1 笔把 matter.version 推到 2，其余 8 笔全被钝化的 matter 级 CAS 拒掉。判据换成
「(expected, current] 之间的写入目标与本次写入目标是否重叠」（`_cas_update_rebase` +
sync_state `matter_version_scopes:*` 账本）：

- 追加 / 别人没碰过的行的编辑 → stale base 照常成功（auto-rebase）；
- 同一行（item/stakeholder/relation/resource link）被并发改过 → 仍 E_VERSION_CONFLICT；
- matter 级字段写（patch_matter/归档/接受提案）保持严格 CAS，不走 rebase；
- 账本盖不住 gap（存量库 / 账本丢失）→ fail-closed 回严格 CAS。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "rebase.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)
    created = service.create_matter(
        {"title": "Parallel writes"}, idempotency_key="create", source="desktop_ui"
    )
    return service, created["matter"]["public_id"], str(path)


def mutation(version: int, key: str) -> dict:
    return {"expected_version": version, "idempotency_key": key, "source": "desktop_ui"}


def test_stale_base_parallel_subentity_appends_all_succeed(env):
    """验收 ①：stale base 下 ≥8 连子实体追加全部成功（复刻 owner 的 9 笔并行写）。"""
    service, public_id, _ = env
    results = []
    # 全部 9 笔都拿创建时的 version=1 当 base —— 第 1 笔之后其余全是 stale。
    for i in range(2):
        results.append(
            service.create_item(
                public_id,
                {"kind": "action", "title": f"行动项 {i}"},
                **mutation(1, f"item-{i}"),
            )
        )
    for i in range(6):
        results.append(
            service.create_stakeholder(
                public_id,
                {"display_name": f"干系人{i}", "email": f"p{i}@example.test"},
                **mutation(1, f"stk-{i}"),
            )
        )
    results.append(
        service.add_resource(
            public_id,
            {"provider": "mailagent", "external_key": "thread:t1", "kind": "thread"},
            **mutation(1, "res-1"),
        )
    )
    assert len(results) == 9
    after = service.get_matter(public_id)["matter"]
    assert after["version"] == 1 + 9  # 每笔照常 bump，一笔都没被拒
    assert len(service.list_items(public_id)) == 2
    assert len(service.list_stakeholders(public_id)) == 6
    assert len(service.list_resources(public_id)) == 1


def test_stale_base_edit_of_untouched_row_succeeds(env):
    """「独立行编辑」：gap 里只有别的行 / 无关 matter 字段的写入 → auto-rebase。"""
    service, public_id, _ = env
    a = service.create_item(
        public_id, {"kind": "action", "title": "A"}, **mutation(1, "item-a")
    )
    b = service.create_item(
        public_id, {"kind": "action", "title": "B"}, **mutation(a["version"], "item-b")
    )
    base = b["version"]
    # gap 写入 1：改 item A；gap 写入 2：改 matter 的 title（提案碰不到的字段，空 scope）。
    service.update_item(
        public_id, a["item"]["id"], {"status": "in_progress"}, **mutation(base, "edit-a")
    )
    service.patch_matter(
        public_id, {"title": "Renamed"}, **mutation(base + 1, "rename")
    )
    # 用两个版本前的 base 编辑 item B —— 与 gap 内两笔写入目标都不重叠。
    edited = service.update_item(
        public_id, b["item"]["id"], {"status": "waiting"}, **mutation(base, "edit-b")
    )
    assert edited["item"]["status"] == "waiting"
    assert edited["version"] == base + 3


def test_same_item_concurrent_edit_still_conflicts(env):
    """验收 ②：同一行被并发改过 → 仍被挡（含同字段场景）。"""
    service, public_id, _ = env
    created = service.create_item(
        public_id, {"kind": "action", "title": "A"}, **mutation(1, "item")
    )
    item_id = created["item"]["id"]
    base = created["version"]
    service.update_item(
        public_id, item_id, {"status": "in_progress"}, **mutation(base, "first")
    )
    with pytest.raises(MatterError) as exc:
        service.update_item(
            public_id, item_id, {"status": "done"}, **mutation(base, "second")
        )
    assert exc.value.code == "E_VERSION_CONFLICT"


def test_matter_field_writes_keep_strict_cas(env):
    """matter 级字段（state/goal/status…）不走 rebase：stale base 一律冲突。"""
    service, public_id, _ = env
    service.patch_matter(public_id, {"status": "active"}, **mutation(1, "first"))
    with pytest.raises(MatterError) as exc:
        service.patch_matter(public_id, {"status": "waiting"}, **mutation(1, "second"))
    assert exc.value.code == "E_VERSION_CONFLICT"
    # 即便 gap 里只有无关的子实体追加，matter 级写仍要求最新版本（严格路径不看账本）。
    current = service.get_matter(public_id)["matter"]["version"]
    service.create_item(
        public_id, {"kind": "note", "title": "n"}, **mutation(current, "note")
    )
    with pytest.raises(MatterError) as exc:
        service.patch_matter(public_id, {"status": "blocked"}, **mutation(current, "third"))
    assert exc.value.code == "E_VERSION_CONFLICT"


def test_same_stakeholder_conflicts_other_stakeholder_rebases(env):
    service, public_id, _ = env
    s1 = service.create_stakeholder(
        public_id, {"display_name": "甲", "email": "a@example.test"}, **mutation(1, "s1")
    )
    s2 = service.create_stakeholder(
        public_id,
        {"display_name": "乙", "email": "b@example.test"},
        **mutation(s1["version"], "s2"),
    )
    base = s2["version"]
    service.update_stakeholder(
        public_id, s1["stakeholder"]["id"], {"role": "决策人"}, **mutation(base, "edit-1")
    )
    # 同一行：stale base + gap 里改过它 → 冲突。
    with pytest.raises(MatterError) as exc:
        service.update_stakeholder(
            public_id, s1["stakeholder"]["id"], {"role": "执行人"}, **mutation(base, "edit-2")
        )
    assert exc.value.code == "E_VERSION_CONFLICT"
    # 别的行：同一个 stale base 照常成功。
    edited = service.update_stakeholder(
        public_id, s2["stakeholder"]["id"], {"role": "观察者"}, **mutation(base, "edit-3")
    )
    assert edited["stakeholder"]["role"] == "观察者"


def test_future_base_version_is_rejected(env):
    service, public_id, _ = env
    with pytest.raises(MatterError) as exc:
        service.create_item(
            public_id, {"kind": "action", "title": "x"}, **mutation(99, "future")
        )
    assert exc.value.code == "E_VERSION_CONFLICT"


def test_missing_ledger_fails_closed_to_strict_cas(env):
    """账本盖不住 gap（存量库 / 账本丢失）→ 回严格 CAS，绝不猜。"""
    service, public_id, path = env
    service.create_item(public_id, {"kind": "action", "title": "x"}, **mutation(1, "i1"))
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM sync_state WHERE key LIKE 'matter_version_scopes:%'")
        conn.commit()
    with pytest.raises(MatterError) as exc:
        service.create_item(
            public_id, {"kind": "action", "title": "y"}, **mutation(1, "i2")
        )
    assert exc.value.code == "E_VERSION_CONFLICT"


def test_wildcard_gap_write_blocks_stale_writes(env):
    """gap 里有聚合级写入（归档 —— scope 缺省 ≙ 触及一切）→ stale 写保守冲突。"""
    service, public_id, _ = env
    service.archive(public_id, **mutation(1, "archive"))
    with pytest.raises(MatterError) as exc:
        service.create_item(
            public_id, {"kind": "action", "title": "x"}, **mutation(1, "late")
        )
    assert exc.value.code == "E_VERSION_CONFLICT"


def test_stakeholder_append_no_longer_invalidates_pending_proposals(env):
    """加干系人是纯追加：不再把待审提案整批作废（与 create_item 的判据对齐）。"""
    service, public_id, path = env
    matter = service.get_matter(public_id)["matter"]
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_update(matter_id,review_status,anchored_matter_version,"
            "original_proposal_json,changes_json,citations_json,created_by_kind,created_at) "
            "VALUES (?,'pending',?,'{}','[]','[]','agent',1)",
            (matter["id"], matter["version"]),
        )
        conn.commit()
    service.create_stakeholder(
        public_id, {"display_name": "丙", "email": "c@example.test"}, **mutation(1, "s1")
    )
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT is_stale FROM matter_update WHERE matter_id=?", (matter["id"],)
        ).fetchone()
    assert row["is_stale"] == 0