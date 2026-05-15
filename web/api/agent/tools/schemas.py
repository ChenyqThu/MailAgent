"""Agent 工具的 Anthropic tool_use schema 定义。"""

from __future__ import annotations

from typing import Any

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "search_emails",
        "description": (
            "搜索邮件。按关键词匹配主题、发件人、AI 摘要、分类。"
            "可限定在特定视图内搜索（pending/browse/all）。"
            "返回匹配邮件列表（internal_id, subject, sender, date, mailbox, ai_summary, priority, category）。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词（匹配主题、发件人、AI 摘要、分类）",
                },
                "view": {
                    "type": "string",
                    "description": "限定搜索范围到指定视图（可选）: pending, browse, all",
                    "enum": ["pending", "browse", "all"],
                },
                "limit": {
                    "type": "integer",
                    "description": "最大返回数量，默认 20",
                    "default": 20,
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
                "internal_id": {"type": "integer", "description": "邮件 internal_id"},
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
                "thread_id": {"type": "string", "description": "线程 ID（邮件的 thread_id 字段）"},
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
            "按日期范围搜索邮件。返回指定时间段内的邮件列表。日期格式: YYYY-MM-DD。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "开始日期 (YYYY-MM-DD)"},
                "end_date": {"type": "string", "description": "结束日期 (YYYY-MM-DD)"},
                "mailbox": {"type": "string", "description": "邮箱名称过滤（可选，如 '收件箱'）"},
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
        "name": "get_view_summary",
        "description": (
            "获取指定视图（pending/browse/all）的邮件统计摘要。"
            "返回总数、按类别/发件人/优先级的分布、以及完整邮件列表（最多 200 封，含 subject/sender/date/priority/category）。"
            "适合用户想快速了解某个视图全貌、或决定是否批量处理。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "view": {
                    "type": "string",
                    "description": "视图名称: pending, browse, all",
                    "enum": ["pending", "browse", "all"],
                },
            },
            "required": ["view"],
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
                "internal_id": {"type": "integer", "description": "邮件 internal_id"},
            },
            "required": ["internal_id"],
        },
    },
    {
        "name": "batch_action",
        "description": (
            "对多封邮件执行批量操作。支持的操作: mark_done（标记已完成）、mark_browsed（标记已阅）、toggle_flag（切换旗标）、toggle_read（切换已读）。"
            "可以传入 email_ids 列表直接操作，也可以传 view 对整个视图批量操作（view 模式下 mark_browsed 用于 browse 视图，mark_done 用于 pending 视图）。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "操作类型: mark_done, mark_browsed, toggle_flag, toggle_read",
                    "enum": ["mark_done", "mark_browsed", "toggle_flag", "toggle_read"],
                },
                "email_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "要操作的邮件 internal_id 列表（与 view 二选一）",
                },
                "view": {
                    "type": "string",
                    "description": "对整个视图批量操作（与 email_ids 二选一）: pending, browse",
                    "enum": ["pending", "browse"],
                },
            },
            "required": ["action"],
        },
    },
]
