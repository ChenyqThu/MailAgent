"""SyncStore v42 migration: report_agent gains nullable avatar_json."""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


def _columns(db_path: str) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(report_agent)")}


def test_fresh_db_has_agent_avatar_column(tmp_path):
    db = str(tmp_path / "fresh.db")
    SyncStore(db)

    assert "avatar_json" in _columns(db)


def test_v41_adds_avatar_column_idempotently(tmp_path):
    db = str(tmp_path / "v41.db")
    SyncStore(db)
    with sqlite3.connect(db) as conn:
        conn.execute("ALTER TABLE report_agent DROP COLUMN avatar_json")
        conn.execute("UPDATE sync_state SET value='41' WHERE key='db_version'")
        conn.commit()

    SyncStore(db)
    SyncStore(db)

    assert "avatar_json" in _columns(db)
    with sqlite3.connect(db) as conn:
        version = conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]
    assert int(version) == SyncStore.DB_VERSION
