from __future__ import annotations

import sqlite3

from src.mail.sync_store import MATTER_TABLE_DDLS, SyncStore


def foreign_keys(path, table: str):
    with sqlite3.connect(path) as conn:
        return sorted((row[2], row[3], row[4], row[6]) for row in conn.execute(f"PRAGMA foreign_key_list({table})"))


def downgrade_matter_fks_to_v44(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("ALTER TABLE matter_event RENAME TO matter_event_v45_source")
        conn.execute("ALTER TABLE matter_item RENAME TO matter_item_v45_source")
        item_ddl = (
            MATTER_TABLE_DDLS[2]
            .replace(" REFERENCES matter_stakeholder(id) ON DELETE SET NULL", "")
            .replace(" REFERENCES resource(id) ON DELETE SET NULL", "")
        )
        event_ddl = (
            MATTER_TABLE_DDLS[3]
            .replace(" REFERENCES resource(id) ON DELETE SET NULL", "")
            .replace("REFERENCES matter_item(id)", "REFERENCES matter_item_v45_source(id)")
            .replace("REFERENCES matter_event(id)", "REFERENCES matter_event_v45_source(id)")
        )
        conn.execute(item_ddl)
        conn.execute(event_ddl)
        conn.execute("INSERT INTO matter_item SELECT * FROM matter_item_v45_source")
        conn.execute("INSERT INTO matter_event SELECT * FROM matter_event_v45_source")
        conn.execute("DROP TABLE matter_event_v45_source")
        conn.execute("DROP TABLE matter_item_v45_source")
        conn.execute("UPDATE sync_state SET value='44' WHERE key='db_version'")
        conn.commit()


def test_v45_fresh_and_migrated_foreign_keys_are_equivalent_and_clean(tmp_path):
    fresh = tmp_path / "fresh.db"
    migrated = tmp_path / "migrated.db"
    SyncStore(str(fresh))
    SyncStore(str(migrated))
    downgrade_matter_fks_to_v44(migrated)
    SyncStore(str(migrated))

    assert foreign_keys(fresh, "matter_item") == foreign_keys(migrated, "matter_item")
    assert foreign_keys(fresh, "matter_event") == foreign_keys(migrated, "matter_event")
    with sqlite3.connect(migrated) as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT value FROM sync_state WHERE key='db_version'").fetchone()[0] == "45"


def test_v45_migration_is_idempotent_and_backfills_search_projection(tmp_path):
    path = tmp_path / "idempotent.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_seq(created_at) VALUES (1)"
        )
        conn.execute(
            "INSERT INTO matter(public_id,title,created_at,updated_at) VALUES ('MAT-0001','Backfill title',1,1)"
        )
    downgrade_matter_fks_to_v44(path)
    SyncStore(str(path))
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT title FROM matter_search_document WHERE matter_id=1"
        ).fetchone()[0] == "Backfill title"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
