"""SyncStore v33 migration tests for denormalized email snippets."""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


def _fetchone(db_path: str, sql: str):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql).fetchone()
    finally:
        conn.close()


def test_v33_adds_and_backfills_snippet_idempotently(tmp_path):
    db = str(tmp_path / "v33.db")
    SyncStore(db)
    markdown = "中文🙂正文" * 30
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
            "VALUES (1, 'synced', 1, 1)"
        )
        conn.execute(
            "INSERT INTO email_body "
            "(internal_id, body_markdown, fetched_at, fetched_source) "
            "VALUES (1, ?, 1, 'test')",
            (markdown,),
        )
        conn.execute("ALTER TABLE email_metadata DROP COLUMN snippet")
        conn.execute("UPDATE sync_state SET value='32' WHERE key='db_version'")
        conn.commit()
    finally:
        conn.close()

    SyncStore(db)
    SyncStore(db)

    conn = sqlite3.connect(db)
    try:
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(email_metadata)").fetchall()
        }
    finally:
        conn.close()
    assert "snippet" in columns
    row = _fetchone(db, "SELECT snippet FROM email_metadata WHERE internal_id=1")
    assert row[0] == markdown[:100]
    assert (
        int(_fetchone(db, "SELECT value FROM sync_state WHERE key='db_version'")[0])
        == 33
    )
