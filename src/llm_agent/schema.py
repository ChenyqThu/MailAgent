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
        "Classify a single email and produce all required Notion fields. "
        "Call this tool exactly once. Never reply in plain text."
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
        ],
        "properties": {
            "ai_summary": {
                "type": "string",
                "description": (
                    "2-4 句摘要。收件箱：这封邮件说了什么/我需要做什么；"
                    "发件箱：我请求了什么/期望的响应是什么。最多 2000 字。"
                ),
                "maxLength": 2000,
            },
            "key_points": {
                "type": "string",
                "description": (
                    "关键信息点，每条一行（待办事项、决策点、截止日期、数据、结论、风险）。"
                    "多行用 \\n 分隔。没有则留空字符串。"
                ),
            },
            "category": {
                "type": "string",
                "enum": CATEGORY_ENUM,
                "description": "综合主题与正文判断邮件分类。",
            },
            "language": {
                "type": "string",
                "enum": LANGUAGE_ENUM,
                "description": "邮件主要语言。",
            },
            "sender_priority": {
                "type": "string",
                "enum": SENDER_PRIORITY_ENUM,
                "description": (
                    "发件人角色分组（收件箱）；收件人重要性（发件箱，语义变）。"
                    "参照 reference context 中的 Sender Priority 映射。"
                ),
            },
            "action_required": {
                "type": "boolean",
                "description": (
                    "收件箱：是否有对我的明确请求/需要回复决策评审参会；"
                    "发件箱：是否需要我主动跟进（超时未回复或 reminder）。"
                ),
            },
            "action_type": {
                "type": "string",
                "enum": ACTION_TYPE_ALL,
                "description": (
                    "必须匹配当前 mailbox。\n"
                    "收件箱仅可选：需要回复 / 需要决策 / 需要Review / 需要会议 / 仅供参考。\n"
                    "发件箱仅可选：等待响应 / 需要跟进 / 已完结 / 仅供参考。"
                ),
            },
            "priority": {
                "type": "string",
                "enum": PRIORITY_ENUM,
                "description": (
                    "严格判定：🔴 紧急仅用于线上事故/发布阻塞/生产异常且需我立即处理。"
                    "🟡 重要用于关键评审/版本 deadline。🟢 一般用于日常。⚪ 低用于 FYI。"
                ),
            },
            "urgency_reason": {
                "type": "string",
                "description": (
                    "仅当 priority=🔴 紧急时填 1-3 句原因（时间限制、风险、影响范围）；"
                    "其他情况留空字符串。"
                ),
            },
            "mail_actions": {
                "type": "array",
                "items": {"type": "string", "enum": MAIL_ACTIONS_ENUM},
                "description": "推荐后续操作标签，0-4 个，与 priority/action_required 呼应。",
            },
            "reply_suggestion_md": {
                "type": "string",
                "description": (
                    "建议回复/跟进内容，Markdown 格式。仅 action_required=true 时填。\n"
                    "⚠️ 仅限 inline 元素 + 换行：**bold**, *italic*, ~~strike~~, `code`, [text](url)。\n"
                    "列表用 '- ' 或 '1. ' 前缀纯文本模拟，禁止 heading / code block / 真 list。\n"
                    "结构：称呼 → 正文段落 → 签名。结尾必须是：\n\n----\nBest,\nLucien"
                ),
            },
            "daily_digest_date": {
                "type": "string",
                "description": (
                    "邮件所属 Daily Digest 日期（YYYY-MM-DD，固定 UTC+8 切割线）。"
                    "脚本将按此日期查 Daily Digest 页面建立 relation。"
                    "不确定则留空字符串。"
                ),
            },
            "related_project": {
                "type": "string",
                "description": (
                    "可选。若邮件与 reference context 中『当前重点项目』之一明确相关，"
                    "填项目名称；否则留空字符串。"
                ),
            },
        },
    },
}


def is_valid_action_type(action_type: str, mailbox: str) -> bool:
    """Check action_type matches the given mailbox (post-validation)."""
    if mailbox == "发件箱":
        return action_type in ACTION_TYPE_SENT
    return action_type in ACTION_TYPE_INBOX
