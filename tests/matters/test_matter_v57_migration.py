"""v57 —— 资料版本轨迹表 resource_version (task 08-12 批 M7)。

三条形态各一条测试 (批次验收标准点名):
① 全新建库直接到 v57 —— 表 + 索引 + sum_src 的 CHECK 都在;
② v56 老库升 v57 —— 表建出来, **存量 resource 行一个字节不动**, 且轨迹是空的
   (历史版本从来没被记录过, 靠 resource 现值伪造一条"历史"= 把"只检出过一次"
   谎报成"有过一版");
③ 幂等 —— version 拨回 56 重跑不炸、已有的轨迹行不被清掉也不重复。

🔴 降级模拟不用 DROP TABLE 之外的花招: v56 形状就是"没有这张表", 直接 DROP 掉即可
(表是 v57 新增的, 不像 v52/v56 那样要重建带列的老表)。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    RESOURCE_VERSION_INDEX_DDL,
    RESOURCE_VERSION_TABLE_DDL,
    SyncStore,
)

TRAIL_TABLE = "resource_version"
TRAIL_INDEX = RESOURCE_VERSION_INDEX_DDL.split(" INDEX IF NOT EXISTS ", 1)[1].split(" ", 1)[0]


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


def _seed_resource(path) -> int:
    """一条**已经检出过内容**的 url 资料 (带 revision / hash / 摘要)。"""
    with sqlite3.connect(path) as conn:
        cursor = conn.execute(
            "INSERT INTO resource (kind, provider, external_key, canonical_url, title, "
            'metadata_json, "sum", sum_src, sum_at, revision, content_hash, '
            "last_checked_at, created_at, updated_at) "
            "VALUES ('url', 'web', 'https://example.test/a', 'https://example.test/a', "
            "'Spec v1', '{}', '第一版说交付在 9 月。', 'agent', 1800000000000, "
            "'hash-v1', 'hash-v1', 1800000000000, 10, 20)"
        )
        conn.commit()
        return int(cursor.lastrowid)


def _downgrade_to_v56(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(f"DROP TABLE IF EXISTS {TRAIL_TABLE}")
        conn.execute("UPDATE sync_state SET value='56' WHERE key='db_version'")
        conn.commit()


def _insert_trail(path, resource_id: int, *, sum_src: str, revision: str = "hash-v0") -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO resource_version (resource_id, revision, content_hash, "
            'superseded_at, diff_text, "sum", sum_src, sum_at) '
            "VALUES (?, ?, ?, 1800000000000, NULL, '旧版摘要。', ?, 1700000000000)",
            (resource_id, revision, revision, sum_src),
        )
        conn.commit()


def test_v57_fresh_db_has_trail_table_index_and_check(tmp_path):
    """① 全新建库直接到 v57。"""
    path = tmp_path / "fresh.db"
    SyncStore(str(path))

    assert _has_table(path, TRAIL_TABLE)
    assert _index_count(path, TRAIL_INDEX) == 1
    assert _version(path) == str(SyncStore.DB_VERSION) == "57"

    resource_id = _seed_resource(path)
    # sum_src 值域与 resource 同一份 sql_check_clause（不手抄第二份词表）。
    _insert_trail(path, resource_id, sum_src="agent")
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _insert_trail(path, resource_id, sum_src="synthesized", revision="hash-bad")


def test_v57_upgrade_from_v56_keeps_resource_rows_and_starts_with_empty_trail(tmp_path):
    """② v56 老库升级：表建出来、存量行原样、轨迹空。"""
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v56(path)
    resource_id = _seed_resource(path)
    assert not _has_table(path, TRAIL_TABLE)

    SyncStore(str(path))

    assert _has_table(path, TRAIL_TABLE)
    assert _index_count(path, TRAIL_INDEX) == 1
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute(
            "SELECT * FROM resource WHERE id=?", (resource_id,)
        ).fetchone())
        # 🔴 存量资料行一列不动 —— 迁移是纯 DDL，没有任何 DML。
        assert row["sum"] == "第一版说交付在 9 月。"
        assert (row["revision"], row["content_hash"]) == ("hash-v1", "hash-v1")
        assert row["last_checked_at"] == 1800000000000
        # 🔴 轨迹**必须**是空的：这份资料确实检出过一次，但那一次不是"历史版本"。
        # 拿 resource 现值回填一行 = 把「只检出过一版」谎报成「有过一版历史」。
        assert conn.execute(
            "SELECT COUNT(*) FROM resource_version"
        ).fetchone()[0] == 0
    # 升级后的 CHECK 与 fresh 库等价（同一份 DDL 常量执行的）。
    _insert_trail(path, resource_id, sum_src="mail")
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _insert_trail(path, resource_id, sum_src="synthesized", revision="hash-bad")


def test_v57_migration_is_idempotent_on_reentry(tmp_path):
    """③ 半程重入（version 拨回 56 但表已在）不炸、不清数据、不重复建索引。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    resource_id = _seed_resource(path)
    _insert_trail(path, resource_id, sum_src="agent")
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='56' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    assert _index_count(path, TRAIL_INDEX) == 1
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            'SELECT revision, "sum" FROM resource_version WHERE resource_id=?',
            (resource_id,),
        ).fetchall()
        assert rows == [("hash-v0", "旧版摘要。")]


def test_v57_trail_ddl_is_registered_in_the_matter_table_single_source():
    """DDL 单源：表 DDL 必须在 MATTER_TABLE_DDLS 里（老库经那几个重放块也能拿到），
    而索引**不能**在 MATTER_INDEX_DDLS 里（v52 教训：整组会在建表之前被重放）。"""
    from src.mail import sync_store

    assert RESOURCE_VERSION_TABLE_DDL in sync_store.MATTER_TABLE_DDLS
    assert RESOURCE_VERSION_INDEX_DDL not in sync_store.MATTER_INDEX_DDLS
    assert not any(
        f" ON {TRAIL_TABLE}(" in ddl for ddl in sync_store.MATTER_INDEX_DDLS
    )
    # 🔴 追加在末尾：v45 迁移块按下标取 MATTER_TABLE_DDLS[2]/[3]，插到中间会把那两处
    # 静默指到别的表上。
    assert sync_store.MATTER_TABLE_DDLS[-1] is RESOURCE_VERSION_TABLE_DDL
    assert "matter_item" in sync_store.MATTER_TABLE_DDLS[2]
    assert "matter_event" in sync_store.MATTER_TABLE_DDLS[3]
