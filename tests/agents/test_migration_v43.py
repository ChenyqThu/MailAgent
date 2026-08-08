from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


def _columns(path):
    with sqlite3.connect(str(path)) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(report_agent)")}


def _version(path):
    with sqlite3.connect(str(path)) as conn:
        return int(conn.execute("SELECT value FROM sync_state WHERE key='db_version'").fetchone()[0])


def test_v43_adds_description_and_is_idempotent(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(str(path)) as conn:
        conn.execute("ALTER TABLE report_agent RENAME TO report_agent_current")
        cols = conn.execute("PRAGMA table_info(report_agent_current)").fetchall()
        defs = []
        names = []
        for _, name, ctype, notnull, default, pk in cols:
            if name == "description":
                continue
            names.append(name)
            definition = f"{name} {ctype}"
            if pk:
                definition += " PRIMARY KEY"
            if notnull:
                definition += " NOT NULL"
            if default is not None:
                definition += f" DEFAULT {default}"
            defs.append(definition)
        joined = ", ".join(names)
        conn.execute(f"CREATE TABLE report_agent ({', '.join(defs)})")
        conn.execute(f"INSERT INTO report_agent ({joined}) SELECT {joined} FROM report_agent_current")
        conn.execute("DROP TABLE report_agent_current")
        conn.execute("UPDATE sync_state SET value='42' WHERE key='db_version'")
        conn.commit()
    SyncStore(str(path))
    SyncStore(str(path))
    assert "description" in _columns(path)
    assert _version(path) == SyncStore.DB_VERSION
