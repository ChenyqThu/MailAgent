"""视图聚合摘要工具。"""

from __future__ import annotations

import json
from typing import Any


def get_view_summary(inp: dict[str, Any]) -> str:
    from web.api.models.email import EmailFilter
    from web.api.services import email_service

    view = inp.get("view", "browse")
    items, total = email_service.list_emails(
        EmailFilter(view=view), page=1, page_size=200,
    )

    by_category: dict[str, int] = {}
    by_sender: dict[str, int] = {}
    by_priority: dict[str, int] = {}
    email_list: list[dict[str, Any]] = []

    for item in items:
        cat = item.category or "未分类"
        by_category[cat] = by_category.get(cat, 0) + 1
        sender = item.sender_name or item.sender or "未知"
        by_sender[sender] = by_sender.get(sender, 0) + 1
        pri = item.priority or "未标注"
        by_priority[pri] = by_priority.get(pri, 0) + 1
        email_list.append({
            "internal_id": item.internal_id,
            "subject": item.subject or "",
            "sender": f"{item.sender_name or ''} <{item.sender or ''}>".strip(),
            "date": item.date_received or "",
            "priority": item.priority or "",
            "category": item.category or "",
            "action_type": item.action_type or "",
        })

    top_senders = sorted(by_sender.items(), key=lambda x: -x[1])[:15]

    return json.dumps(
        {
            "view": view,
            "total": total,
            "showing": len(items),
            "by_category": dict(sorted(by_category.items(), key=lambda x: -x[1])),
            "by_priority": dict(sorted(by_priority.items(), key=lambda x: -x[1])),
            "top_senders": dict(top_senders),
            "emails": email_list,
        },
        ensure_ascii=False,
    )
