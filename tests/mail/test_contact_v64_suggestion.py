import sqlite3

from src.mail.sync_store import SyncStore


def _columns(path):
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(contact_suggestion)")}


def test_v64_fresh_database_has_governance_queue(tmp_path):
    path = tmp_path / "sync.db"
    store = SyncStore(str(path))
    assert store.DB_VERSION == 64
    assert _columns(path) == {
        "id", "type", "contact_ids_json", "payload_json", "evidence_json",
        "evidence_fingerprint", "confidence", "status", "block_reason",
        "created_at", "decided_at",
    }


def test_v63_to_v64_replay_and_idempotency(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE contact_suggestion")
        conn.execute(
            "UPDATE sync_state SET value='63' WHERE key='db_version'"
        )
        conn.commit()
    SyncStore(str(path))
    SyncStore(str(path))
    assert "evidence_fingerprint" in _columns(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0] == "64"
