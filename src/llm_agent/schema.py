"""Anthropic tool schema + Notion enum source-of-truth.

Enums come from `GET /v1/databases/<EMAIL_DATABASE_ID>` (probed 2026-04-23).
Keep in sync if Notion admins change select options.
"""

from __future__ import annotations

from typing import List

# ---- Enums (exact match to Notion email DB schema) -------------------------

CATEGORY_ENUM: List[str] = [
    "💼 产品管理",
    "🤝 会议通知",
    "🛠️ 技术讨论",
    "👥 团队协作",
    "📊 项目管理",
    "🔔 系统通知",
    "🌐 外部沟通",
]

LANGUAGE_ENUM: List[str] = [
    "English", "中文", "Spanish", "French", "German",
    "Japanese", "Korean", "Russian", "Other",
]

SENDER_PRIORITY_ENUM: List[str] = [
    "管理层", "核心团队", "产品团队", "研发团队",
    "销售团队", "外部联系人", "系统",
]

PRIORITY_ENUM: List[str] = ["🔴 紧急", "🟡 重要", "🟢 一般", "⚪ 低"]

# Inbox-only action types
ACTION_TYPE_INBOX: List[str] = [
    "需要回复", "需要决策", "需要Review", "需要会议", "仅供参考",
]

# Sent-box-only action types
ACTION_TYPE_SENT: List[str] = [
    "等待响应", "需要跟进", "已完结", "仅供参考",
]

# Union — tool schema enum; we post-validate against mailbox-specific subset
ACTION_TYPE_ALL: List[str] = sorted({*ACTION_TYPE_INBOX, *ACTION_TYPE_SENT})

MAIL_ACTIONS_ENUM: List[str] = [
    "✅ Marked as Read",
    "⭐ Starred",
    "📁 Moved to Folder",
    "🏷️ Tagged",
    "🗑️ Archived",
    "⚠️ Flagged",
    "↩️ Replied",
    "⏩ Forwarded",
]

# Processing Status values (code-side only; not exposed to LLM)
PROCESSING_STATUS_AI_REVIEWED = "AI Reviewed"
PROCESSING_STATUS_COMPLETED = "已完成"


EMAIL_TOOL_SCHEMA = {
    "name": "classify_email",
    "description": (
        "Classify the email and produce all required fields. "
        "You MUST call this tool exactly once as your final action."
    ),
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "ai_summary",
            "category",
            "language",
            "sender_priority",
            "action_required",
            "action_type",
            "priority",
            "confidence",
        ],
        "properties": {
            "confidence": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": (
                    "分类置信度 0.0-1.0。"
                    "< 0.6 时系统不会自动推进 Processing Status，留给人工复核。"
                    "简单明确的邮件（系统通知、newsletter）应 >= 0.9；"
                    "模糊或需要更多上下文才能判断的给 0.4-0.6。"
                ),
            },
            "ai_summary": {
                "type": "string",
                "description": (
                    "2-4 句摘要。收件箱：说了什么 + 我需要做什么；"
                    "发件箱：我请求了什么 + 期望的响应。最多 2000 字。"
                ),
                "maxLength": 2000,
            },
            "key_points": {
                "type": "string",
                "description": (
                    "关键信息点，每条一行（待办、决策点、截止日期、数据、结论、风险）。"
                    "多行用 \\n 分隔。没有则留空字符串。"
                ),
            },
            "category": {
                "type": "string",
                "enum": CATEGORY_ENUM,
            },
            "language": {
                "type": "string",
                "enum": LANGUAGE_ENUM,
            },
            "sender_priority": {
                "type": "string",
                "enum": SENDER_PRIORITY_ENUM,
            },
            "action_required": {
                "type": "boolean",
            },
            "action_type": {
                "type": "string",
                "enum": ACTION_TYPE_ALL,
            },
            "priority": {
                "type": "string",
                "enum": PRIORITY_ENUM,
            },
            "urgency_reason": {
                "type": "string",
                "description": (
                    "仅当 priority=🔴紧急 时填 1-3 句原因；其他留空字符串。"
                ),
            },
            "mail_actions": {
                "type": "array",
                "items": {"type": "string", "enum": MAIL_ACTIONS_ENUM},
                "description": "推荐操作标签，0-4 个。",
            },
            "reply_suggestion_md": {
                "type": "string",
                "description": (
                    "建议回复草稿（仅 action_required=true 时填）。"
                    "仅限 inline Markdown + 换行。"
                    "结尾签名：\\n\\n----\\nBest,\\nKevin"
                ),
            },
            "daily_digest_date": {
                "type": "string",
                "description": "邮件 Date 转 UTC+8 的日期（YYYY-MM-DD）。不确定则留空。",
            },
            "related_project": {
                "type": "string",
                "description": (
                    "若与 reference context 中重点项目明确相关，填项目名；否则留空。"
                ),
            },
        },
    },
}


# ---- Context tools (agent can optionally call before classify_email) --------

THREAD_CONTEXT_TOOL_SCHEMA = {
    "name": "get_thread_context",
    "description": (
        "查询当前邮件所在线程的历史邮件摘要。"
        "用于判断：这是新话题还是已有对话？之前做过什么决定？谁参与过？"
        "仅当 thread_id 非空且你需要上下文时调用。"
    ),
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["thread_id"],
        "properties": {
            "thread_id": {
                "type": "string",
                "description": "邮件的 thread_id（从邮件元数据中获取）。",
            },
        },
    },
}

SENDER_HISTORY_TOOL_SCHEMA = {
    "name": "get_sender_history",
    "description": (
        "查询发件人近 30 天的邮件统计：发信频率、主题分布、历史 priority 分布。"
        "用于判断：这个人经常发什么邮件？过去的优先级模式是什么？"
        "仅当你需要了解发件人行为模式时调用。"
    ),
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["sender_address"],
        "properties": {
            "sender_address": {
                "type": "string",
                "description": "发件人邮箱地址。",
            },
        },
    },
}


def is_valid_action_type(action_type: str, mailbox: str) -> bool:
    """Check action_type matches the given mailbox (post-validation)."""
    if mailbox == "发件箱":
        return action_type in ACTION_TYPE_SENT
    return action_type in ACTION_TYPE_INBOX
