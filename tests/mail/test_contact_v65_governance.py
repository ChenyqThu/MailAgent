"""v65 Contact Governance report_agent seed 迁移。"""

from __future__ import annotations

import json
import sqlite3

from src.mail.sync_store import SyncStore


def _seed(path):
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM report_agent WHERE id='contact_governance_agent'"
        ).fetchone()


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def test_v65_fresh_database_has_disabled_governance_seed(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert _version(path) == SyncStore.DB_VERSION
    assert SyncStore.DB_VERSION >= 65
    row = _seed(path)
    assert row is not None
    assert row["type"] == "contact_governance"
    assert row["enabled"] == 0
    assert row["model"] == ""
    assert row["prompt"] == ""
    assert json.loads(row["trigger_json"]) == {"fire_hour": 5}


def test_v64_to_v65_replay_and_idempotency_preserve_edits(tmp_path):
    path = tmp_path / "old.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM report_agent WHERE id='contact_governance_agent'")
        conn.execute("UPDATE sync_state SET value='64' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE report_agent SET enabled=1, model='provider:model', prompt='custom', "
            "trigger_json='{\"fire_hour\":9}' WHERE id='contact_governance_agent'"
        )
        conn.execute("UPDATE sync_state SET value='64' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    row = _seed(path)
    assert _version(path) == SyncStore.DB_VERSION
    assert row["enabled"] == 1
    assert row["model"] == "provider:model"
    assert row["prompt"] == "custom"
    assert json.loads(row["trigger_json"]) == {"fire_hour": 9}
