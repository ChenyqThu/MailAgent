from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


EXPECTED_COLUMNS = {
    "id",
    "matter_id",
    "resource_key",
    "rejected_at",
    "evidence_fingerprint",
    "reason",
}
EXPECTED_INDEX = "idx_matter_resource_rejection_matter"


def _columns(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            row[1]
            for row in conn.execute("PRAGMA table_info(matter_resource_rejection)")
        }


def _indexes(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _downgrade_to_v48(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE matter_resource_rejection")
        conn.execute("UPDATE sync_state SET value='48' WHERE key='db_version'")
        conn.commit()


def test_v49_fresh_db_has_resource_rejection_memory(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert EXPECTED_COLUMNS <= _columns(path)
    assert EXPECTED_INDEX in _indexes(path)
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v49_upgrade_from_48_matches_fresh_shape(tmp_path):
    fresh = tmp_path / "fresh.db"
    migrated = tmp_path / "migrated.db"
    SyncStore(str(fresh))
    SyncStore(str(migrated))
    _downgrade_to_v48(migrated)
    SyncStore(str(migrated))
    assert _columns(migrated) == _columns(fresh)
    assert EXPECTED_INDEX in _indexes(migrated)
    assert _version(migrated) == str(SyncStore.DB_VERSION)


def test_v49_migration_rerun_is_idempotent_and_unique(tmp_path):
    path = tmp_path / "idempotent.db"
    SyncStore(str(path))
    _downgrade_to_v48(path)
    SyncStore(str(path))
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO matter_seq(created_at) VALUES (1)")
        conn.execute(
            "INSERT INTO matter(public_id,title,created_at,updated_at) "
            "VALUES ('MAT-0001','Existing',1,1)"
        )
        conn.execute(
            "INSERT INTO matter_resource_rejection "
            "(matter_id,resource_key,rejected_at,evidence_fingerprint) "
            "VALUES (1,'mailagent:email:1',1,'fp')"
        )
        try:
            conn.execute(
                "INSERT INTO matter_resource_rejection "
                "(matter_id,resource_key,rejected_at,evidence_fingerprint) "
                "VALUES (1,'mailagent:email:1',2,'fp2')"
            )
            raise AssertionError("resource rejection unique constraint did not fire")
        except sqlite3.IntegrityError:
            pass

