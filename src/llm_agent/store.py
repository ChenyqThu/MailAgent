"""LLMProcessingStore: track LLM runs against the main sync_store SQLite DB.

Separate table `llm_processing` keyed by internal_id. Does not touch
`email_metadata` (the main sync state); LLM success/failure is an orthogonal
layer so it can be retried / audited / observed independently.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from loguru import logger

from src.config import config as cfg


# Exponential backoff in seconds: 1min, 5min, 15min, 1h, 2h
_BACKOFF = [60, 300, 900, 3600, 7200]


def _backoff_for(retry_count: int) -> float:
    idx = min(retry_count, len(_BACKOFF) - 1)
    return time.time() + _BACKOFF[idx]


class LLMProcessingStore:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or cfg.sync_store_db_path
        self._ensure_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._conn() as c:
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_processing (
                    internal_id INTEGER PRIMARY KEY,
                    notion_page_id TEXT,
                    mailbox TEXT,
                    status TEXT,
                    retry_count INTEGER DEFAULT 0,
                    next_retry_at REAL,
                    last_error TEXT,
                    model TEXT,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    cache_read_input_tokens INTEGER,
                    cache_creation_input_tokens INTEGER,
                    latency_ms INTEGER,
                    labels_json TEXT,
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            c.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_status ON llm_processing(status)"
            )
            c.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_retry "
                "ON llm_processing(next_retry_at) WHERE status='failed'"
            )
            c.commit()

    # ---- writers -----------------------------------------------------------

    def mark_pending(
        self, internal_id: int, notion_page_id: str, mailbox: str
    ) -> None:
        now = time.time()
        with self._conn() as c:
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     created_at, updated_at)
                VALUES (?, ?, ?, 'pending', 0, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    notion_page_id=excluded.notion_page_id,
                    mailbox=excluded.mailbox,
                    status='pending',
                    updated_at=excluded.updated_at
                """,
                (internal_id, notion_page_id, mailbox, now, now),
            )
            c.commit()

    def mark_success(
        self, internal_id: int, labels_obj: Any, page_id: str = ""
    ) -> None:
        now = time.time()
        # labels_obj is expected to be a dataclass; dump as JSON for audit
        try:
            labels_dict = asdict(labels_obj) if hasattr(labels_obj, "__dataclass_fields__") else dict(labels_obj or {})
        except Exception:
            labels_dict = {}
        # Strip potentially large reply text before saving (audit-only blob)
        labels_dict.pop("reply_suggestion_md", None)
        labels_json = json.dumps(labels_dict, ensure_ascii=False)[:4000]

        with self._conn() as c:
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     next_retry_at, last_error, model,
                     input_tokens, output_tokens,
                     cache_read_input_tokens, cache_creation_input_tokens,
                     latency_ms, labels_json, created_at, updated_at)
                VALUES (?, ?, ?, 'success', 0, NULL, NULL, ?,
                        ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    notion_page_id=COALESCE(excluded.notion_page_id, notion_page_id),
                    mailbox=excluded.mailbox,
                    status='success',
                    retry_count=0,
                    next_retry_at=NULL,
                    last_error=NULL,
                    model=excluded.model,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_input_tokens=excluded.cache_read_input_tokens,
                    cache_creation_input_tokens=excluded.cache_creation_input_tokens,
                    latency_ms=excluded.latency_ms,
                    labels_json=excluded.labels_json,
                    updated_at=excluded.updated_at
                """,
                (
                    internal_id,
                    page_id or labels_dict.get("notion_page_id") or None,
                    labels_dict.get("mailbox") or "",
                    labels_dict.get("model") or "",
                    int(labels_dict.get("input_tokens") or 0),
                    int(labels_dict.get("output_tokens") or 0),
                    int(labels_dict.get("cache_read_input_tokens") or 0),
                    int(labels_dict.get("cache_creation_input_tokens") or 0),
                    int(labels_dict.get("latency_ms") or 0),
                    labels_json,
                    now,
                    now,
                ),
            )
            c.commit()

    def mark_success_filtered(self, internal_id: int, page_id: str = "") -> None:
        """Mark a filtered (pre-LLM skipped) email as success with zero tokens."""
        now = time.time()
        with self._conn() as c:
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     next_retry_at, last_error, model,
                     input_tokens, output_tokens,
                     cache_read_input_tokens, cache_creation_input_tokens,
                     latency_ms, labels_json, created_at, updated_at)
                VALUES (?, ?, '', 'success', 0, NULL, NULL, 'filtered',
                        0, 0, 0, 0, 0, '{"filtered":true}', ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    status='success', model='filtered', updated_at=excluded.updated_at
                """,
                (internal_id, page_id, now, now),
            )
            c.commit()

    def mark_failed(
        self, internal_id: int, error: str, max_retries: int
    ) -> Dict[str, Any]:
        """Increment retry_count, set next_retry_at. Promote to gave_up if over limit."""
        now = time.time()
        with self._conn() as c:
            row = c.execute(
                "SELECT retry_count FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            current_retries = int((row["retry_count"] if row else 0) or 0)
            new_retries = current_retries + 1
            if new_retries >= max_retries:
                status = "gave_up"
                next_retry = None
            else:
                status = "failed"
                next_retry = _backoff_for(new_retries)
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, status, retry_count, next_retry_at,
                     last_error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    status=excluded.status,
                    retry_count=excluded.retry_count,
                    next_retry_at=excluded.next_retry_at,
                    last_error=excluded.last_error,
                    updated_at=excluded.updated_at
                """,
                (internal_id, status, new_retries, next_retry, (error or "")[:500], now, now),
            )
            c.commit()
            return {
                "internal_id": internal_id,
                "retry_count": new_retries,
                "status": status,
                "next_retry_at": next_retry,
            }

    # ---- readers -----------------------------------------------------------

    def get(self, internal_id: int) -> Optional[Dict[str, Any]]:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            return dict(row) if row else None

    def get_ready_for_retry(self, limit: int = 3) -> List[Dict[str, Any]]:
        now = time.time()
        with self._conn() as c:
            rows = c.execute(
                """
                SELECT * FROM llm_processing
                WHERE status = 'failed' AND next_retry_at <= ?
                ORDER BY next_retry_at ASC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_gave_up_count(self) -> int:
        with self._conn() as c:
            row = c.execute(
                "SELECT COUNT(*) AS n FROM llm_processing WHERE status='gave_up'"
            ).fetchone()
            return int(row["n"] if row else 0)

    def get_stats(self) -> Dict[str, int]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT status, COUNT(*) AS n FROM llm_processing GROUP BY status"
            ).fetchall()
            return {r["status"]: int(r["n"]) for r in rows}
