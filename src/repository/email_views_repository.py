"""Read-only SQLite query helpers for ``src/api/routers/email_views.py``.

Keeps raw SQL out of the FastAPI router while returning plain dict rows
compatible with ``_shape_list_item``, ``_shape_enriched_item``, and ``_shape_ai_fields``.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional, Sequence


def probe_schema(
    repo: Any, *, cache: Optional[dict[str, dict[str, Any]]] = None
) -> dict[str, Any]:
    """Probe ``email_metadata`` columns and ``llm_processing`` table existence (memoized)."""
    key = str(repo.db_path)
    if cache is not None:
        cached = cache.get(key)
        if cached is not None:
            return cached

    meta_cols: set[str] = set()
    has_llm = False
    conn = repo._connect()
    try:
        try:
            rows = conn.execute("PRAGMA table_info(email_metadata)").fetchall()
            meta_cols = {r["name"] for r in rows}
        except sqlite3.OperationalError:
            meta_cols = set()
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name='llm_processing'"
            ).fetchone()
            has_llm = row is not None
        except sqlite3.OperationalError:
            has_llm = False
    finally:
        conn.close()

    result = {"meta_cols": meta_cols, "has_llm": has_llm}
    if cache is not None:
        cache[key] = result
    return result


def query_rows(repo: Any, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    """Run a read-only SELECT via ``repo._connect()`` and return plain dict rows."""
    conn = repo._connect()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def query_mailbox_summaries(repo: Any) -> list[dict[str, Any]]:
    """Aggregate per-mailbox total/unread/flagged/failed counts excluding skipped rows."""
    sql = """
        SELECT mailbox,
               COUNT(*) AS total,
               SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
               SUM(CASE WHEN is_flagged = 1 THEN 1 ELSE 0 END) AS flagged,
               SUM(CASE WHEN sync_status IN ('failed', 'dead_letter')
                        THEN 1 ELSE 0 END) AS failed
          FROM email_metadata
         WHERE mailbox IS NOT NULL AND mailbox != ''
           AND sync_status != 'skipped'
         GROUP BY mailbox
         ORDER BY total DESC
    """
    return query_rows(repo, sql)
