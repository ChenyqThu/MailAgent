"""v63 Contact Profile 状态列与 report_agent seed 迁移。"""

from __future__ import annotations

import json
import sqlite3

from src.mail.sync_store import CONTACT_TABLE_DDLS, SyncStore

PROFILE_COLUMNS = {"profile_status", "profile_attempted_at", "profile_error"}


def _columns(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(contact)")}


def _seed(path):
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM report_agent WHERE id='contact_profile_agent'"
        ).fetchone()


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def _downgrade_contact_to_v54(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("DROP TABLE contact_email_link")
        conn.execute("DROP TABLE contact_email")
        conn.execute("DROP TABLE contact")
        for ddl in CONTACT_TABLE_DDLS:
            old = ddl.replace("formal_name TEXT NULL", "name_en TEXT NULL")
            old = old.replace(
                "        profile_status TEXT NULL CHECK (\n"
                "            profile_status IS NULL OR profile_status IN ('ok','skipped','failed','running')\n"
                "        ),\n",
                "",
            )
            old = old.replace("        profile_attempted_at INTEGER NULL,\n", "")
            old = old.replace("        profile_error TEXT NULL,\n", "")
            conn.execute(old)
        conn.execute("DELETE FROM report_agent WHERE id='contact_profile_agent'")
        conn.execute(
            "UPDATE sync_state SET value='54' WHERE key='db_version'"
        )
        conn.commit()


def test_v63_fresh_database_has_columns_and_disabled_seed(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert _version(path) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 65
    assert PROFILE_COLUMNS <= _columns(path)
    row = _seed(path)
    assert row is not None
    assert row["type"] == "contact_profile"
    assert row["enabled"] == 0
    assert row["model"] == ""
    assert row["prompt"] == ""
    assert json.loads(row["trigger_json"]) == {"fire_hour": 4, "daily_limit": 50}


def test_v63_replays_from_v54_shape(tmp_path):
    path = tmp_path / "old.db"
    SyncStore(str(path))
    _downgrade_contact_to_v54(path)
    assert PROFILE_COLUMNS.isdisjoint(_columns(path))
    SyncStore(str(path))
    assert _version(path) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 65
    assert PROFILE_COLUMNS <= _columns(path)
    assert "formal_name" in _columns(path)
    assert _seed(path)["enabled"] == 0
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_suggestion'"
        ).fetchone() is not None


def test_v63_idempotent_replay_preserves_agent_edits(tmp_path):
    path = tmp_path / "replay.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE report_agent SET enabled=1, prompt='custom' "
            "WHERE id='contact_profile_agent'"
        )
        conn.execute("UPDATE sync_state SET value='62' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    row = _seed(path)
    assert row["enabled"] == 1
    assert row["prompt"] == "custom"
    assert PROFILE_COLUMNS <= _columns(path)
