"""SyncStore v34 migration tests — email_meeting 邮件↔日历 ical_uid 映射表。

新库: CREATE TABLE IF NOT EXISTS 直接建表。
旧库 (v33 模拟): DROP email_meeting 后重跑 init → 建表 + 从 recurring_series
best-effort 回填 (last_seen_message_id join email_metadata.message_id,
method=NULL / is_recurring=1)。幂等: 重复 init 不重复插行。
"""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


def _fetchone(db_path: str, sql: str, params=()):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def test_v34_fresh_db_has_email_meeting_table(tmp_path):
    db = str(tmp_path / "fresh.db")
    SyncStore(db)
    row = _fetchone(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='email_meeting'",
    )
    assert row is not None
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_v34_backfills_from_recurring_series_idempotently(tmp_path):
    db = str(tmp_path / "v34.db")
    SyncStore(db)
    conn = sqlite3.connect(db)
    try:
        # 模拟 v33 旧库: 无 email_meeting 表 + 有 recurring_series 存量
        conn.execute("DROP TABLE email_meeting")
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, subject, "
            "sync_status, created_at, updated_at) "
            "VALUES (101, '<weekly@example.com>', 'Weekly sync', 'synced', 1, 1)"
        )
        conn.execute(
            "INSERT INTO recurring_series (series_uid, rrule_str, master_dtstart, "
            "master_dtend, last_sequence, last_seen_message_id, created_at, updated_at) "
            "VALUES ('uid-weekly', 'FREQ=WEEKLY', '2026-07-01T09:00:00+00:00', "
            "'2026-07-01T10:00:00+00:00', 3, '<weekly@example.com>', 1, 1)"
        )
        # last_seen_message_id 无对应邮件行 → join 不命中, 不回填
        conn.execute(
            "INSERT INTO recurring_series (series_uid, rrule_str, master_dtstart, "
            "master_dtend, last_seen_message_id, created_at, updated_at) "
            "VALUES ('uid-orphan', 'FREQ=DAILY', '2026-07-01T09:00:00+00:00', "
            "'2026-07-01T10:00:00+00:00', '<gone@example.com>', 1, 1)"
        )
        conn.execute("UPDATE sync_state SET value='33' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()

    SyncStore(db)
    SyncStore(db)  # 幂等重跑

    row = _fetchone(
        db,
        "SELECT ical_uid, method, sequence, is_recurring FROM email_meeting "
        "WHERE internal_id = 101",
    )
    assert row is not None
    assert row[0] == "uid-weekly"
    assert row[1] is None  # 回填行 method 不可考
    assert row[2] == 3
    assert row[3] == 1
    assert _fetchone(db, "SELECT COUNT(*) FROM email_meeting")[0] == 1
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_upsert_and_get_email_meeting_roundtrip(tmp_path):
    db = str(tmp_path / "rt.db")
    store = SyncStore(db)
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status, created_at, "
            "updated_at) VALUES (55, 'synced', 1, 1)"
        )
        conn.commit()
    finally:
        conn.close()

    assert store.upsert_email_meeting(
        55, ical_uid="uid-a", method="REQUEST", sequence=1, is_recurring=True
    )
    row = store.get_email_meeting(55)
    assert row is not None
    assert row["ical_uid"] == "uid-a"
    assert row["method"] == "REQUEST"
    assert row["is_recurring"] == 1

    # upsert 覆盖 (同邮件 re-parse, 如 CANCEL 更新)
    assert store.upsert_email_meeting(
        55, ical_uid="uid-a", method="CANCEL", sequence=2, is_recurring=True
    )
    row = store.get_email_meeting(55)
    assert row["method"] == "CANCEL"
    assert row["sequence"] == 2

    # 空 uid 拒写
    assert not store.upsert_email_meeting(55, ical_uid="")
    assert store.get_email_meeting(999) is None
