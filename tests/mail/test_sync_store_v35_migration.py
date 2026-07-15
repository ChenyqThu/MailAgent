"""SyncStore v35 migration tests — calendar_event.tzid (#10 tzid 半步)。

新库: CREATE TABLE 已含 tzid 列。
旧库 (v34 模拟): 重建**无 tzid 列**的 calendar_event 表 (迁移测试禁 DROP COLUMN,
一律重建表 — CI sqlite 教训) → re-init → ALTER TABLE ADD COLUMN 补列, 既有行
保留且 tzid=NULL。幂等: 重复 init 不炸不重复。
"""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore

# v34 期 calendar_event 表形状 (无 tzid 列), 用于旧库模拟重建
_V34_CALENDAR_EVENT_DDL = """
    CREATE TABLE calendar_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ical_uid TEXT NOT NULL,
        recurrence_id TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        calendar_name TEXT,
        summary TEXT,
        description TEXT,
        location TEXT,
        organizer TEXT,
        attendees_json TEXT,
        dtstart_utc REAL NOT NULL,
        dtend_utc REAL,
        is_all_day INTEGER NOT NULL DEFAULT 0,
        rrule TEXT,
        exdates_json TEXT,
        rdates_json TEXT,
        status TEXT,
        response_status TEXT,
        url TEXT,
        ics_raw TEXT,
        source TEXT NOT NULL DEFAULT 'caldav',
        notion_page_id TEXT,
        related_email_internal_id INTEGER,
        last_synced_at REAL NOT NULL,
        deleted_at REAL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        CHECK (source IN ('caldav', 'email_ics', 'legacy_calendar_app'))
    )
"""


def _fetchone(db_path: str, sql: str, params=()):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def _columns(db_path: str, table: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    finally:
        conn.close()


def test_v35_fresh_db_has_tzid_column(tmp_path):
    db = str(tmp_path / "fresh.db")
    SyncStore(db)
    assert "tzid" in _columns(db, "calendar_event")
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_v35_old_db_gains_tzid_and_keeps_rows(tmp_path):
    db = str(tmp_path / "v35.db")
    SyncStore(db)
    conn = sqlite3.connect(db)
    try:
        # 模拟 v34 旧库: 重建无 tzid 列的 calendar_event 表 + 一行存量数据
        conn.execute("DROP TABLE calendar_event")
        conn.execute(_V34_CALENDAR_EVENT_DDL)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_unique
            ON calendar_event(ical_uid, COALESCE(recurrence_id, ''), source)
        """)
        conn.execute(
            "INSERT INTO calendar_event (ical_uid, dtstart_utc, source, "
            "last_synced_at, created_at, updated_at) "
            "VALUES ('uid-old', 1780000000.0, 'caldav', 1, 1, 1)"
        )
        conn.execute("UPDATE sync_state SET value='34' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()

    SyncStore(db)
    SyncStore(db)  # 幂等重跑

    assert "tzid" in _columns(db, "calendar_event")
    row = _fetchone(
        db, "SELECT ical_uid, tzid FROM calendar_event WHERE ical_uid='uid-old'"
    )
    assert row is not None
    assert row[1] is None  # 无回填, NULL = 修复前 UTC 语义
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == SyncStore.DB_VERSION
    )


def test_v35_tzid_column_accepts_value(tmp_path):
    db = str(tmp_path / "val.db")
    SyncStore(db)
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            "INSERT INTO calendar_event (ical_uid, dtstart_utc, tzid, source, "
            "last_synced_at, created_at, updated_at) "
            "VALUES ('uid-tz', 1780000000.0, 'America/Los_Angeles', 'caldav', 1, 1, 1)"
        )
        conn.commit()
    finally:
        conn.close()
    row = _fetchone(db, "SELECT tzid FROM calendar_event WHERE ical_uid='uid-tz'")
    assert row[0] == "America/Los_Angeles"
