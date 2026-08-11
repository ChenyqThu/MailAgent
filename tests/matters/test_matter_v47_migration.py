from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore
from src.mail import sync_store
from src.matters import events, models


COLUMNS = {
    "id", "matter_id", "kind", "subject_key", "state", "severity", "why",
    "recurrence_no", "first_opened_at", "last_observed_at", "snoozed_until",
    "resolved_at", "dismissed_at", "cleared_at", "last_notified_at", "payload_json",
}
INDEXES = {"uq_matter_attention_active", "idx_matter_attention_state"}


def _columns(path):
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(matter_attention)")}


def _indexes(path):
    with sqlite3.connect(path) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}


def _version(path):
    with sqlite3.connect(path) as conn:
        return conn.execute("SELECT value FROM sync_state WHERE key='db_version'").fetchone()[0]


def test_v47_fresh_db_has_attention_table_and_indexes(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert COLUMNS <= _columns(path)
    assert INDEXES <= _indexes(path)
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v47_upgrade_from_46_and_idempotent_rerun(tmp_path):
    path = tmp_path / "migrated.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE matter_attention")
        conn.execute("UPDATE sync_state SET value='46' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    SyncStore(str(path))
    assert COLUMNS <= _columns(path)
    assert INDEXES <= _indexes(path)
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v47_attention_vocabulary_and_event_registry_are_canonical():
    assert models.MATTER_ATTENTION_SEVERITIES == ("info", "warn", "critical")
    ddl = "\n".join(sync_store.MATTER_TABLE_DDLS)
    assert models.sql_check_clause(models.MatterAttentionKind) in ddl
    assert models.sql_check_clause(models.MatterAttentionState) in ddl
    assert models.sql_check_clause(models.MatterAttentionSeverity) in ddl
    assert {
        "attention_opened", "attention_resolved", "attention_snoozed",
        "attention_dismissed",
    } <= set(events.MATTER_EVENT_KINDS)
