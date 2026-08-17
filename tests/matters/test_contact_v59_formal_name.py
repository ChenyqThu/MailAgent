"""v59 —— contact.name_en → contact.formal_name 正名 (task 08-14 WP-6 A)。

盯五形态:
① v58 老库升级: 列改名 + 值原样带过来;
② `identity_locks_json` 的**键**跟着改 —— 这一段少了就是**静默解锁**
   (`parse_identity_locks` 对词表外的键是丢弃, 不是报错), owner 锁住的正式名
   会无声地重新被自动提取覆盖;
③ 重入幂等 (version 拨回 58 重跑, 列/锁都不再动, 也不炸);
④ fresh create 与迁移后 contact **列集**等价, 且 v59 **不引入新的列序偏移**
   (RENAME COLUMN 原地改名, 不像 ALTER ADD 会把列追加到末尾 —— 真实老库的列序
   与 fresh 本来就因 v55 的 ALTER 有偏移, 那是既有事实, 不是本迁移的);
⑤ v53 老库 (matter_contact 时代, 三表全无) 一路迁到 v59: v54 块按最新 DDL 直接
   建成 formal_name, v59 块自然跳过。

🔴 降级模拟用 RENAME COLUMN 的**逆操作** (不是 DROP + 重建): 它是老形状的精确
还原, 且不受仓内「迁移测试禁 DROP COLUMN」那条约束 —— 那条针对的是丢列。
"""

from __future__ import annotations

import json
import sqlite3

from src.mail.sync_store import SyncStore
from tests.matters.test_contact_v54_migration import (
    _downgrade_to_v53,
    _seed_v53_data,
)


def _columns(path, table: str) -> list[str]:
    """按 PRAGMA 顺序返回 —— 列序也是比对项 (见 ④)。"""
    with sqlite3.connect(path) as conn:
        return [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _downgrade_to_v58(path) -> None:
    """contact 退回 v58 形状 (formal_name → name_en) + 锁键改回, version 拨回 58。"""
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE contact RENAME COLUMN formal_name TO name_en")
        conn.execute(
            "UPDATE contact SET identity_locks_json = json_remove("
            "  json_set(identity_locks_json, '$.name_en',"
            "    json_extract(identity_locks_json, '$.formal_name')),"
            "  '$.formal_name') "
            "WHERE identity_locks_json IS NOT NULL "
            "  AND json_extract(identity_locks_json, '$.formal_name') IS NOT NULL"
        )
        conn.execute("UPDATE sync_state SET value='58' WHERE key='db_version'")
        conn.commit()


def _seed_v58_contacts(path) -> None:
    """三行: id=1 有正式名且锁着它; id=2 有正式名无锁; id=3 只锁了别的字段。"""
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, name_en, identity_locks_json, "
            "identity_locked_at, created_at, updated_at) "
            "VALUES (1, '张工', '张三', '{\"name_en\": 123}', 123, 10, 20)"
        )
        conn.execute(
            "INSERT INTO contact (id, display_name, name_en, created_at, updated_at) "
            "VALUES (2, 'Alice', 'Alice Zhang', 10, 20)"
        )
        conn.execute(
            "INSERT INTO contact (id, display_name, identity_locks_json, "
            "identity_locked_at, created_at, updated_at) "
            "VALUES (3, 'Bob', '{\"organization\": 456}', 456, 10, 20)"
        )
        conn.commit()


def test_v59_upgrade_renames_column_and_keeps_values(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v58(path)
    assert "name_en" in _columns(path, "contact")
    assert "formal_name" not in _columns(path, "contact")
    _seed_v58_contacts(path)

    SyncStore(str(path))

    cols = _columns(path, "contact")
    assert "formal_name" in cols and "name_en" not in cols
    with sqlite3.connect(path) as conn:
        rows = dict(conn.execute("SELECT id, formal_name FROM contact").fetchall())
    assert rows == {1: "张三", 2: "Alice Zhang", 3: None}
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v59_upgrade_rekeys_the_field_lock(tmp_path):
    """🔴 少了这段 = 静默解锁: 锁映射的键是字段名, 列改名不会自动改 JSON 键, 而
    `parse_identity_locks` 对词表外的键**丢弃不报错** ⇒ owner 锁住的正式名下一轮
    扫描就可能被自动提取覆盖, 全程零日志。"""
    path = tmp_path / "locks.db"
    SyncStore(str(path))
    _downgrade_to_v58(path)
    _seed_v58_contacts(path)

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        rows = dict(
            conn.execute(
                "SELECT id, identity_locks_json FROM contact"
            ).fetchall()
        )
    assert json.loads(rows[1]) == {"formal_name": 123}
    assert rows[2] is None
    # 只锁了别的字段的行原样不动 (WHERE 挑的是真带老键的行)
    assert json.loads(rows[3]) == {"organization": 456}

    # 锁映射经得起域层解析 (词表已换成 formal_name)
    from src.contacts.service import parse_identity_locks

    assert parse_identity_locks(rows[1]) == {"formal_name": 123}


def test_v59_reentry_is_idempotent(tmp_path):
    """version 拨回 58 但 schema 已是新形状 (半程重入形态): 不炸, 也不重复改键。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    _downgrade_to_v58(path)
    _seed_v58_contacts(path)
    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='58' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    assert "formal_name" in _columns(path, "contact")
    with sqlite3.connect(path) as conn:
        rows = dict(
            conn.execute(
                "SELECT id, identity_locks_json FROM contact"
            ).fetchall()
        )
    assert json.loads(rows[1]) == {"formal_name": 123}
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v59_fresh_and_migrated_schema_equivalent(tmp_path):
    fresh = tmp_path / "fresh.db"
    SyncStore(str(fresh))
    migrated = tmp_path / "migrated.db"
    SyncStore(str(migrated))
    _downgrade_to_v58(migrated)
    before = _columns(migrated, "contact")
    SyncStore(str(migrated))
    after = _columns(migrated, "contact")

    assert set(fresh_cols := _columns(fresh, "contact")) == set(after)
    assert "formal_name" in fresh_cols
    # 🔴 钉的是「v59 不引入**新的**列序偏移」: RENAME COLUMN 原地改名, formal_name
    # 落在 name_en 原来的位置 (若改成 ADD+UPDATE+DROP 那套, 它会跑到列尾)。
    # 不与 fresh 比列序 —— 真实老库的列序早因 v55 的 ALTER 与 fresh 有偏移
    # (活库实测 identity_locks_json 在尾), 那是既有事实, 不该记到本迁移头上。
    assert after == [
        "formal_name" if col == "name_en" else col for col in before
    ]


def test_v53_ladder_all_the_way_to_v59(tmp_path):
    """matter_contact 时代老库一路 v53→…→59: v54 块按最新 DDL 直接建成
    formal_name, v59 块的探列条件不成立 ⇒ 自然跳过, 不炸。"""
    path = tmp_path / "ladder.db"
    SyncStore(str(path))
    _downgrade_to_v53(path)
    _seed_v53_data(path)

    SyncStore(str(path))

    cols = _columns(path, "contact")
    assert "formal_name" in cols and "name_en" not in cols
    assert _version(path) == str(SyncStore.DB_VERSION)
