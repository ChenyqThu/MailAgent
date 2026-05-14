"""Agent context tools — executed locally when the LLM calls them.

Two tools:
  - get_thread_context: returns thread history from SyncStore + llm_processing
  - get_sender_history: returns sender stats (30-day window) from SyncStore
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Dict, List, Optional

from loguru import logger

from src.config import config as cfg


def _conn(db_path: Optional[str] = None) -> sqlite3.Connection:
    c = sqlite3.connect(db_path or cfg.sync_store_db_path)
    c.row_factory = sqlite3.Row
    return c


def execute_tool(tool_name: str, tool_input: Dict[str, Any]) -> str:
    """Dispatch a context tool call and return the result as a JSON string."""
    if tool_name == "get_thread_context":
        return _thread_context(tool_input.get("thread_id", ""))
    if tool_name == "get_sender_history":
        return _sender_history(tool_input.get("sender_address", ""))
    return json.dumps({"error": f"unknown tool: {tool_name}"})


def _thread_context(thread_id: str) -> str:
    if not thread_id:
        return json.dumps({"emails": [], "note": "empty thread_id"})

    with _conn() as c:
        rows = c.execute(
            """
            SELECT e.internal_id, e.subject, e.sender, e.sender_name,
                   e.date_received, e.mailbox, e.is_read, e.is_flagged,
                   l.labels_json
              FROM email_metadata e
              LEFT JOIN llm_processing l ON e.internal_id = l.internal_id
             WHERE e.thread_id = ?
               AND e.sync_status = 'synced'
             ORDER BY e.date_received DESC
             LIMIT 8
            """,
            (thread_id,),
        ).fetchall()

    emails = []
    for r in rows:
        entry: Dict[str, Any] = {
            "internal_id": r["internal_id"],
            "subject": r["subject"] or "",
            "from": f"{r['sender_name'] or ''} <{r['sender'] or ''}>".strip(),
            "date": r["date_received"] or "",
            "mailbox": r["mailbox"] or "",
        }
        labels_raw = r["labels_json"]
        if labels_raw:
            try:
                labels = json.loads(labels_raw)
                entry["ai_summary"] = labels.get("ai_summary", "")[:200]
                entry["priority"] = labels.get("priority", "")
                entry["action_type"] = labels.get("action_type", "")
            except (json.JSONDecodeError, TypeError):
                pass
        emails.append(entry)

    return json.dumps(
        {"thread_id": thread_id, "count": len(emails), "emails": emails},
        ensure_ascii=False,
    )


def _sender_history(sender_address: str) -> str:
    if not sender_address:
        return json.dumps({"error": "empty sender_address"})

    cutoff = time.time() - 30 * 86400  # 30 days ago

    with _conn() as c:
        # Total count + date range
        stats_row = c.execute(
            """
            SELECT COUNT(*) as total,
                   MIN(date_received) as earliest,
                   MAX(date_received) as latest
              FROM email_metadata
             WHERE sender LIKE ?
               AND created_at >= ?
               AND sync_status = 'synced'
            """,
            (f"%{sender_address}%", cutoff),
        ).fetchone()

        total = stats_row["total"] if stats_row else 0

        # Priority distribution from llm_processing
        priority_rows = c.execute(
            """
            SELECT json_extract(l.labels_json, '$.priority') as priority,
                   COUNT(*) as cnt
              FROM email_metadata e
              JOIN llm_processing l ON e.internal_id = l.internal_id
             WHERE e.sender LIKE ?
               AND e.created_at >= ?
               AND l.status = 'success'
               AND l.labels_json IS NOT NULL
             GROUP BY priority
            """,
            (f"%{sender_address}%", cutoff),
        ).fetchall()
        priority_dist = {
            r["priority"]: r["cnt"] for r in priority_rows if r["priority"]
        }

        # Recent subjects (last 5)
        subject_rows = c.execute(
            """
            SELECT subject, date_received, mailbox
              FROM email_metadata
             WHERE sender LIKE ?
               AND created_at >= ?
               AND sync_status = 'synced'
             ORDER BY date_received DESC
             LIMIT 5
            """,
            (f"%{sender_address}%", cutoff),
        ).fetchall()
        recent = [
            {"subject": r["subject"] or "", "date": r["date_received"] or "",
             "mailbox": r["mailbox"] or ""}
            for r in subject_rows
        ]

    return json.dumps(
        {
            "sender": sender_address,
            "total_30d": total,
            "priority_distribution": priority_dist,
            "recent_subjects": recent,
        },
        ensure_ascii=False,
    )
