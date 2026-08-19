"""S2 — 干系人分层（core / normal）与自定义顺序（DB v60）。

owner 需求：「干系人可以区分核心/非核心，非核心默认折叠，可以拖拽排序和调整分组。」

钉死的语义：
1. tier 与 sort_order 是**两个独立维度**（分组 vs 组内先后）
2. 新建默认 `normal`（核心组是给 owner 一眼扫的短名单）
3. 读侧排序 = 核心在前 → sort_order → id 兜底
4. 非法 tier **报错**不静默降档
5. 整批 reorder 一个事务一次 CAS（逐条 PATCH 必撞版本冲突）
6. 老库升级后**显示顺序逐行不变**
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.models import (
    MATTER_STAKEHOLDER_DEFAULT_TIER,
    MATTER_STAKEHOLDER_REORDER_MAX,
    MATTER_STAKEHOLDER_TIERS,
    MatterStakeholderTier,
)
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterError, MatterService

NOW = 1_760_000_000_000


def _service(tmp_path):
    path = tmp_path / "tier.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)


def _matter(service):
    return service.create_matter({"title": "t"}, idempotency_key="c", source="test")["matter"]


def _add(service, matter, *, name, tier=None, key):
    data = {"display_name": name, "email": f"{name}@example.test"}
    if tier is not None:
        data["tier"] = tier
    return service.create_stakeholder(
        matter["public_id"], data,
        idempotency_key=key, source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )


def _names(service, matter) -> list[str]:
    return [s["display_name"] for s in service.list_stakeholders(matter["public_id"])]


# ============================================================
# 默认与值域
# ============================================================

def test_default_tier_is_normal(tmp_path):
    """🔴 默认进 normal —— 默认进核心会让「核心组」当场失去意义。"""
    service = _service(tmp_path)
    matter = _matter(service)
    _add(service, matter, name="a", key="s1")
    assert service.list_stakeholders(matter["public_id"])[0]["tier"] == "normal"
    assert MATTER_STAKEHOLDER_DEFAULT_TIER == MatterStakeholderTier.NORMAL


def test_tier_values_are_exactly_two(tmp_path):
    """两档是有意的：折叠只需要一条线，三档以上会让 owner 每次都要想。"""
    assert set(MATTER_STAKEHOLDER_TIERS) == {"core", "normal"}


@pytest.mark.parametrize("bad", ["important", "CORE", "", "  ", "0"])
def test_invalid_tier_raises(tmp_path, bad):
    """🔴 非法值报错而不是静默落 normal —— 静默降档会让 owner 以为标了核心，
    结果那个人藏在折叠区里。"""
    service = _service(tmp_path)
    matter = _matter(service)
    with pytest.raises(MatterError) as exc:
        _add(service, matter, name="a", tier=bad, key="s1")
    assert exc.value.code == "E_INVALID_ARG"


def test_db_check_constraint_rejects_bad_tier(tmp_path):
    """SQL CHECK 也拦 —— 服务层被绕过时（直接 SQL / 未来新写路径）仍有地板。"""
    path = tmp_path / "check.db"
    SyncStore(str(path))
    conn = sqlite3.connect(str(path))
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO matter_stakeholder "
                "(matter_id, person_key, tier, created_at, updated_at) VALUES (1,'k','vip',0,0)"
            )
    finally:
        conn.close()


# ============================================================
# 排序
# ============================================================

def test_core_sorts_before_normal(tmp_path):
    service = _service(tmp_path)
    matter = _matter(service)
    _add(service, matter, name="n1", key="s1")
    _add(service, matter, name="c1", tier="core", key="s2")
    _add(service, matter, name="n2", key="s3")
    assert _names(service, matter) == ["c1", "n1", "n2"]


def test_new_stakeholder_goes_to_the_end(tmp_path):
    """新人排到末尾，不插队。"""
    service = _service(tmp_path)
    matter = _matter(service)
    for i, key in enumerate(["s1", "s2", "s3"]):
        _add(service, matter, name=f"p{i}", key=key)
    assert _names(service, matter) == ["p0", "p1", "p2"]


def test_sort_order_is_not_patchable_one_by_one(tmp_path):
    """🔴 逐条 PATCH 不收 sort_order —— 一次拖拽改多行，逐条发必撞版本冲突。"""
    service = _service(tmp_path)
    matter = _matter(service)
    created = _add(service, matter, name="a", key="s1")
    stakeholder_id = created["stakeholder"]["id"]
    before = service.list_stakeholders(matter["public_id"])[0]["sort_order"]
    service.update_stakeholder(
        matter["public_id"], stakeholder_id, {"sort_order": 999},
        idempotency_key="p1", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    assert service.list_stakeholders(matter["public_id"])[0]["sort_order"] == before


# ============================================================
# 批量重排
# ============================================================

def _reorder(service, matter, items, *, key="r1"):
    return service.reorder_stakeholders(
        matter["public_id"], items,
        idempotency_key=key, source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )


def test_reorder_within_group(tmp_path):
    service = _service(tmp_path)
    matter = _matter(service)
    ids = [_add(service, matter, name=f"p{i}", key=f"s{i}")["stakeholder"]["id"] for i in range(3)]
    assert _names(service, matter) == ["p0", "p1", "p2"]
    # 把 p2 拖到最前
    _reorder(service, matter, [
        {"id": ids[2], "sort_order": 0},
        {"id": ids[0], "sort_order": 1},
        {"id": ids[1], "sort_order": 2},
    ])
    assert _names(service, matter) == ["p2", "p0", "p1"]


def test_reorder_moves_across_groups(tmp_path):
    """跨组拖拽 = 同一批里顺带改 tier。"""
    service = _service(tmp_path)
    matter = _matter(service)
    ids = [_add(service, matter, name=f"p{i}", key=f"s{i}")["stakeholder"]["id"] for i in range(3)]
    _reorder(service, matter, [{"id": ids[1], "sort_order": 0, "tier": "core"}])
    rows = service.list_stakeholders(matter["public_id"])
    assert [r["display_name"] for r in rows] == ["p1", "p0", "p2"]
    assert rows[0]["tier"] == "core"


def test_reorder_is_one_cas_not_n(tmp_path):
    """🔴 整批 = 一次版本推进。逐条 PATCH 的话第 2 条就会撞 E_VERSION_CONFLICT ——
    这正是 0812 dogfood P0「不管点哪个都是 matter version changed」的形状。"""
    service = _service(tmp_path)
    matter = _matter(service)
    ids = [_add(service, matter, name=f"p{i}", key=f"s{i}")["stakeholder"]["id"] for i in range(4)]
    before = service.get_matter(matter["public_id"])["matter"]["version"]
    _reorder(service, matter, [
        {"id": sid, "sort_order": order} for order, sid in enumerate(reversed(ids))
    ])
    after = service.get_matter(matter["public_id"])["matter"]["version"]
    assert after == before + 1, "整批重排只该推进一次版本"


def test_reorder_rejects_foreign_stakeholder(tmp_path):
    """🔴 不属于本事项 → 硬拒整批。放过它 = 调用方以为整批成了，而实际顺序与它手里那份
    不一致，下一次拖拽会基于错的基线再算一次。"""
    service = _service(tmp_path)
    a = _matter(service)
    b = service.create_matter({"title": "other"}, idempotency_key="c2", source="test")["matter"]
    mine = _add(service, a, name="mine", key="s1")["stakeholder"]["id"]
    theirs = _add(service, b, name="theirs", key="s2")["stakeholder"]["id"]
    with pytest.raises(MatterError) as exc:
        _reorder(service, a, [{"id": mine, "sort_order": 0}, {"id": theirs, "sort_order": 1}])
    assert exc.value.code == "E_CHILD_NOT_FOUND"


def test_reorder_rejects_bad_shapes(tmp_path):
    service = _service(tmp_path)
    matter = _matter(service)
    sid = _add(service, matter, name="a", key="s1")["stakeholder"]["id"]
    for bad in (
        [{"id": sid}],                            # 缺 sort_order
        [{"id": sid, "sort_order": "1"}],         # 字符串
        [{"id": sid, "sort_order": True}],        # bool 是 int 的子类，必须单独挡
        [{"id": "x", "sort_order": 0}],
        ["not-an-object"],
    ):
        with pytest.raises(MatterError):
            _reorder(service, matter, bad, key=f"r-{bad!r}")


def test_reorder_publishes_matter_changed(tmp_path):
    """S1 的刷新链路要接得住重排 —— 拖完不刷新等于白拖。"""
    from unittest.mock import patch

    service = _service(tmp_path)
    matter = _matter(service)
    sid = _add(service, matter, name="a", key="s1")["stakeholder"]["id"]
    with patch("src.matters.service.safe_publish") as publish:
        _reorder(service, matter, [{"id": sid, "sort_order": 5}])
    published = [
        call.kwargs["data"]["public_id"]
        for call in publish.call_args_list
        if call.args and call.args[0] == "matter.changed"
    ]
    assert published == [matter["public_id"]]


def test_reorder_replay_is_idempotent(tmp_path):
    service = _service(tmp_path)
    matter = _matter(service)
    sid = _add(service, matter, name="a", key="s1")["stakeholder"]["id"]
    _reorder(service, matter, [{"id": sid, "sort_order": 7}], key="same")
    version = service.get_matter(matter["public_id"])["matter"]["version"]
    _reorder(service, matter, [{"id": sid, "sort_order": 9}], key="same")
    assert service.get_matter(matter["public_id"])["matter"]["version"] == version
    assert service.list_stakeholders(matter["public_id"])[0]["sort_order"] == 7


def test_reorder_cap_is_single_sourced():
    """REST schema 的上限 import 这个常量，不许两边各写一个数字。"""
    from src.api.schemas.matters import MatterStakeholderReorderRequest

    field = MatterStakeholderReorderRequest.model_fields["items"]
    caps = [m.max_length for m in field.metadata if hasattr(m, "max_length")]
    assert MATTER_STAKEHOLDER_REORDER_MAX in caps


# ============================================================
# 老库升级
# ============================================================

def _downgrade_stakeholder_table_to_v59(path) -> None:
    """把 matter_stakeholder 换回**没有 tier / sort_order** 的老形状。

    🔴 一律**重建**，不用 `DROP COLUMN`（本仓迁移测试的既有纪律）。
    只留 v59 时真实存在的列。
    """
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(
            """
            CREATE TABLE matter_stakeholder_v59 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
                person_key TEXT NOT NULL,
                display_name TEXT NULL,
                email_normalized TEXT NULL,
                organization TEXT NULL,
                role TEXT NULL,
                relationship TEXT NULL,
                is_waiting_on INTEGER NOT NULL DEFAULT 0 CHECK (is_waiting_on IN (0, 1)),
                last_contact_at INTEGER NULL,
                source_resource_id INTEGER NULL,
                contact_id INTEGER NULL,
                deleted_at INTEGER NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO matter_stakeholder_v59
              SELECT id, matter_id, person_key, display_name, email_normalized, organization,
                     role, relationship, is_waiting_on, last_contact_at, source_resource_id,
                     contact_id, deleted_at, created_at, updated_at
              FROM matter_stakeholder;
            DROP TABLE matter_stakeholder;
            ALTER TABLE matter_stakeholder_v59 RENAME TO matter_stakeholder;
            UPDATE sync_state SET value='59' WHERE key='db_version';
            """
        )
        conn.commit()
    finally:
        conn.close()


def test_migration_adds_columns_and_backfills(tmp_path):
    """老库（无这两列）升到 v60：加列 + 按 id 序回填 + 顺序不变。

    ⚠️ 顺序不变**不是**回填的功劳 —— 新读侧在 sort_order 全 0 时由 id 兜底接管，
    与老读侧 `ORDER BY id` 恰好一致（`test_all_zero_sort_order_still_orders_by_id`
    直接钉这条）。回填的价值是给第一次拖拽一个有意义的基线。
    """
    path = tmp_path / "old.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)
    matter = _matter(service)
    for i, name in enumerate(("first", "second", "third")):
        _add(service, matter, name=name, key=f"s{i}")

    _downgrade_stakeholder_table_to_v59(path)
    # 老形状确认：两列真的不在
    conn = sqlite3.connect(str(path))
    cols = {row[1] for row in conn.execute("PRAGMA table_info(matter_stakeholder)")}
    conn.close()
    assert "tier" not in cols and "sort_order" not in cols

    SyncStore(str(path))  # 重新打开 → 跑 v60 迁移

    rows = MatterService(
        MatterRepository(str(path)), clock_ms=lambda: NOW
    ).list_stakeholders(matter["public_id"])
    assert [r["display_name"] for r in rows] == ["first", "second", "third"]
    assert [r["sort_order"] for r in rows] == [0, 1, 2]
    assert {r["tier"] for r in rows} == {"normal"}


def test_migration_is_idempotent(tmp_path):
    """重入不重复回填、不报错（迁移块的 PRAGMA 探列守着）。"""
    path = tmp_path / "twice.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)
    matter = _matter(service)
    sid = _add(service, matter, name="a", key="s1")["stakeholder"]["id"]
    _reorder(service, matter, [{"id": sid, "sort_order": 42}])

    _downgrade_stakeholder_table_to_v59(path)
    SyncStore(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("UPDATE sync_state SET value='59' WHERE key='db_version'")
    conn.commit()
    conn.close()
    SyncStore(str(path))  # 第二遍：列已存在 → 跳过 ALTER 与回填

    rows = MatterService(
        MatterRepository(str(path)), clock_ms=lambda: NOW
    ).list_stakeholders(matter["public_id"])
    assert len(rows) == 1


def test_all_zero_sort_order_still_orders_by_id(tmp_path):
    """🔴 钉死回填**不是**顺序正确性的必要条件。

    写这条是因为最初的迁移注释断言「全填 0 会让次级排序接管、老库升级后顺序当场乱掉」
    —— 那是错的：`ORDER BY (tier='core') DESC, sort_order, id` 在 sort_order 相等时
    正是由 id 兜底。留着这条测试，免得将来有人为了「修一个不存在的问题」去动排序表达式。
    """
    path = tmp_path / "zeros.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)
    matter = _matter(service)
    for i, name in enumerate(("first", "second", "third")):
        _add(service, matter, name=name, key=f"s{i}")
    conn = sqlite3.connect(str(path))
    conn.execute("UPDATE matter_stakeholder SET sort_order = 0")
    conn.commit()
    conn.close()
    rows = MatterService(
        MatterRepository(str(path)), clock_ms=lambda: NOW
    ).list_stakeholders(matter["public_id"])
    assert [r["display_name"] for r in rows] == ["first", "second", "third"]
