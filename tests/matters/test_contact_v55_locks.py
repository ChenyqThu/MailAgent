"""v55 —— contact 字段级锁定列 identity_locks_json (task 08-13 WP2)。

盯四形态:
① v54 老库升级: 列补上 + seed 正确 ({"display_name": identity_locked_at}, 只补
   identity_locked_at 非 NULL 且 locks 为 NULL 的行);
② 重入幂等 (version 拨回 54 重跑, owner 已改过的锁映射不被 seed 覆盖);
③ fresh create 与迁移后 contact 列集等价;
④ v53 老库 (matter_contact 时代) 一路迁到 55 不炸 (复用 v54 测试的构造器)。

🔴 降级模拟不用 DROP COLUMN (仓内教训「迁移测试禁 DROP COLUMN 一律重建」):
v54 形状 = 从最新 CONTACT_TABLE_DDLS 逐行剔掉 identity_locks_json 那行重建。
"""

from __future__ import annotations

import json
import sqlite3

from src.mail.sync_store import CONTACT_TABLE_DDLS, SyncStore
from tests.matters.test_contact_v54_migration import (
    _downgrade_to_v53,
    _seed_v53_data,
)


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}

def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _downgrade_to_v54(path) -> None:
    """contact 重建成 v54 形状 (无 identity_locks_json 列), version 拨回 54。"""
    contact_ddl = next(
        ddl for ddl in CONTACT_TABLE_DDLS
        if ddl.strip().startswith("CREATE TABLE IF NOT EXISTS contact (")
        or "CREATE TABLE IF NOT EXISTS contact (" in ddl
    )
    v54_ddl = "\n".join(
        line for line in contact_ddl.splitlines()
        if "identity_locks_json" not in line
    ).replace(
        "CREATE TABLE IF NOT EXISTS contact (", "CREATE TABLE contact_v54_shape (", 1
    )
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        keep = [
            row[1] for row in conn.execute("PRAGMA table_info(contact)")
            if row[1] != "identity_locks_json"
        ]
        assert "identity_locks_json" not in keep
        collist = ", ".join(keep)
        conn.execute(v54_ddl)
        conn.execute(
            f"INSERT INTO contact_v54_shape ({collist}) SELECT {collist} FROM contact"
        )
        conn.execute("DROP TABLE contact")
        conn.execute("ALTER TABLE contact_v54_shape RENAME TO contact")
        conn.execute("UPDATE sync_state SET value='54' WHERE key='db_version'")
        conn.commit()


def _seed_v54_contacts(path) -> None:
    """两行: id=1 带老锁 (identity_locked_at=123), id=2 无锁。"""
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, identity_locked_at, "
            "created_at, updated_at) VALUES (1, 'Locked Lin', 123, 10, 20)"
        )
        conn.execute(
            "INSERT INTO contact (id, display_name, created_at, updated_at) "
            "VALUES (2, 'Free Fan', 10, 20)"
        )
        conn.commit()


def test_v55_upgrade_adds_column_and_seeds_display_name_lock(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v54(path)
    assert "identity_locks_json" not in _columns(path, "contact")
    _seed_v54_contacts(path)

    SyncStore(str(path))

    assert "identity_locks_json" in _columns(path, "contact")
    with sqlite3.connect(path) as conn:
        rows = dict(
            conn.execute("SELECT id, identity_locks_json FROM contact").fetchall()
        )
    # 老锁全部来自 matters 写穿改名 ⇒ 折成 display_name 字段锁
    assert json.loads(rows[1]) == {"display_name": 123}
    assert rows[2] is None
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v55_reentry_does_not_overwrite_owner_edits(tmp_path):
    """重入幂等: seed 只补 NULL 空位, owner 已改过的锁映射原样保留。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    _downgrade_to_v54(path)
    _seed_v54_contacts(path)
    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        # owner 改锁: display_name 解锁、organization 上锁 (聚合列同步)
        conn.execute(
            "UPDATE contact SET identity_locks_json='{\"organization\": 456}', "
            "identity_locked_at=456 WHERE id=1"
        )
        conn.execute("UPDATE sync_state SET value='54' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        rows = dict(
            conn.execute("SELECT id, identity_locks_json FROM contact").fetchall()
        )
    assert json.loads(rows[1]) == {"organization": 456}
    assert rows[2] is None
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v55_fresh_and_migrated_schema_equivalent(tmp_path):
    fresh = tmp_path / "fresh.db"
    SyncStore(str(fresh))
    migrated = tmp_path / "migrated.db"
    SyncStore(str(migrated))
    _downgrade_to_v54(migrated)
    SyncStore(str(migrated))
    assert _columns(fresh, "contact") == _columns(migrated, "contact")
    assert "identity_locks_json" in _columns(fresh, "contact")


def test_v53_ladder_all_the_way_to_v55(tmp_path):
    """matter_contact 时代老库一路 v53→54→55 不炸, 迁移行锁映射恒 NULL。"""
    path = tmp_path / "ladder.db"
    SyncStore(str(path))
    _downgrade_to_v53(path)
    _seed_v53_data(path)

    SyncStore(str(path))

    assert "identity_locks_json" in _columns(path, "contact")
    with sqlite3.connect(path) as conn:
        rows = dict(
            conn.execute("SELECT id, identity_locks_json FROM contact").fetchall()
        )
    assert set(rows) == {7, 9}
    assert rows[7] is None and rows[9] is None
    assert _version(path) == str(SyncStore.DB_VERSION)
