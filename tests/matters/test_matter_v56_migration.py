"""v56 —— resource 资料摘要三列 sum / sum_src / sum_at (task 08-12 批 M4)。

盯四形态:
① fresh create: 三列在场 + sum_src CHECK 生效 (值域单源 MatterResourceSummarySource);
② v55 老库升级: additive ALTER 补齐三列, 存量行 NULL 默认 (= 「还没有摘要」空态,
   有意不回填), resource 的 4 个既有索引不丢也不重复;
③ 升级后的 CHECK 与 fresh 库等价 (ALTER 带同一份 sql_check_clause, 不是手抄);
④ 重入幂等 (version 拨回 55 重跑不炸、不改已有数据)。

🔴 降级模拟不用 DROP COLUMN (仓内教训「迁移测试禁 DROP COLUMN 一律重建」):
v55 形状 = 从最新 MATTER_TABLE_DDLS 的 resource DDL 逐行剔掉三列重建 (与
test_contact_v55_locks 同一手法, 不手抄第二份旧 DDL)。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import MATTER_INDEX_DDLS, MATTER_TABLE_DDLS, SyncStore

SUMMARY_COLUMNS = ("sum", "sum_src", "sum_at")

#: resource 表自己的索引 (从单源 MATTER_INDEX_DDLS 过滤, 不手抄名字清单)。
_RESOURCE_INDEX_DDLS = tuple(
    ddl for ddl in MATTER_INDEX_DDLS if " ON resource(" in ddl
)


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _downgrade_to_v55(path) -> None:
    """resource 重建成 v55 形状 (无三列), 还原它的 4 个索引, version 拨回 55。"""
    resource_ddl = next(
        ddl for ddl in MATTER_TABLE_DDLS
        if "CREATE TABLE IF NOT EXISTS resource (" in ddl
    )
    v55_ddl = "\n".join(
        line for line in resource_ddl.splitlines()
        if not line.strip().startswith(("sum ", "sum_src ", "sum_at "))
    ).replace(
        "CREATE TABLE IF NOT EXISTS resource (", "CREATE TABLE resource_v55_shape (", 1
    )
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        keep = [
            row[1] for row in conn.execute("PRAGMA table_info(resource)")
            if row[1] not in SUMMARY_COLUMNS
        ]
        assert not set(SUMMARY_COLUMNS) & set(keep)
        collist = ", ".join(keep)
        conn.execute(v55_ddl)
        conn.execute(
            f"INSERT INTO resource_v55_shape ({collist}) SELECT {collist} FROM resource"
        )
        conn.execute("DROP TABLE resource")
        conn.execute("ALTER TABLE resource_v55_shape RENAME TO resource")
        for ddl in _RESOURCE_INDEX_DDLS:
            conn.execute(ddl)
        conn.execute("UPDATE sync_state SET value='55' WHERE key='db_version'")
        conn.commit()


def _seed_resource(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO resource (kind, provider, external_key, title, "
            "metadata_json, created_at, updated_at) "
            "VALUES ('email', 'mailagent', 'email:1', 'Legacy mail', '{}', 10, 20)"
        )
        conn.commit()


def _insert_with_sum_src(path, external_key: str, sum_src: str) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO resource (kind, provider, external_key, metadata_json, "
            '"sum", sum_src, sum_at, created_at, updated_at) '
            "VALUES ('doc', 'x', ?, '{}', 'A summary.', ?, 1800000000000, 1, 1)",
            (external_key, sum_src),
        )
        conn.commit()


def test_v56_fresh_db_has_summary_columns_and_check(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert set(SUMMARY_COLUMNS) <= _columns(path, "resource")
    assert _version(path) == str(SyncStore.DB_VERSION)
    # 值域 CHECK: mail/agent 放行, 野值当场拒 (单源 sql_check_clause, 见 DDL)。
    _insert_with_sum_src(path, "doc:ok", "mail")
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _insert_with_sum_src(path, "doc:bad", "synthesized")


def test_v56_upgrade_adds_null_columns_and_keeps_resource_indexes(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v55(path)
    _seed_resource(path)
    assert not set(SUMMARY_COLUMNS) & _columns(path, "resource")

    SyncStore(str(path))

    assert set(SUMMARY_COLUMNS) <= _columns(path, "resource")
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute(
            "SELECT * FROM resource WHERE external_key='email:1'"
        ).fetchone())
        # 存量行三列 NULL = 空态 (有意不回填), 其余列原样。
        assert (row["sum"], row["sum_src"], row["sum_at"]) == (None, None, None)
        assert row["title"] == "Legacy mail"
        # resource 的 4 个索引不丢也不重复 (名字从单源 DDL 抽, 不手抄)。
        for ddl in _RESOURCE_INDEX_DDLS:
            name = ddl.split(" INDEX IF NOT EXISTS ", 1)[1].split(" ", 1)[0]
            count = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
                (name,),
            ).fetchone()[0]
            assert count == 1, f"index {name} count={count}"
    assert _version(path) == str(SyncStore.DB_VERSION)
    # ALTER 带的 CHECK 与 fresh 库等价 (同一份 sql_check_clause)。
    _insert_with_sum_src(path, "doc:ok", "agent")
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        _insert_with_sum_src(path, "doc:bad", "synthesized")


def test_v56_migration_is_idempotent_on_reentry(tmp_path):
    """半程重入 (version 拨回 55 但三列都在) 不炸、不动已有数据。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    _downgrade_to_v55(path)
    _seed_resource(path)
    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        conn.execute(
            'UPDATE resource SET "sum"=\'Kept.\', sum_src=\'mail\', '
            "sum_at=1800000000000 WHERE external_key='email:1'"
        )
        conn.execute("UPDATE sync_state SET value='55' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        row = conn.execute(
            'SELECT "sum", sum_src, sum_at FROM resource '
            "WHERE external_key='email:1'"
        ).fetchone()
        assert row == ("Kept.", "mail", 1800000000000)
    assert _version(path) == str(SyncStore.DB_VERSION)
