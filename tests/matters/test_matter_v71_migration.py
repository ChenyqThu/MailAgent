"""v71 —— 行动项执行契约 matter_item_dispatch (task 08-25-l4-batch3-item-execution-contract)。

四条形态各一条：
① 全新建库直接到 v71 —— 表 + 四个索引 + state/exec_profile 的 CHECK 都在，两处 additive
   列（matter_item.exec_profile / matter_update.item_dispatch_id）也在；
② v70 老库升 v71 —— 表建出来、两列 ALTER 上去，存量事项与存量条目一个字节不动，且
   **派发史是空的**（存量行动项从来没被派过，回填等于编造执行史）；
③ 幂等 —— version 拨回 70 重跑不炸、已有的派发行不被清掉也不重复建索引；
④ DDL 单源纪律 —— 表与索引都**不进** MATTER_TABLE_DDLS / MATTER_INDEX_DDLS
   （那两组会被 v44..v50 各块对老库整组重放，且前者有下标依赖；v52 教训）。

🔴 降级模拟：v70 形状 = 没有这张表、matter_item 没有 exec_profile。**不用 DROP COLUMN**
（SQLite 的 DROP COLUMN 对带 CHECK / 索引的表限制多，且迁移测试的既有纪律就是重建 ——
这里按 v70 的 canonical 形状重建 matter_item，连着把行搬回去）。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    MATTER_ITEM_DISPATCH_INDEX_DDLS,
    MATTER_ITEM_DISPATCH_TABLE_DDLS,
    MATTER_TABLE_DDLS,
    SyncStore,
)

DISPATCH_TABLE = "matter_item_dispatch"
DISPATCH_INDEXES = tuple(
    ddl.split(" INDEX IF NOT EXISTS ", 1)[1].split(" ", 1)[0]
    for ddl in MATTER_ITEM_DISPATCH_INDEX_DDLS
)


def _has_table(path, name: str) -> bool:
    with sqlite3.connect(path) as conn:
        return (
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            is not None
        )


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _index_count(path, name: str) -> int:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", (name,)
        ).fetchone()[0]


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _seed(path) -> tuple[int, int]:
    """一个存量事项 + 一条存量行动项（②要断言它们一个字节不动）。"""
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO matter_seq (created_at) VALUES (1)")
        matter_id = int(
            conn.execute(
                "INSERT INTO matter (public_id, title, background, goal, created_at, updated_at) "
                "VALUES ('MAT-0001', '存量事项', '老的背景', '老的目标', 10, 20)"
            ).lastrowid
        )
        item_id = int(
            conn.execute(
                "INSERT INTO matter_item (matter_id, kind, title, status, created_by_kind, "
                "created_at, updated_at) VALUES (?, 'action', '回签补充协议', 'open', 'user', 10, 20)",
                (matter_id,),
            ).lastrowid
        )
        conn.commit()
        return matter_id, item_id


def _insert_dispatch(path, matter_id: int, item_id: int, *, key: str | None = None) -> int:
    with sqlite3.connect(path) as conn:
        row_id = int(
            conn.execute(
                "INSERT INTO matter_item_dispatch (matter_id, item_id, state, executor_kind, "
                "executor_id, exec_profile, created_by_kind, dispatched_at, created_at, "
                "updated_at, idempotency_key) "
                "VALUES (?, ?, 'queued', 'agent', 'matter_followup', 'propose_only', 'user', "
                "1800000000000, 1, 2, ?)",
                (matter_id, item_id, key),
            ).lastrowid
        )
        conn.commit()
        return row_id


def _downgrade_to_v70(path) -> None:
    """回到 v70 形状：没有派发表、matter_item 没有 exec_profile、matter_update 没有回钩列。"""
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute(f"DROP TABLE IF EXISTS {DISPATCH_TABLE}")
        conn.execute("ALTER TABLE matter_item RENAME TO matter_item_v71_source")
        item_ddl = MATTER_TABLE_DDLS[2].replace(
            "        exec_profile TEXT NULL CHECK (exec_profile IS NULL OR exec_profile "
            "IN ('propose_only', 'edit_with_approval', 'autonomous')),\n",
            "",
        )
        assert "exec_profile" not in item_ddl, "v70 形状构造失败（canonical DDL 改写了？）"
        conn.execute(item_ddl)
        carried = ", ".join(
            row[1] for row in conn.execute("PRAGMA table_info(matter_item)")
        )
        conn.execute(
            f"INSERT INTO matter_item ({carried}) SELECT {carried} FROM matter_item_v71_source"
        )
        conn.execute("DROP TABLE matter_item_v71_source")
        conn.execute("UPDATE sync_state SET value='70' WHERE key='db_version'")
        conn.commit()


def test_v71_fresh_db_has_the_dispatch_table_indexes_and_checks(tmp_path):
    """① 全新建库直接到 v71。"""
    path = tmp_path / "fresh.db"
    SyncStore(str(path))

    assert _has_table(path, DISPATCH_TABLE)
    for index in DISPATCH_INDEXES:
        assert _index_count(path, index) == 1
    assert _index_count(path, "idx_matter_update_item_dispatch") == 1
    assert "exec_profile" in _columns(path, "matter_item")
    assert "item_dispatch_id" in _columns(path, "matter_update")
    assert _version(path) == str(SyncStore.DB_VERSION)

    matter_id, item_id = _seed(path)
    _insert_dispatch(path, matter_id, item_id)
    # state / exec_profile 的值域与 models 枚举同一份 sql_check_clause（不手抄第二份词表）。
    with sqlite3.connect(path) as conn:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            conn.execute(
                "INSERT INTO matter_item_dispatch (matter_id, item_id, state, executor_kind, "
                "executor_id, exec_profile, created_by_kind, dispatched_at, created_at, updated_at) "
                "VALUES (?, ?, 'paused', 'agent', 'x', 'propose_only', 'user', 1, 1, 1)",
                (matter_id, item_id),
            )
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            conn.execute(
                "UPDATE matter_item SET exec_profile='yolo' WHERE id=?", (item_id,)
            )


def test_v71_active_dispatch_is_unique_per_item_but_history_keeps_piling_up(tmp_path):
    """终态判据是 `ended_at`，不是 state —— 结束之后同一条行动项可以再派，历史逐行留下。"""
    path = tmp_path / "unique.db"
    SyncStore(str(path))
    matter_id, item_id = _seed(path)
    first = _insert_dispatch(path, matter_id, item_id)

    with sqlite3.connect(path) as conn:
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            conn.execute(
                "INSERT INTO matter_item_dispatch (matter_id, item_id, state, executor_kind, "
                "executor_id, exec_profile, created_by_kind, dispatched_at, created_at, updated_at) "
                "VALUES (?, ?, 'queued', 'agent', 'matter_followup', 'propose_only', 'user', 1, 1, 1)",
                (matter_id, item_id),
            )
        conn.execute(
            "UPDATE matter_item_dispatch SET state='canceled', ended_at=1 WHERE id=?",
            (first,),
        )
        conn.commit()

    second = _insert_dispatch(path, matter_id, item_id)
    assert second != first
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_item_dispatch WHERE item_id=?", (item_id,)
        ).fetchone()[0] == 2


def test_v71_upgrade_from_v70_adds_the_table_and_columns_without_touching_rows(tmp_path):
    """② v70 老库升级：表 + 两列上去、存量行原样、派发史空。"""
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v70(path)
    matter_id, item_id = _seed(path)
    assert not _has_table(path, DISPATCH_TABLE)
    assert "exec_profile" not in _columns(path, "matter_item")

    SyncStore(str(path))

    assert _has_table(path, DISPATCH_TABLE)
    for index in DISPATCH_INDEXES:
        assert _index_count(path, index) == 1
    assert "exec_profile" in _columns(path, "matter_item")
    assert "item_dispatch_id" in _columns(path, "matter_update")
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        item = dict(
            conn.execute("SELECT * FROM matter_item WHERE id=?", (item_id,)).fetchone()
        )
        assert (item["title"], item["status"]) == ("回签补充协议", "open")
        # 🔴 新列的缺省是 NULL = 「没选过」= 出厂档，不是把默认值物化进去。
        assert item["exec_profile"] is None
        # 🔴 存量行动项一条派发史都没有：迁移是纯 DDL，没有任何 DML。
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_item_dispatch"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM matter WHERE id=?", (matter_id,)
        ).fetchone()[0] == 1


def test_v71_migration_is_idempotent_on_reentry(tmp_path):
    """③ 半程重入（version 拨回 70 但表与列都已在）不炸、不清数据、不重复建索引。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    matter_id, item_id = _seed(path)
    _insert_dispatch(path, matter_id, item_id, key="idem-1")
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='70' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    for index in DISPATCH_INDEXES:
        assert _index_count(path, index) == 1
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT idempotency_key FROM matter_item_dispatch WHERE item_id=?", (item_id,)
        ).fetchall() == [("idem-1",)]


def test_a_v44_shaped_matter_item_still_survives_the_v45_rebuild(tmp_path):
    """🔴 本批把 exec_profile 加进了 matter_item 的 canonical DDL，而 v45 的 FK 重建会把
    canonical 形状的新表灌满旧表的行 —— 用 `SELECT *` 的话，**恰好停在 v44** 的老库
    （那张表没有这一列）会以「24 列表收到 23 个值」当场炸掉整条升级梯子。

    这里把库压成真正的 v44 形状（缺 FK ⇒ 触发重建，且缺 exec_profile ⇒ 列数不等），
    跑一遍完整梯子，断言它升到当前版本且一行不丢。
    """
    path = tmp_path / "v44.db"
    SyncStore(str(path))
    _, item_id = _seed(path)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute(f"DROP TABLE IF EXISTS {DISPATCH_TABLE}")
        conn.execute("ALTER TABLE matter_item RENAME TO matter_item_v44_source")
        item_ddl = (
            MATTER_TABLE_DDLS[2]
            .replace(
                "        exec_profile TEXT NULL CHECK (exec_profile IS NULL OR exec_profile "
                "IN ('propose_only', 'edit_with_approval', 'autonomous')),\n",
                "",
            )
            .replace(" REFERENCES matter_stakeholder(id) ON DELETE SET NULL", "")
            .replace(" REFERENCES resource(id) ON DELETE SET NULL", "")
        )
        assert "exec_profile" not in item_ddl
        conn.execute(item_ddl)
        carried = ", ".join(
            row[1] for row in conn.execute("PRAGMA table_info(matter_item)")
        )
        conn.execute(
            f"INSERT INTO matter_item ({carried}) SELECT {carried} FROM matter_item_v44_source"
        )
        conn.execute("DROP TABLE matter_item_v44_source")
        conn.execute("UPDATE sync_state SET value='44' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    assert _version(path) == str(SyncStore.DB_VERSION)
    assert "exec_profile" in _columns(path, "matter_item")
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT title, exec_profile FROM matter_item WHERE id=?", (item_id,)
        ).fetchone() == ("回签补充协议", None)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_v71_ddl_stays_out_of_the_replayed_matter_groups():
    """🔴 v52 教训：表与索引都不许混进会被老迁移块整组重放的两组常量里。"""
    from src.mail import sync_store

    for ddl in MATTER_ITEM_DISPATCH_TABLE_DDLS:
        assert ddl not in sync_store.MATTER_TABLE_DDLS
    for ddl in MATTER_ITEM_DISPATCH_INDEX_DDLS:
        assert ddl not in sync_store.MATTER_INDEX_DDLS
    # 判据是「那一组里没有**建**这张表的语句」——不能只查子串：matter_update 的 DDL 里
    # 有一段注释提到它（说明 item_dispatch_id 为什么不加 FK），那不是一个建表语句。
    assert not any(
        f"TABLE IF NOT EXISTS {DISPATCH_TABLE}" in ddl
        for ddl in sync_store.MATTER_TABLE_DDLS
    )
    assert not any(
        f" ON {DISPATCH_TABLE}(" in ddl for ddl in sync_store.MATTER_INDEX_DDLS
    )
    # 提案回钩的索引同理：`matter_update.item_dispatch_id` 要到 v71 的 ALTER 才存在，
    # 进了那组会把 v45..v70 老库的梯子当场炸掉（"no such column"）。
    assert (
        sync_store.MATTER_UPDATE_ITEM_DISPATCH_INDEX_DDL
        not in sync_store.MATTER_INDEX_DDLS
    )
    # 前端门控是手抄的 Python 常量，漏改会让打包 app 首启卡在 waitReady 上。
    assert SyncStore.DB_VERSION >= 71
