"""发件人统计工具。"""

from __future__ import annotations

import json
import time
from typing import Any

from web.api.services.db import get_db


def get_sender_stats(inp: dict[str, Any]) -> str:
    sender = inp.get("sender_address", "").strip()
    if not sender:
        return json.dumps({"error": "empty sender_address"})

    cutoff = time.time() - 30 * 86400
    pattern = f"%{sender}%"

    with get_db() as conn:
        stats_row = conn.execute(
            """
            SELECT COUNT(*) as total,
                   MIN(date_received) as earliest,
                   MAX(date_received) as latest
            FROM email_metadata
            WHERE sender LIKE ? AND created_at >= ? AND sync_status = 'synced'
            """,
            (pattern, cutoff),
        ).fetchone()

        total = stats_row["total"] if stats_row else 0

        priority_rows = conn.execute(
            """
            SELECT json_extract(l.labels_json, '$.priority') as priority,
                   COUNT(*) as cnt
            FROM email_metadata e
            JOIN llm_processing l ON e.internal_id = l.internal_id
            WHERE e.sender LIKE ? AND e.created_at >= ?
              AND l.status = 'success' AND l.labels_json IS NOT NULL
            GROUP BY priority
            """,
            (pattern, cutoff),
        ).fetchall()
        priority_dist = {r["priority"]: r["cnt"] for r in priority_rows if r["priority"]}

        subject_rows = conn.execute(
            """
            SELECT subject, date_received, mailbox
            FROM email_metadata
            WHERE sender LIKE ? AND created_at >= ? AND sync_status = 'synced'
            ORDER BY date_received DESC LIMIT 5
            """,
            (pattern, cutoff),
        ).fetchall()
        recent = [
            {"subject": r["subject"] or "", "date": r["date_received"] or "",
             "mailbox": r["mailbox"] or ""}
            for r in subject_rows
        ]

    return json.dumps(
        {
            "sender": sender,
            "total_30d": total,
            "priority_distribution": priority_dist,
            "recent_subjects": recent,
        },
        ensure_ascii=False,
    )
