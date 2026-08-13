"""v54 —— 通讯录三表 + matter_contact → contact 迁移 + stakeholder FK rebuild (task 08-13 WP1)。

`test_matter_v52_migration.py` 的姊妹篇, 盯 PRD §3.3 动作序的三形态:
① 新库满梯子 (旧形状建表 → v52 seed → v54 换形) 收敛到最终形态;
② v53 老库升级: matter_contact 迁 contact **id 保持** + 每行生成
   contact_email(is_primary=1) + stakeholder rebuild (FK 改指 contact,
   🔴 老库 contact_id 在**末尾** (v52 ALTER 追加) —— 显式列名 INSERT 的正确性
   靠逐字段断言钉住, `SELECT *` 会错位) + 4 个索引全在 + 定向
   foreign_key_check 干净 + matter_contact 已 DROP + 入向 FK (matter_item.
   waiting_on_stakeholder_id) 无恙;
③ 重入幂等 (version 拨回 53 重跑不重复、不炸)。
附: 失败不落 version (占掉 contact 索引名 → 迁移必须 raise, 版本停 53)。

🔴 降级模拟不用 DROP COLUMN (仓内教训「迁移测试禁 DROP COLUMN 一律重建」)。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    MATTER_TABLE_DDLS,
    SyncStore,
    SyncStoreMigrationError,
)

STAKEHOLDER_INDEXES = {
    "uq_matter_stakeholder_person",
    "idx_matter_stakeholder_email",
    "idx_matter_stakeholder_waiting",
    "idx_matter_stakeholder_contact",
}

# 🎨 设计增补列 (PRD §3.2, 随 v54 一次建齐, 不留二次迁移)
CONTACT_DESIGN_COLUMNS = {
    "role_title", "function", "seniority", "manager_contact_id", "manager_src",
}

_V51_STAKEHOLDER_DDL = """CREATE TABLE matter_stakeholder_old (
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
    source_resource_id INTEGER NULL REFERENCES resource(id) ON DELETE SET NULL,
    deleted_at INTEGER NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)"""


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _table_names(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }


def _stakeholder_index_names(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='matter_stakeholder' AND name NOT LIKE 'sqlite_%'"
            )
        }


def _stakeholder_fk_targets(path) -> set[tuple[str, str]]:
    with sqlite3.connect(path) as conn:
        return {
            (row[2], row[3])
            for row in conn.execute("PRAGMA foreign_key_list(matter_stakeholder)")
        }


def _downgrade_to_v53(path) -> None:
    """把库退回 v53 形状: matter_contact 复活 (旧 DDL 从冻结的 MATTER_TABLE_DDLS
    取) + matter_stakeholder 重建成「v51 列集 + 末尾 ALTER 出来的 contact_id」——
    这正是 v52 升级路径在真实老库上留下的列序 (contact_id 在最后), 用来钉
    v54 rebuild 的显式列名 INSERT 不错位。通讯录三表删掉。"""
    matter_contact_ddl = next(
        ddl for ddl in MATTER_TABLE_DDLS
        if ddl.startswith("CREATE TABLE IF NOT EXISTS matter_contact")
    )
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        for index in (
            "idx_matter_stakeholder_contact", "uq_matter_stakeholder_person",
            "idx_matter_stakeholder_email", "idx_matter_stakeholder_waiting",
        ):
            conn.execute(f"DROP INDEX IF EXISTS {index}")
        conn.execute("DROP TABLE IF EXISTS contact_email_link")
        conn.execute("DROP TABLE IF EXISTS contact_email")
        conn.execute("DROP TABLE IF EXISTS contact")
        conn.execute("DROP TABLE IF EXISTS matter_contact")
        conn.execute(matter_contact_ddl)
        conn.execute(_V51_STAKEHOLDER_DDL)
        conn.execute("DROP TABLE matter_stakeholder")
        conn.execute("ALTER TABLE matter_stakeholder_old RENAME TO matter_stakeholder")
        # v52 真实升级路径: contact_id 经 ALTER 追加, 落在列序**末尾**
        conn.execute(
            "ALTER TABLE matter_stakeholder ADD COLUMN contact_id INTEGER "
            "NULL REFERENCES matter_contact(id) ON DELETE SET NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX uq_matter_stakeholder_person "
            "ON matter_stakeholder(matter_id, person_key) WHERE deleted_at IS NULL"
        )
        conn.execute(
            "CREATE INDEX idx_matter_stakeholder_email "
            "ON matter_stakeholder(email_normalized) "
            "WHERE email_normalized IS NOT NULL AND deleted_at IS NULL"
        )
        conn.execute(
            "CREATE INDEX idx_matter_stakeholder_waiting "
            "ON matter_stakeholder(matter_id, is_waiting_on) WHERE deleted_at IS NULL"
        )
        conn.execute(
            "CREATE INDEX idx_matter_stakeholder_contact "
            "ON matter_stakeholder(contact_id) WHERE contact_id IS NOT NULL"
        )
        conn.execute("UPDATE sync_state SET value='53' WHERE key='db_version'")
        conn.commit()


def _seed_v53_data(path) -> None:
    """两个事项 + matter_contact 两行 (id 7/9, 故意非连续 —— 钉「id 保持」) +
    三行干系人 (两行挂 contact、一行无 email) + 一条 waiting 指针 (入向 FK)。"""
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        for index in (1, 2):
            conn.execute(
                "INSERT INTO matter(id, public_id, title, created_at, updated_at) "
                "VALUES (?, ?, ?, 1, 1)",
                (index, f"MAT-{index:04d}", f"Matter {index}"),
            )
        conn.execute(
            "INSERT INTO matter_contact (id, email_normalized, display_name, "
            "organization, created_at, updated_at) VALUES "
            "(7, 'alice@x.com', 'Alice', 'ACME', 10, 20), "
            "(9, 'bob@y.com', 'Bob', NULL, 11, 21)"
        )
        conn.execute(
            "INSERT INTO matter_stakeholder (id, matter_id, person_key, "
            "display_name, email_normalized, organization, role, is_waiting_on, "
            "created_at, updated_at, contact_id) VALUES "
            "(1, 1, 'pk-a', 'Alice', 'alice@x.com', 'ACME', '决策人', 1, 1, 2, 7), "
            "(2, 2, 'pk-b', 'Bob', 'bob@y.com', NULL, NULL, 0, 1, 2, 9), "
            "(3, 1, 'pk-ghost', 'Ghost', NULL, NULL, NULL, 0, 1, 2, NULL)"
        )
        conn.execute(
            "INSERT INTO matter_item (matter_id, kind, title, "
            "waiting_on_stakeholder_id, created_by_kind, created_at, updated_at) "
            "VALUES (1, 'action', '等 Alice 回复', 1, 'user', 1, 1)"
        )
        conn.commit()


def test_v54_fresh_db_final_shape(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    tables = _table_names(path)
    assert {"contact", "contact_email", "contact_email_link"} <= tables
    assert "matter_contact" not in tables
    assert CONTACT_DESIGN_COLUMNS <= _columns(path, "contact")
    assert "kind_locked_at" in _columns(path, "contact")
    assert "former_at" in _columns(path, "contact_email")
    assert ("contact", "contact_id") in _stakeholder_fk_targets(path)
    assert STAKEHOLDER_INDEXES <= _stakeholder_index_names(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA foreign_key_check(matter_stakeholder)").fetchall() == []
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v54_upgrade_migrates_contacts_and_rebuilds_stakeholder(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v53(path)
    _seed_v53_data(path)

    SyncStore(str(path))

    tables = _table_names(path)
    assert "matter_contact" not in tables
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        contacts = {
            int(row["id"]): dict(row)
            for row in conn.execute("SELECT * FROM contact")
        }
        # id 保持 (7/9 非连续也原样), 身份字段带过来
        assert set(contacts) == {7, 9}
        assert contacts[7]["display_name"] == "Alice"
        assert contacts[7]["organization"] == "ACME"
        assert contacts[9]["display_name"] == "Bob"
        # 聚合缓存列迁移期恒 0 (由 L1 backfill 校准)
        assert contacts[7]["mail_count"] == 0
        assert contacts[7]["sent_to_count"] == 0
        # 每行生成主邮箱锚点
        anchors = {
            row["email_normalized"]: dict(row)
            for row in conn.execute("SELECT * FROM contact_email")
        }
        assert set(anchors) == {"alice@x.com", "bob@y.com"}
        assert anchors["alice@x.com"]["contact_id"] == 7
        assert anchors["alice@x.com"]["is_primary"] == 1
        assert anchors["bob@y.com"]["contact_id"] == 9

        # stakeholder rebuild: 引用值不变 + 逐字段不错位 (老库 contact_id 在末尾,
        # SELECT * 复制会把它塞进中间列 —— 这里逐字段钉住显式列名 INSERT)
        stakeholders = {
            row["person_key"]: dict(row)
            for row in conn.execute("SELECT * FROM matter_stakeholder")
        }
        assert stakeholders["pk-a"]["contact_id"] == 7
        assert stakeholders["pk-a"]["display_name"] == "Alice"
        assert stakeholders["pk-a"]["email_normalized"] == "alice@x.com"
        assert stakeholders["pk-a"]["organization"] == "ACME"
        assert stakeholders["pk-a"]["role"] == "决策人"
        assert stakeholders["pk-a"]["is_waiting_on"] == 1
        assert stakeholders["pk-b"]["contact_id"] == 9
        assert stakeholders["pk-ghost"]["contact_id"] is None
        # 入向 FK: matter_item.waiting_on_stakeholder_id 无恙
        assert conn.execute(
            "SELECT waiting_on_stakeholder_id FROM matter_item"
        ).fetchone()[0] == 1
        # 定向 foreign_key_check 干净
        assert conn.execute("PRAGMA foreign_key_check(matter_stakeholder)").fetchall() == []
        assert conn.execute("PRAGMA foreign_key_check(matter_item)").fetchall() == []

    assert ("contact", "contact_id") in _stakeholder_fk_targets(path)
    assert STAKEHOLDER_INDEXES <= _stakeholder_index_names(path)
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v54_migration_is_idempotent_on_reentry(tmp_path):
    """半程重入 (version 拨回 53 但表已是新形) 不重复迁移、不炸、不重复行。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    _downgrade_to_v53(path)
    _seed_v53_data(path)
    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        before_contacts = conn.execute(
            "SELECT id, display_name FROM contact ORDER BY id"
        ).fetchall()
        before_anchors = conn.execute(
            "SELECT contact_id, email_normalized, is_primary "
            "FROM contact_email ORDER BY id"
        ).fetchall()
        before_stakeholders = conn.execute(
            "SELECT id, person_key, contact_id FROM matter_stakeholder ORDER BY id"
        ).fetchall()
        conn.execute("UPDATE sync_state SET value='53' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT id, display_name FROM contact ORDER BY id"
        ).fetchall() == before_contacts
        assert conn.execute(
            "SELECT contact_id, email_normalized, is_primary "
            "FROM contact_email ORDER BY id"
        ).fetchall() == before_anchors
        assert conn.execute(
            "SELECT id, person_key, contact_id FROM matter_stakeholder ORDER BY id"
        ).fetchall() == before_stakeholders
    assert "matter_contact" not in _table_names(path)
    assert STAKEHOLDER_INDEXES <= _stakeholder_index_names(path)
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v54_failure_does_not_advance_version(tmp_path):
    """新表索引名被占 → 迁移必须 raise, version 停在 53 (失败绝不落 version)。"""
    path = tmp_path / "guard.db"
    SyncStore(str(path))
    _downgrade_to_v53(path)
    with sqlite3.connect(path) as conn:
        # 占掉 contact 索引名: CREATE INDEX IF NOT EXISTS 撞同名表必报错
        conn.execute("CREATE TABLE idx_link_email (x)")
        conn.commit()

    with pytest.raises(SyncStoreMigrationError):
        SyncStore(str(path))
    assert _version(path) == "53"
