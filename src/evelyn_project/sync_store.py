"""Evelyn 项目同步的 SQLite 状态存储。

独立表 `evelyn_project_sync`，与 `email_metadata` 共用一个 SQLite 文件
(config.sync_store_db_path)，但完全解耦（不依赖 src.mail.sync_store.SyncStore）。

表 Schema（CREATE IF NOT EXISTS）:
    email_internal_id INTEGER PRIMARY KEY  -- 邮件的 internal_id
    email_message_id TEXT
    email_subject TEXT
    email_date TEXT                        -- ISO
    xlsx_filename TEXT
    xlsx_md5 TEXT
    week_tag TEXT                          -- 2026-W17
    total_rows INTEGER
    enbu_rows INTEGER
    projects_total INTEGER
    projects_created INTEGER
    projects_updated INTEGER
    projects_failed INTEGER
    status TEXT                            -- processing/completed/failed/skipped
    error TEXT
    started_at REAL
    completed_at REAL

增量语义:
    - 已 completed 的 (internal_id) → 默认跳过 (force=True 重跑)
    - 同 xlsx_md5 已 completed → 默认跳过 (用于转发链去重)
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS evelyn_project_sync (
    email_internal_id INTEGER PRIMARY KEY,
    email_message_id TEXT,
    email_subject TEXT,
    email_date TEXT,
    xlsx_filename TEXT,
    xlsx_md5 TEXT,
    week_tag TEXT,
    total_rows INTEGER,
    enbu_rows INTEGER,
    projects_total INTEGER,
    projects_created INTEGER,
    projects_updated INTEGER,
    projects_failed INTEGER,
    status TEXT,
    error TEXT,
    started_at REAL,
    completed_at REAL
);
CREATE INDEX IF NOT EXISTS idx_evelyn_week ON evelyn_project_sync(week_tag);
CREATE INDEX IF NOT EXISTS idx_evelyn_md5 ON evelyn_project_sync(xlsx_md5);
CREATE INDEX IF NOT EXISTS idx_evelyn_status ON evelyn_project_sync(status);
"""


@dataclass
class EvelynSyncRecord:
    email_internal_id: int
    email_message_id: Optional[str] = None
    email_subject: Optional[str] = None
    email_date: Optional[str] = None
    xlsx_filename: Optional[str] = None
    xlsx_md5: Optional[str] = None
    week_tag: Optional[str] = None
    total_rows: int = 0
    enbu_rows: int = 0
    projects_total: int = 0
    projects_created: int = 0
    projects_updated: int = 0
    projects_failed: int = 0
    status: str = "processing"
    error: Optional[str] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None


class EvelynSyncStore:
    """轻量封装，用 sqlite3 直连。所有方法同步（非 async）——只做几十次 tick。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(_SCHEMA_SQL)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    # ---------- read ----------

    def get(self, internal_id: int) -> Optional[EvelynSyncRecord]:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM evelyn_project_sync WHERE email_internal_id = ?",
                (internal_id,),
            ).fetchone()
        return _row_to_record(row)

    def get_by_md5(self, md5: str) -> Optional[EvelynSyncRecord]:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM evelyn_project_sync WHERE xlsx_md5 = ? AND status='completed' "
                "ORDER BY completed_at DESC LIMIT 1",
                (md5,),
            ).fetchone()
        return _row_to_record(row)

    def list_recent(self, limit: int = 20) -> List[EvelynSyncRecord]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM evelyn_project_sync "
                "ORDER BY COALESCE(completed_at, started_at, email_internal_id) DESC "
                "LIMIT ?",
                (limit,),
            ).fetchall()
        return [r for r in (_row_to_record(row) for row in rows) if r is not None]

    # ---------- write ----------

    def start(self, record: EvelynSyncRecord) -> None:
        record.status = "processing"
        record.started_at = time.time()
        self._upsert(record)

    def complete(self, record: EvelynSyncRecord) -> None:
        record.status = "completed"
        record.completed_at = time.time()
        self._upsert(record)

    def fail(self, record: EvelynSyncRecord, error: str) -> None:
        record.status = "failed"
        record.error = error[:2000]
        record.completed_at = time.time()
        self._upsert(record)

    def skip(self, internal_id: int, reason: str, md5: Optional[str] = None) -> None:
        rec = self.get(internal_id) or EvelynSyncRecord(
            email_internal_id=internal_id, xlsx_md5=md5
        )
        rec.status = "skipped"
        rec.error = reason[:2000]
        rec.completed_at = time.time()
        self._upsert(rec)

    def _upsert(self, rec: EvelynSyncRecord) -> None:
        data = asdict(rec)
        cols = list(data.keys())
        placeholders = ",".join("?" for _ in cols)
        columns_sql = ",".join(cols)
        updates_sql = ",".join(f"{c}=excluded.{c}" for c in cols if c != "email_internal_id")
        sql = (
            f"INSERT INTO evelyn_project_sync ({columns_sql}) VALUES ({placeholders}) "
            f"ON CONFLICT(email_internal_id) DO UPDATE SET {updates_sql}"
        )
        with self._conn() as c:
            c.execute(sql, tuple(data[c] for c in cols))


def _row_to_record(row: Optional[sqlite3.Row]) -> Optional[EvelynSyncRecord]:
    if row is None:
        return None
    return EvelynSyncRecord(**{k: row[k] for k in row.keys()})
