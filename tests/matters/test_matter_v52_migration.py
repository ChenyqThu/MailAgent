"""v52 —— 全局干系人库（matter_contact + matter_stakeholder.contact_id + seed 回填）。

盯四件事：① 新库形状齐 ② v51 老库升级：email 归一（trim+lower / 空串→NULL）、按
email 聚合去重入库（display_name/organization 取最近更新的非空行）、contact_id 回写
③ 无 email 的行**不入库**（contact_id 恒 NULL）④ 幂等（重跑 / 半程重入不重复）。

🔴 降级模拟不用 ``DROP COLUMN``（contact_id 带出向 FK，SQLite 直接拒；仓内既有教训
「迁移测试禁 DROP COLUMN 一律重建」）—— 重建 v51 形状的表再灌回数据。

v54 (task 08-13) 起 ``matter_contact`` 在梯子末端被迁进通讯录三表后 DROP —— 本文件
的断言改读**最终形态**（``contact`` + ``contact_email``，id 与 v52 seed 保持一致），
v52 块的归一/聚合/回写语义仍被完整穿越（v51 老库升级必经 v52 块）。v54 自身的三形态
测试在姊妹篇 ``test_contact_v54_migration.py``。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore, SyncStoreMigrationError

CONTACT_COLUMNS = {
    "id", "display_name", "organization", "created_at", "updated_at",
}

_V51_STAKEHOLDER_DDL = """CREATE TABLE matter_stakeholder_v51 (
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


def _downgrade_to_v51(path) -> None:
    """把库退回 v51 形状：干系人表重建成无 contact_id 的旧列集 + 删全局库
    （v54 后「全局库」= 通讯录三表，一并删掉才是真 v51 形状）。"""
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("DROP INDEX IF EXISTS idx_matter_stakeholder_contact")
        conn.execute(_V51_STAKEHOLDER_DDL)
        conn.execute(
            "INSERT INTO matter_stakeholder_v51 "
            "SELECT id, matter_id, person_key, display_name, email_normalized, "
            "organization, role, relationship, is_waiting_on, last_contact_at, "
            "source_resource_id, deleted_at, created_at, updated_at "
            "FROM matter_stakeholder"
        )
        conn.execute("DROP TABLE matter_stakeholder")
        conn.execute(
            "ALTER TABLE matter_stakeholder_v51 RENAME TO matter_stakeholder"
        )
        # v51 时代的三个干系人索引（重建表把它们连带丢了；还原到位才算 v51 形状）
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
        conn.execute("DROP TABLE IF EXISTS matter_contact")
        conn.execute("DROP TABLE IF EXISTS contact_email_link")
        conn.execute("DROP TABLE IF EXISTS contact_email")
        conn.execute("DROP TABLE IF EXISTS contact")
        conn.execute("UPDATE sync_state SET value='51' WHERE key='db_version'")
        conn.commit()


def _seed_matters_and_stakeholders(path) -> None:
    """两个事项 + 五行存量干系人：大小写/前后空格脏 email、跨事项重复、
    空串 email、无 email。"""
    rows = (
        # (matter_id, person_key, display_name, email, organization, updated_at)
        (1, "pk-a1", "Alice A", " Alice@X.com ", None, 10),
        (2, "pk-a2", "", "alice@x.com", "ACME", 20),
        (1, "pk-b", "Bob", "bob@y.com", None, 5),
        (2, "pk-ghost", "Ghost NoMail", None, None, 5),
        (1, "pk-empty", "Empty Mail", "", None, 5),
    )
    with sqlite3.connect(path) as conn:
        for index in (1, 2):
            conn.execute(
                "INSERT INTO matter(id, public_id, title, created_at, updated_at) "
                "VALUES (?, ?, ?, 1, 1)",
                (index, f"MAT-{index:04d}", f"Matter {index}"),
            )
        for matter_id, person_key, name, email, org, updated_at in rows:
            conn.execute(
                "INSERT INTO matter_stakeholder "
                "(matter_id, person_key, display_name, email_normalized, "
                "organization, created_at, updated_at) VALUES (?,?,?,?,?,1,?)",
                (matter_id, person_key, name, email, org, updated_at),
            )
        conn.commit()


def test_v52_fresh_db_has_contact_table_column_and_index(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    # v54 后梯子末端的「全局库」是 contact（matter_contact 已迁移退役）
    assert CONTACT_COLUMNS <= _columns(path, "contact")
    assert "contact_id" in _columns(path, "matter_stakeholder")
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE name='idx_matter_stakeholder_contact'"
        ).fetchone()
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v52_upgrade_normalizes_emails_seeds_contacts_and_backfills(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _downgrade_to_v51(path)
    _seed_matters_and_stakeholders(path)

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        # v52 seed 的产物经 v54 迁进 contact（id 保持）+ contact_email 锚点
        contacts = {
            row["email_normalized"]: dict(row)
            for row in conn.execute(
                "SELECT c.*, ce.email_normalized FROM contact c "
                "JOIN contact_email ce ON ce.contact_id = c.id"
            )
        }
        # 按归一 email 去重：Alice 两行（大小写+空格脏）并成一条
        assert set(contacts) == {"alice@x.com", "bob@y.com"}
        # display_name 取最近更新的**非空**行：m2 行更新（20）但名字为空 → 用 m1 的
        assert contacts["alice@x.com"]["display_name"] == "Alice A"
        # organization 取最近更新的非空行：m2 的 ACME
        assert contacts["alice@x.com"]["organization"] == "ACME"

        stakeholders = {
            row["person_key"]: dict(row)
            for row in conn.execute("SELECT * FROM matter_stakeholder")
        }
        # email 归一写回本行
        assert stakeholders["pk-a1"]["email_normalized"] == "alice@x.com"
        # 空串 → NULL
        assert stakeholders["pk-empty"]["email_normalized"] is None
        # contact_id 回写；无 email 的行不入库（contact_id 恒 NULL）
        alice_id = contacts["alice@x.com"]["id"]
        assert stakeholders["pk-a1"]["contact_id"] == alice_id
        assert stakeholders["pk-a2"]["contact_id"] == alice_id
        assert stakeholders["pk-b"]["contact_id"] == contacts["bob@y.com"]["id"]
        assert stakeholders["pk-ghost"]["contact_id"] is None
        assert stakeholders["pk-empty"]["contact_id"] is None

    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v52_index_failure_is_not_swallowed_by_the_column_guard(tmp_path):
    """contact_id 已在 + 索引建不出来 ⇒ 迁移必须中断，不许悄悄把 version 推到 52。

    失败注入不用 mock：拿一张同名表占掉索引名，`CREATE INDEX IF NOT EXISTS` 就必然
    报「already another table or index with this name」，而 contact_id 列仍在 —— 正是
    列 guard 会判「已迁移」放过去的那个形状。少了索引 guard，索引就此永不重建。"""
    path = tmp_path / "guard.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP INDEX idx_matter_stakeholder_contact")
        conn.execute("CREATE TABLE idx_matter_stakeholder_contact (x)")
        conn.execute("UPDATE sync_state SET value='51' WHERE key='db_version'")
        conn.commit()

    with pytest.raises(SyncStoreMigrationError):
        SyncStore(str(path))
    assert _version(path) == "51"


def test_v52_migration_is_idempotent_on_reentry(tmp_path):
    """半程重入（version 被拨回 51 但表/列都在）不重复 seed、不改已回写的关联。"""
    path = tmp_path / "reentry.db"
    SyncStore(str(path))
    _downgrade_to_v51(path)
    _seed_matters_and_stakeholders(path)
    SyncStore(str(path))

    contact_sql = (
        "SELECT c.id, ce.email_normalized FROM contact c "
        "JOIN contact_email ce ON ce.contact_id = c.id ORDER BY c.id"
    )
    with sqlite3.connect(path) as conn:
        before = conn.execute(contact_sql).fetchall()
        conn.execute("UPDATE sync_state SET value='51' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        after = conn.execute(contact_sql).fetchall()
        assert after == before
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_stakeholder WHERE contact_id IS NULL "
            "AND email_normalized IS NOT NULL"
        ).fetchone()[0] == 0
    assert _version(path) == str(SyncStore.DB_VERSION)
