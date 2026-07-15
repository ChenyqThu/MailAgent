"""SyncStore v36 migration tests — email_metadata 草稿线程 linkage 3 列 (compose Bug A)。

惯例同 v33: 不用 DROP COLUMN (CI sqlite 版本坑), 用 CREATE AS SELECT 重建旧表
模拟 v35 库, 再验 ALTER ADD COLUMN 幂等。
"""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore

DRAFT_COLS = ("draft_source_internal_id", "draft_in_reply_to", "draft_references")


def _fetchone(db_path: str, sql: str, params=()):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def _columns(db_path: str) -> set:
    conn = sqlite3.connect(db_path)
    try:
        return {
            row[1]
            for row in conn.execute("PRAGMA table_info(email_metadata)").fetchall()
        }
    finally:
        conn.close()


def test_fresh_db_has_draft_linkage_columns(tmp_path):
    db = str(tmp_path / "fresh.db")
    SyncStore(db)
    cols = _columns(db)
    for c in DRAFT_COLS:
        assert c in cols
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_v36_adds_columns_idempotently(tmp_path):
    """v35 旧库 (无 draft_* 列) → 补列; 重复 init 幂等; 版本推进到当前。"""
    db = str(tmp_path / "v36.db")
    SyncStore(db)
    conn = sqlite3.connect(db)
    try:
        old_columns = [
            row[1]
            for row in conn.execute("PRAGMA table_info(email_metadata)").fetchall()
            if row[1] not in DRAFT_COLS
        ]
        column_list = ", ".join(old_columns)
        conn.execute("PRAGMA legacy_alter_table=ON")
        conn.execute(
            f"CREATE TABLE email_metadata_v35 AS "
            f"SELECT {column_list} FROM email_metadata"
        )
        conn.execute("DROP TABLE email_metadata")
        conn.execute("ALTER TABLE email_metadata_v35 RENAME TO email_metadata")
        conn.execute("UPDATE sync_state SET value='35' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()

    SyncStore(db)
    SyncStore(db)  # 幂等: 第二次 init 不因列已存在而炸

    cols = _columns(db)
    for c in DRAFT_COLS:
        assert c in cols
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_save_email_persists_draft_linkage(tmp_path):
    """save_email 透传 draft_* 键; 不传 = NULL (老调用方零变化)。"""
    db = str(tmp_path / "save.db")
    store = SyncStore(db)
    store.save_email({
        "internal_id": 1_000_000_001,
        "message_id": "draft-mid",
        "subject": "re: x",
        "mailbox": "草稿箱",
        "sync_status": "pending",
        "backend_origin": "davmail",
        "draft_source_internal_id": 42,
        "draft_in_reply_to": "orig@x",
        "draft_references": "<head@x> <orig@x>",
    })
    row = store.get(1_000_000_001)
    assert row["draft_source_internal_id"] == 42
    assert row["draft_in_reply_to"] == "orig@x"
    assert row["draft_references"] == "<head@x> <orig@x>"

    store.save_email({
        "internal_id": 2,
        "message_id": "plain-mid",
        "subject": "inbox mail",
        "mailbox": "收件箱",
    })
    row2 = store.get(2)
    assert row2["draft_source_internal_id"] is None
    assert row2["draft_in_reply_to"] is None
    assert row2["draft_references"] is None
