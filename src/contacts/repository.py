"""SQLite access for the Contact Directory (镜像 src/matters/repository.py 的连接形状)。

schema 归 ``src/mail/sync_store.py`` 的 v54 migration 拥有 (``CONTACT_TABLE_DDLS``
/ ``CONTACT_INDEX_DDLS``), 本仓库**不建表** —— 连接假设三表已在位。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class ContactRepository:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)

    def connect(self) -> sqlite3.Connection:
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
