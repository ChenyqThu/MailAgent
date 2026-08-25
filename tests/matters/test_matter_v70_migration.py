"""v70 —— curated 进展条目表 matter_progress (task 08-25-matter-progress-curated)。

四条形态各一条：
① 全新建库直接到 v70 —— 表 + 索引 + kind 的 CHECK 都在；
② v69 老库升 v70 —— 表建出来，存量事项一个字节不动，且**进展是空的**
   （历史 `matter_event` 是系统自己的操作记录，回填进 curated lane = 把它谎报成人写下来
   的脉络，正是本版本要终结的那件事）；
③ 幂等 —— version 拨回 69 重跑不炸、已有的进展行不被清掉也不重复建索引；
④ DDL 单源纪律 —— 表与索引都**不进** MATTER_TABLE_DDLS / MATTER_INDEX_DDLS
   （那两组会被 v44..v50 各块对老库整组重放，且前者有下标依赖；v52 教训）。

🔴 降级模拟直接 DROP：v69 形状就是「没有这张表」。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    MATTER_PROGRESS_INDEX_DDLS,
    MATTER_PROGRESS_TABLE_DDLS,
    SyncStore,
)

PROGRESS_TABLE = "matter_progress"
PROGRESS_INDEX = MATTER_PROGRESS_INDEX_DDLS[0].split(
    " INDEX IF NOT EXISTS ", 1
)[1].split(" ", 1)[0]


def _has_table(path, name: str) -> bool:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone() is not None


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


def _seed_matter(path) -> int:
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO matter_seq (created_at) VALUES (1)")
        cursor = conn.execute(
            "INSERT INTO matter (public_id, title, background, goal, created_at, updated_at) "
            "VALUES ('MAT-0001', '存量事项', '老的背景', '老的目标', 10, 20)"
        )
        matter_id = int(cursor.lastrowid)
        # 一条历史操作事件 —— ② 要断言它**不会**被回填成进展。
        conn.execute(
            "INSERT INTO matter_event (matter_id, kind, happened_at, actor_kind, source, "
            "dedupe_key, payload_json, created_at) "
            "VALUES (?, 'matter_created', 1800000000000, 'user', 'desktop_ui', 'seed-1', "
            "'{}', 1800000000000)",
            (matter_id,),
        )
        conn.commit()
        return matter_id


def _insert_progress(path, matter_id: int, *, kind: str = "progress", key: str = "a") -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_progress (matter_id, kind, title, body, happened_at, "
            "actor_kind, source, refs_json, created_at, updated_at) "
            "VALUES (?, ?, ?, NULL, 1800000000000, 'user', 'desktop_ui', '[]', 1, 2)",
            (matter_id, kind, f"Simon 回邮确认 Q4 预算 {key}"),
        )
        conn.commit()


def _downgrade_to_v69(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(f"DROP TABLE IF EXISTS {PROGRESS_TABLE}")
        conn.execute("UPDATE sync_state SET value='69' WHERE key='db_version'")
        conn.commit()


def test_v70_fresh_db_has_progress_table_index_and_check(tmp_path):
    """① 全新建库直接到 v70。"""
    path = tmp_path / "fresh.db"
    SyncStore(str(path))

    assert _has_table(path, PROGRESS_TABLE)
    assert _index_count(path, PROGRESS_INDEX) == 1
    assert _version(path) == str(SyncStore.DB_VERSION)

    matter_id = _seed_matter(path)
    # kind 值域与 models.MatterProgressKind 同一份 sql_check_clause（不手抄第二份词表）。
    _insert_progress(path, matter_id, kind="milestone")
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _insert_progress(path, matter_id, kind="item_created", key="b")
    # 主句非空同样是硬约束 —— 时间轴上一个读不懂的点比没有更糟。
    with sqlite3.connect(path) as conn:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            conn.execute(
                "INSERT INTO matter_progress (matter_id, kind, title, happened_at, "
                "actor_kind, source, created_at, updated_at) "
                "VALUES (?, 'goal', '   ', 1800000000000, 'user', 'desktop_ui', 1, 2)",
                (matter_id,),
            )


def test_v70_progress_rows_go_away_with_the_matter(tmp_path):
    """FK 是 ON DELETE CASCADE（与 matter_event 同语义）—— 事项被永久删除时进展一起没。"""
    path = tmp_path / "cascade.db"
    SyncStore(str(path))
    matter_id = _seed_matter(path)
    _insert_progress(path, matter_id)

    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM matter WHERE id=?", (matter_id,))
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM matter_progress").fetchone()[0] == 0


def test_v70_upgrade_from_v69_keeps_matters_and_starts_with_empty_progress(tmp_path):
    """② v69 老库升级：表建出来、存量行原样、进展空。"""
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v69(path)
    matter_id = _seed_matter(path)
    assert not _has_table(path, PROGRESS_TABLE)

    SyncStore(str(path))

    assert _has_table(path, PROGRESS_TABLE)
    assert _index_count(path, PROGRESS_INDEX) == 1
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute(
            "SELECT * FROM matter WHERE id=?", (matter_id,)
        ).fetchone())
        assert (row["background"], row["goal"]) == ("老的背景", "老的目标")
        # 🔴 历史事件还在，但**一条都没被搬进进展**：迁移是纯 DDL，没有任何 DML。
        assert conn.execute("SELECT COUNT(*) FROM matter_event").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM matter_progress").fetchone()[0] == 0


def test_v70_migration_is_idempotent_on_reentry(tmp_path):
    """③ 半程重入（version 拨回 69 但表已在）不炸、不清数据、不重复建索引。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    matter_id = _seed_matter(path)
    _insert_progress(path, matter_id)
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='69' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    assert _index_count(path, PROGRESS_INDEX) == 1
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT title FROM matter_progress WHERE matter_id=?", (matter_id,)
        ).fetchall() == [("Simon 回邮确认 Q4 预算 a",)]


def test_v70_ddl_stays_out_of_the_replayed_matter_groups():
    """🔴 v52 教训：表与索引都不许混进会被老迁移块整组重放的两组常量里。"""
    from src.mail import sync_store

    for ddl in MATTER_PROGRESS_TABLE_DDLS:
        assert ddl not in sync_store.MATTER_TABLE_DDLS
    for ddl in MATTER_PROGRESS_INDEX_DDLS:
        assert ddl not in sync_store.MATTER_INDEX_DDLS
    assert not any(
        PROGRESS_TABLE in ddl for ddl in sync_store.MATTER_TABLE_DDLS
    )
    assert not any(
        f" ON {PROGRESS_TABLE}(" in ddl for ddl in sync_store.MATTER_INDEX_DDLS
    )
    # 前端门控是手抄的 Python 常量，漏改会让打包 app 首启卡在 waitReady 上。
    # （跨文件闸另有 `frontend/tests/main/db_version_consistency.test.ts`，这里只钉
    # 「本批真的 bump 了」——不 bump 的话老库根本不会执行 v70 块。）
    assert SyncStore.DB_VERSION >= 70
