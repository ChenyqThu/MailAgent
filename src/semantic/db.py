"""Independent ``semantic_index.db`` schema & path resolver (outside ``sync_store.db`` / ``DB_VERSION``)."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Iterator, Optional

SEMANTIC_DB_FILENAME = "semantic_index.db"
SEMANTIC_SCHEMA_VERSION = 1

_DDL = """
CREATE TABLE IF NOT EXISTS semantic_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_semantic_vec (
    internal_id  INTEGER NOT NULL,
    model        TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    dim          INTEGER NOT NULL,
    vec          BLOB NOT NULL,
    bq_vec       BLOB,
    updated_at   REAL NOT NULL,
    PRIMARY KEY (internal_id, model)
);
CREATE INDEX IF NOT EXISTS idx_email_semantic_model ON email_semantic_vec(model);
"""


def semantic_db_for(sync_store_db_path: str) -> str:
    """Resolve ``<data>/semantic_index.db`` alongside ``sync_store.db``."""
    return os.path.join(os.path.dirname(os.path.abspath(sync_store_db_path)), SEMANTIC_DB_FILENAME)


def resolve_semantic_db_path(sync_store_db_path: Optional[str] = None) -> str:
    if sync_store_db_path:
        return semantic_db_for(sync_store_db_path)
    try:
        from src.config import config as _cfg  # noqa: PLC0415

        return semantic_db_for(_cfg.sync_store_db_path)
    except Exception:  # noqa: BLE001 — bare worktree without .env
        data_root = os.environ.get("MAILAGENT_DATA_ROOT") or "."
        return os.path.join(os.path.abspath(data_root), "data", SEMANTIC_DB_FILENAME)


class SemanticDb:
    """Lightweight SQLite wrapper for ``semantic_index.db`` (WAL + per-call connections)."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._ensure_schema()

    def connect(self) -> sqlite3.Connection:
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(_DDL)
            conn.execute(
                "INSERT OR REPLACE INTO semantic_meta (key, value) VALUES ('schema_version', ?)",
                (str(SEMANTIC_SCHEMA_VERSION),),
            )
            conn.commit()
        finally:
            conn.close()
