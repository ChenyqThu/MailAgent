"""Agent 工具定义 + 本地执行器。

6 个工具，全部走本地 SQLite 查询（read_email_body 除外，走 Notion API）。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from loguru import logger

from web.api.config import web_config
from web.api.services.db import get_db

# ---------------------------------------------------------------------------
# Tool schemas（Anthropic tool_use 格式）
# ---------------------------------------------------------------------------

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "search_emails",
        "description": (
            "搜索邮件。按关键词匹配主题、发件人、AI 摘要。"
            "返回匹配邮件列表（internal_id, subject, sender, date, mailbox, ai_summary, priority）。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词",
                },
                "limit": {
                    "type": "integer",
                    "description": "最大返回数量，默认 10",
                    "default": 10,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_email_body",
        "description": (
            "读取指定邮件的完整正文（纯文本）。"
            "需要先通过 search_emails 或上下文获取 internal_id。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "internal_id": {
                    "type": "integer",
                    "description": "邮件 internal_id",
                },
            },
            "required": ["internal_id"],
        },
    },
    {
        "name": "get_thread_context",
        "description": (
            "获取邮件线程上下文。返回同一线程内最近 8 封邮件的摘要、优先级、操作类型。"
            "用于理解邮件的对话背景。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "thread_id": {
                    "type": "string",
                    "description": "线程 ID（邮件的 thread_id 字段）",
                },
            },
            "required": ["thread_id"],
        },
    },
    {
        "name": "get_sender_stats",
        "description": (
            "获取发件人统计。返回最近 30 天的邮件数量、优先级分布、最近 5 封邮件主题。"
            "用于了解某个发件人的沟通模式。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sender_address": {
                    "type": "string",
                    "description": "发件人邮箱地址（支持模糊匹配）",
                },
            },
            "required": ["sender_address"],
        },
    },
    {
        "name": "search_by_date",
        "description": (
            "按日期范围搜索邮件。返回指定时间段内的邮件列表。"
            "日期格式: YYYY-MM-DD。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {
                    "type": "string",
                    "description": "开始日期 (YYYY-MM-DD)",
                },
                "end_date": {
                    "type": "string",
                    "description": "结束日期 (YYYY-MM-DD)",
                },
                "mailbox": {
                    "type": "string",
                    "description": "邮箱名称过滤（可选，如 '收件箱'）",
                },
                "limit": {
                    "type": "integer",
                    "description": "最大返回数量，默认 20",
                    "default": 20,
                },
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_email_ai_labels",
        "description": (
            "获取邮件的 AI 分析结果。返回 AI 生成的分类、优先级、摘要、操作类型等标签。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "internal_id": {
                    "type": "integer",
                    "description": "邮件 internal_id",
                },
            },
            "required": ["internal_id"],
        },
    },
]


# ---------------------------------------------------------------------------
# 工具执行器
# ---------------------------------------------------------------------------

async def execute_tool(tool_name: str, tool_input: dict[str, Any]) -> str:
    """执行工具，返回 JSON 字符串结果。"""
    try:
        if tool_name == "search_emails":
            return _search_emails(tool_input)
        if tool_name == "read_email_body":
            return await _read_email_body(tool_input)
        if tool_name == "get_thread_context":
            return _get_thread_context(tool_input)
        if tool_name == "get_sender_stats":
            return _get_sender_stats(tool_input)
        if tool_name == "search_by_date":
            return _search_by_date(tool_input)
        if tool_name == "get_email_ai_labels":
            return _get_email_ai_labels(tool_input)
        return json.dumps({"error": f"unknown tool: {tool_name}"})
    except Exception as e:
        logger.warning(f"[agent-tool] {tool_name} failed: {e!r}")
        return json.dumps({"error": str(e)})


# ---------------------------------------------------------------------------
# 各工具实现
# ---------------------------------------------------------------------------

def _search_emails(inp: dict[str, Any]) -> str:
    query = inp.get("query", "").strip()
    limit = min(inp.get("limit", 10), 30)
    if not query:
        return json.dumps({"emails": [], "note": "empty query"})

    pattern = f"%{query}%"
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT em.internal_id, em.subject, em.sender, em.sender_name,
                   em.date_received, em.mailbox, em.thread_id,
                   lp.labels_json
            FROM email_metadata em
            LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
            WHERE em.sync_status = 'synced'
            AND (
                em.subject LIKE ? OR em.sender LIKE ? OR em.sender_name LIKE ?
                OR json_extract(lp.labels_json, '$.ai_summary') LIKE ?
                OR json_extract(lp.labels_json, '$.category') LIKE ?
            )
            ORDER BY em.internal_id DESC
            LIMIT ?
            """,
            (pattern, pattern, pattern, pattern, pattern, limit),
        ).fetchall()

    return json.dumps(
        {"count": len(rows), "emails": [_row_to_email(r) for r in rows]},
        ensure_ascii=False,
    )


async def _read_email_body(inp: dict[str, Any]) -> str:
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

    from web.api.services.notion_service import get_page_body

    body = await get_page_body(row["notion_page_id"])
    if not body:
        return json.dumps({"error": f"无法获取邮件 {internal_id} 的正文"})

    # 截断避免 token 爆炸
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


def _get_thread_context(inp: dict[str, Any]) -> str:
    """复用 src/llm_agent/tools 的逻辑，但用 web db 连接。"""
    thread_id = inp.get("thread_id", "").strip()
    if not thread_id:
        return json.dumps({"emails": [], "note": "empty thread_id"})

    with get_db() as conn:
        rows = conn.execute(
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
        entry = _row_to_email(r)
        entry["is_read"] = bool(r["is_read"])
        entry["is_flagged"] = bool(r["is_flagged"])
        emails.append(entry)

    return json.dumps(
        {"thread_id": thread_id, "count": len(emails), "emails": emails},
        ensure_ascii=False,
    )


def _get_sender_stats(inp: dict[str, Any]) -> str:
    """复用 src/llm_agent/tools 的逻辑，但用 web db 连接。"""
    sender = inp.get("sender_address", "").strip()
    if not sender:
        return json.dumps({"error": "empty sender_address"})

    import time

    cutoff = time.time() - 30 * 86400

    with get_db() as conn:
        pattern = f"%{sender}%"
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


def _search_by_date(inp: dict[str, Any]) -> str:
    start = inp.get("start_date", "").strip()
    end = inp.get("end_date", "").strip()
    mailbox = inp.get("mailbox", "").strip()
    limit = min(inp.get("limit", 20), 50)

    if not start or not end:
        return json.dumps({"error": "missing start_date or end_date"})

    with get_db() as conn:
        if mailbox:
            rows = conn.execute(
                """
                SELECT em.internal_id, em.subject, em.sender, em.sender_name,
                       em.date_received, em.mailbox, em.thread_id,
                       lp.labels_json
                FROM email_metadata em
                LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
                WHERE em.sync_status = 'synced'
                  AND em.date_received >= ? AND em.date_received <= ?
                  AND em.mailbox = ?
                ORDER BY em.date_received DESC
                LIMIT ?
                """,
                (start, end + "T23:59:59", mailbox, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT em.internal_id, em.subject, em.sender, em.sender_name,
                       em.date_received, em.mailbox, em.thread_id,
                       lp.labels_json
                FROM email_metadata em
                LEFT JOIN llm_processing lp ON em.internal_id = lp.internal_id
                WHERE em.sync_status = 'synced'
                  AND em.date_received >= ? AND em.date_received <= ?
                ORDER BY em.date_received DESC
                LIMIT ?
                """,
                (start, end + "T23:59:59", limit),
            ).fetchall()

    return json.dumps(
        {"count": len(rows), "emails": [_row_to_email(r) for r in rows]},
        ensure_ascii=False,
    )


def _get_email_ai_labels(inp: dict[str, Any]) -> str:
    internal_id = inp.get("internal_id")
    if not internal_id:
        return json.dumps({"error": "missing internal_id"})

    with get_db() as conn:
        row = conn.execute(
            """
            SELECT l.labels_json, l.status, l.model_used,
                   e.subject, e.sender, e.date_received
            FROM llm_processing l
            JOIN email_metadata e ON l.internal_id = e.internal_id
            WHERE l.internal_id = ?
            """,
            (internal_id,),
        ).fetchone()

    if not row:
        return json.dumps({"error": f"邮件 {internal_id} 无 AI 标签"})

    labels = {}
    try:
        labels = json.loads(row["labels_json"] or "{}")
    except (json.JSONDecodeError, TypeError):
        pass

    return json.dumps(
        {
            "internal_id": internal_id,
            "subject": row["subject"] or "",
            "sender": row["sender"] or "",
            "date": row["date_received"] or "",
            "llm_status": row["status"] or "",
            "model": row["model_used"] or "",
            "labels": labels,
        },
        ensure_ascii=False,
    )


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _row_to_email(r: sqlite3.Row) -> dict[str, Any]:
    labels: dict[str, Any] = {}
    try:
        labels = json.loads(r["labels_json"] or "{}")
    except (json.JSONDecodeError, TypeError):
        pass

    # sqlite3.Row 不支持 .get()，用 keys() 判断列是否存在
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
