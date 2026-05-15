"""线程上下文工具。"""

from __future__ import annotations

import json
from typing import Any

from web.api.services.db import get_db
from web.api.services.email_queries import EMAIL_AGENT_SELECT

from ._common import row_to_email


def get_thread_context(inp: dict[str, Any]) -> str:
    thread_id = inp.get("thread_id", "").strip()
    if not thread_id:
        return json.dumps({"emails": [], "note": "empty thread_id"})

    with get_db() as conn:
        rows = conn.execute(
            f"{EMAIL_AGENT_SELECT} "
            "WHERE em.thread_id = ? AND em.sync_status = 'synced' "
            "ORDER BY em.date_received DESC LIMIT 8",
            (thread_id,),
        ).fetchall()

    emails = []
    for r in rows:
        entry = row_to_email(r)
        entry["is_read"] = bool(r["is_read"])
        entry["is_flagged"] = bool(r["is_flagged"])
        emails.append(entry)

    return json.dumps(
        {"thread_id": thread_id, "count": len(emails), "emails": emails},
        ensure_ascii=False,
    )
