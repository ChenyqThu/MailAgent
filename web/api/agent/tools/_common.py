"""工具实现的共享 helpers。"""

from __future__ import annotations

import sqlite3
from typing import Any

from web.api.services.email_queries import parse_labels


def row_to_email(r: sqlite3.Row) -> dict[str, Any]:
    """统一的 row → agent 邮件 dict 形式（含 LLM 标签字段）。"""
    labels = parse_labels(r["labels_json"] if "labels_json" in r.keys() else None)
    keys = r.keys()
    return {
        "internal_id": r["internal_id"],
        "subject": r["subject"] or "",
        "sender": f"{r['sender_name'] or ''} <{r['sender'] or ''}>".strip(),
        "date": r["date_received"] or "",
        "mailbox": r["mailbox"] or "",
        "thread_id": r["thread_id"] if "thread_id" in keys else "",
        "ai_summary": labels.get("ai_summary", ""),
        "priority": labels.get("priority", ""),
        "action_type": labels.get("action_type", ""),
        "category": labels.get("category", ""),
    }
