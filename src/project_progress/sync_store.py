"""项目周报同步的 SQLite 状态存储.

独立表 `project_progress_sync`, 与 `email_metadata` 共用一个 SQLite 文件
(config.sync_store_db_path) 但完全解耦.

迁移历史:
    - 旧表名 `evelyn_project_sync` (仅 1 个 sheet 时代). 启动时若检测到旧表存在
      → ALTER TABLE RENAME (透明迁移, idempotent)
    - 2026-04 加 5 列: sheet_ongoing_rows / sheet_shipped_rows / sheet_suspended_rows
      / projects_marked_done / projects_marked_suspended (zwf 4 sheet 改造)

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
CREATE TABLE IF NOT EXISTS project_progress_sync (
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
    sheet_ongoing_rows INTEGER DEFAULT 0,
    sheet_shipped_rows INTEGER DEFAULT 0,
    sheet_suspended_rows INTEGER DEFAULT 0,
    projects_marked_done INTEGER DEFAULT 0,
    projects_marked_suspended INTEGER DEFAULT 0,
    status TEXT,
    error TEXT,
    started_at REAL,
    completed_at REAL
);
CREATE INDEX IF NOT EXISTS idx_pp_week ON project_progress_sync(week_tag);
CREATE INDEX IF NOT EXISTS idx_pp_md5 ON project_progress_sync(xlsx_md5);
CREATE INDEX IF NOT EXISTS idx_pp_status ON project_progress_sync(status);
"""

# 旧表名 → 新表名的迁移. ALTER TABLE RENAME 在 SQLite >= 3.25 (我们用的是 macOS 自带或 Python sqlite3, 都支持).
_RENAME_LEGACY_TABLE = "ALTER TABLE evelyn_project_sync RENAME TO project_progress_sync"

# v2 改造时新加的列, 用 try/except 包 ALTER 保 idempotent
_NEW_COLUMNS = [
    ("sheet_ongoing_rows", "INTEGER DEFAULT 0"),
    ("sheet_shipped_rows", "INTEGER DEFAULT 0"),
    ("sheet_suspended_rows", "INTEGER DEFAULT 0"),
    ("projects_marked_done", "INTEGER DEFAULT 0"),
    ("projects_marked_suspended", "INTEGER DEFAULT 0"),
]


def _migrate_legacy(conn: sqlite3.Connection) -> None:
    """旧表名 evelyn_project_sync → project_progress_sync. 每个 ALTER 失败容错."""
    # 1. RENAME 旧表 (如果存在 + 新表不存在)
    try:
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('evelyn_project_sync', 'project_progress_sync')"
        )
        names = {r[0] for r in cur.fetchall()}
        if "evelyn_project_sync" in names and "project_progress_sync" not in names:
            conn.execute(_RENAME_LEGACY_TABLE)
            conn.commit()
    except Exception:
        # idempotent: 若 sqlite_master 查询失败或并发竞争, 让后续 CREATE TABLE IF NOT EXISTS 兜底
        pass

    # 2. 加 5 个新列 (idempotent)
    for col_name, col_type in _NEW_COLUMNS:
        try:
            conn.execute(f"ALTER TABLE project_progress_sync ADD COLUMN {col_name} {col_type}")
            conn.commit()
        except sqlite3.OperationalError:
            # 已存在 → "duplicate column name" 错误, 忽略
            pass


@dataclass
class ProjectProgressSyncRecord:
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
    # v2 4-sheet 改造新增字段
    sheet_ongoing_rows: int = 0
    sheet_shipped_rows: int = 0
    sheet_suspended_rows: int = 0
    projects_marked_done: int = 0
    projects_marked_suspended: int = 0
    status: str = "processing"
    error: Optional[str] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None


class ProjectProgressSyncStore:
    """轻量封装，用 sqlite3 直连。所有方法同步（非 async）——只做几十次 tick。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            # 先做老表迁移 (如果存在 evelyn_project_sync 旧表 → 改名 + 加新列),
            # 再执行 CREATE IF NOT EXISTS 兜底初始化
            _migrate_legacy(c)
            c.executescript(_SCHEMA_SQL)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    # ---------- read ----------

    def get(self, internal_id: int) -> Optional[ProjectProgressSyncRecord]:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM project_progress_sync WHERE email_internal_id = ?",
                (internal_id,),
            ).fetchone()
        return _row_to_record(row)

    def get_by_md5(self, md5: str) -> Optional[ProjectProgressSyncRecord]:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM project_progress_sync WHERE xlsx_md5 = ? AND status='completed' "
                "ORDER BY completed_at DESC LIMIT 1",
                (md5,),
            ).fetchone()
        return _row_to_record(row)

    def list_recent(self, limit: int = 20) -> List[ProjectProgressSyncRecord]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM project_progress_sync "
                "ORDER BY COALESCE(completed_at, started_at, email_internal_id) DESC "
                "LIMIT ?",
                (limit,),
            ).fetchall()
        return [r for r in (_row_to_record(row) for row in rows) if r is not None]

    # ---------- write ----------

    def start(self, record: ProjectProgressSyncRecord) -> None:
        record.status = "processing"
        record.started_at = time.time()
        self._upsert(record)

    def complete(self, record: ProjectProgressSyncRecord) -> None:
        record.status = "completed"
        record.completed_at = time.time()
        self._upsert(record)

    def fail(self, record: ProjectProgressSyncRecord, error: str) -> None:
        record.status = "failed"
        record.error = error[:2000]
        record.completed_at = time.time()
        self._upsert(record)

    def skip(self, internal_id: int, reason: str, md5: Optional[str] = None) -> None:
        rec = self.get(internal_id) or ProjectProgressSyncRecord(
            email_internal_id=internal_id, xlsx_md5=md5
        )
        rec.status = "skipped"
        rec.error = reason[:2000]
        rec.completed_at = time.time()
        self._upsert(rec)

    def _upsert(self, rec: ProjectProgressSyncRecord) -> None:
        data = asdict(rec)
        cols = list(data.keys())
        placeholders = ",".join("?" for _ in cols)
        columns_sql = ",".join(cols)
        updates_sql = ",".join(f"{c}=excluded.{c}" for c in cols if c != "email_internal_id")
        sql = (
            f"INSERT INTO project_progress_sync ({columns_sql}) VALUES ({placeholders}) "
            f"ON CONFLICT(email_internal_id) DO UPDATE SET {updates_sql}"
        )
        with self._conn() as c:
            c.execute(sql, tuple(data[c] for c in cols))


def _row_to_record(row: Optional[sqlite3.Row]) -> Optional[ProjectProgressSyncRecord]:
    if row is None:
        return None
    return ProjectProgressSyncRecord(**{k: row[k] for k in row.keys()})
