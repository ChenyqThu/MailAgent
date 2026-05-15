"""读取邮件正文 + 取 AI 标签。"""

from __future__ import annotations

import json
from typing import Any

from web.api.services.db import get_db
from web.api.services.email_queries import parse_labels


async def read_email_body(inp: dict[str, Any]) -> str:
    internal_id = inp.get("internal_id")
    if not internal_id:
        return json.dumps({"error": "missing internal_id"})

    with get_db() as conn:
        row = conn.execute(
            "SELECT notion_page_id FROM email_metadata WHERE internal_id = ?",
            (internal_id,),
        ).fetchone()

    if not row or not row["notion_page_id"]:
        return json.dumps({"error": f"邮件 {internal_id} 未同步到 Notion"})

    from web.api.services.notion_service import NotionBodyError, get_page_body

    try:
        body = await get_page_body(row["notion_page_id"])
    except NotionBodyError as e:
        return json.dumps({"error": f"获取邮件 {internal_id} 正文失败: {e}"})

    if not body:
        return json.dumps({"error": f"邮件 {internal_id} 正文为空"})

    max_chars = 8000
    truncated = len(body) > max_chars
    return json.dumps(
        {
            "internal_id": internal_id,
            "body": body[:max_chars],
            "truncated": truncated,
            "total_chars": len(body),
        },
        ensure_ascii=False,
    )


def get_email_ai_labels(inp: dict[str, Any]) -> str:
    internal_id = inp.get("internal_id")
    if not internal_id:
        return json.dumps({"error": "missing internal_id"})

    with get_db() as conn:
        row = conn.execute(
            """
            SELECT l.labels_json, l.status, l.model,
                   e.subject, e.sender, e.date_received
            FROM llm_processing l
            JOIN email_metadata e ON l.internal_id = e.internal_id
            WHERE l.internal_id = ?
            """,
            (internal_id,),
        ).fetchone()

    if not row:
        return json.dumps({"error": f"邮件 {internal_id} 无 AI 标签"})

    labels = parse_labels(row["labels_json"])

    return json.dumps(
        {
            "internal_id": internal_id,
            "subject": row["subject"] or "",
            "sender": row["sender"] or "",
            "date": row["date_received"] or "",
            "llm_status": row["status"] or "",
            "model": row["model"] or "",
            "labels": labels,
        },
        ensure_ascii=False,
    )
