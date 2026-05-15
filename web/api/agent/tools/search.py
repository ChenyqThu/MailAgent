"""关键词搜索 + 日期范围搜索。"""

from __future__ import annotations

import json
from typing import Any

from web.api.services.db import get_db
from web.api.services.email_queries import (
    EMAIL_AGENT_SELECT,
    build_search_conditions,
)

from ._common import row_to_email


def search_emails(inp: dict[str, Any]) -> str:
    query = inp.get("query", "").strip()
    view = inp.get("view", "").strip()
    limit = min(int(inp.get("limit", 20)), 50)
    if not query:
        return json.dumps({"emails": [], "note": "empty query"})

    # 有 view 参数时：通过 email_service 获取视图内邮件，再做关键词过滤
    if view and view != "all":
        from web.api.models.email import EmailFilter
        from web.api.services import email_service

        items, _ = email_service.list_emails(
            EmailFilter(view=view), page=1, page_size=500,
        )
        q_lower = query.lower()
        matched: list[dict[str, Any]] = []
        for item in items:
            searchable = " ".join([
                item.subject or "",
                item.sender or "",
                item.sender_name or "",
                item.ai_summary or "",
                item.category or "",
                item.action_type or "",
            ]).lower()
            if q_lower not in searchable:
                continue
            matched.append({
                "internal_id": item.internal_id,
                "subject": item.subject or "",
                "sender": f"{item.sender_name or ''} <{item.sender or ''}>".strip(),
                "date": item.date_received or "",
                "mailbox": item.mailbox or "",
                "priority": item.priority or "",
                "category": item.category or "",
                "action_type": item.action_type or "",
                "ai_summary": item.ai_summary or "",
            })
            if len(matched) >= limit:
                break
        return json.dumps(
            {"count": len(matched), "view": view, "emails": matched},
            ensure_ascii=False,
        )

    # 无 view：全局 SQL LIKE 搜索
    cond, params = build_search_conditions(query, use_labels=True)
    with get_db() as conn:
        rows = conn.execute(
            f"{EMAIL_AGENT_SELECT} WHERE em.sync_status = 'synced' AND {cond} "
            "ORDER BY em.internal_id DESC LIMIT ?",
            params + [limit],
        ).fetchall()

    return json.dumps(
        {"count": len(rows), "emails": [row_to_email(r) for r in rows]},
        ensure_ascii=False,
    )


def search_by_date(inp: dict[str, Any]) -> str:
    start = inp.get("start_date", "").strip()
    end = inp.get("end_date", "").strip()
    mailbox = inp.get("mailbox", "").strip()
    limit = min(int(inp.get("limit", 20)), 50)

    if not start or not end:
        return json.dumps({"error": "missing start_date or end_date"})

    conditions = ["em.sync_status = 'synced'", "em.date_received >= ?", "em.date_received <= ?"]
    params: list[Any] = [start, end + "T23:59:59"]
    if mailbox:
        conditions.append("em.mailbox = ?")
        params.append(mailbox)

    sql = (
        f"{EMAIL_AGENT_SELECT} WHERE {' AND '.join(conditions)} "
        "ORDER BY em.date_received DESC LIMIT ?"
    )
    with get_db() as conn:
        rows = conn.execute(sql, params + [limit]).fetchall()

    return json.dumps(
        {"count": len(rows), "emails": [row_to_email(r) for r in rows]},
        ensure_ascii=False,
    )
