"""Anthropic tool schema + Notion enum source-of-truth.

Enums come from `GET /v1/databases/<EMAIL_DATABASE_ID>` (probed 2026-04-23).
Keep in sync if Notion admins change select options.
"""

from __future__ import annotations

from typing import List

# issue #42: sent 判定统一走宽集 (含 '已发送邮件' 等变体), 与通知面口径对齐。
from src.mail.mailbox_semantics import is_sent_mailbox

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


# Phase 2 — Ping-island AI 动态建议按钮（PRD §5.2）。
# LLM 可推荐的 action id 白名单（子集，不含 Phase 1 静态 5 fallback）。
# 配套 island_action_whitelist.KNOWN_ACTION_IDS（含静态 5）— 一处的真子集，handler 仍按 KNOWN_ACTION_IDS 校验。
# 改这里 → schema enum 同步收紧 → LLM 输出超集 id 直接被 client.py JSON schema 校验拒。
RECOMMENDED_ACTION_ID_INBOX: List[str] = [
    # Newsletter / 营销 / FYI
    "archive_and_unsubscribe",
    "archive_only",
    # 会议邀请 (.ics / 明确时间地点)
    "add_to_calendar",
    "decline_with_reason",
    # 项目周报 / 报告 / 非紧急但需工作日处理
    "defer_to_monday_9am",
    "convert_to_notion_task",
    # ack_in_pagerduty / escalate_to_oncall 已下线 (2026-05-26): PagerDuty/oncall 是
    # 运维告警场景, 产品经理用户不用. Phase 3 若有运维邮件需求接 incident 集成时加回.
    # 简单 Y/N 询问
    "quick_reply_yes",
    "quick_reply_no_with_reason",
]

RECOMMENDED_ACTION_ID_SENT: List[str] = [
    # 发件箱 follow-up: 超过等待期标完成 / 起一个催办草稿
    "mark_done_no_response",
    "nudge_recipient",
]

RECOMMENDED_ACTION_ID_ENUM: List[str] = sorted({
    *RECOMMENDED_ACTION_ID_INBOX,
    *RECOMMENDED_ACTION_ID_SENT,
})


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
                    "**必须用简体中文（mainland 用法）写 2-4 句摘要**，即使原邮件是英文也要总结成中文。"
                    "收件箱：这封邮件说了什么 / 我需要做什么；"
                    "发件箱：我请求了什么 / 期望的响应是什么。"
                    "URL / 邮件地址 / 代码标识符 / 产品名 / 人名保留 verbatim 不音译。最多 2000 字。"
                ),
                "maxLength": 2000,
            },
            "key_points": {
                "type": "string",
                "description": (
                    "**每行用简体中文**列出关键信息点（待办事项、决策点、截止日期、数据、结论、风险）。"
                    "多行用 \\n 分隔。没有则留空字符串。"
                    "URL / 邮件地址 / 代码标识符 / 产品名保留 verbatim。"
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
                    "结构：称呼 → 正文段落 → 签名。签名固定为：\n\n----\nBest,\n"
                    "末行为用户本人姓名；若不知用户姓名则省略末行、只保留 Best,，切勿编造姓名。"
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
            "translation_segments": {
                "type": "array",
                "description": (
                    "沉浸式翻译缓存 — 仅在 language != '中文' 时填写。"
                    "按邮件正文段落（一个 <p>/<li>/<h*>/<td>/<blockquote> 算一段）的自然顺序输出。"
                    "每个 segment.src 必须是邮件正文中该段落的 verbatim 子串（plaintext, 不含 "
                    "markdown 标记, 长度 30-300 字符；过长段落取首句作为定位锚），用于程序后续 "
                    "fuzzy 匹配 DOM 节点。tgt 是该段对应的简体中文 mainland 用法译文。"
                    "保留 URL / 邮件地址 / 代码标识符 / 产品名 verbatim。"
                    "中文邮件留空数组 []；不要为已是中文的段落生成翻译。"
                ),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["src", "tgt"],
                    "properties": {
                        "src": {
                            "type": "string",
                            "description": "原文段落 verbatim 子串（plaintext, 30-300 字符）。",
                        },
                        "tgt": {
                            "type": "string",
                            "description": "简体中文译文。",
                        },
                    },
                },
            },
            "recommended_actions": {
                "type": "array",
                "maxItems": 3,
                "description": (
                    "灵动岛 Ping Island 动态建议按钮（Phase 2）— 根据邮件内容给 1-3 个最针对性的处理"
                    "建议替代默认 5 按钮 fallback。LLM 不确定时（每个候选 confidence < 0.5 或没有合"
                    "适候选）留空数组 []，plugin 端会退回默认 5 按钮（open_notion / create_draft "
                    "/ mark_done / snooze_1h / open_mail）。\n\n"
                    "id 必须从 mailbox-specific whitelist 选择（schema enum 强制；不在 enum 的会被 "
                    "JSON schema 校验拒），见 mailbox prompt 内『Recommended Actions』段说明。"
                ),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "title", "confidence"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "enum": RECOMMENDED_ACTION_ID_ENUM,
                            "description": (
                                "action id, 必须从 mailbox-specific whitelist 选；不在 whitelist "
                                "的 silent drop。收件箱可选 INBOX 列表, 发件箱可选 SENT 列表（详见 "
                                "mailbox prompt）。"
                            ),
                        },
                        "title": {
                            "type": "string",
                            "maxLength": 30,
                            "description": "button 第一行显示文本，简体中文，≤ 30 字符。",
                        },
                        "detail": {
                            "type": "string",
                            "maxLength": 80,
                            "description": (
                                "button 第二行副标题，解释推荐理由，简体中文，≤ 80 字符。可选。"
                            ),
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0.0,
                            "maximum": 1.0,
                            "description": (
                                "置信度 0-1。plugin 端会丢弃 < 0.5 的候选；全部候选都 < 0.5 时退回"
                                "静态 5 按钮 fallback。"
                            ),
                        },
                    },
                },
            },
        },
    },
}


def is_valid_action_type(action_type: str, mailbox: str) -> bool:
    """Check action_type matches the given mailbox (post-validation)."""
    if is_sent_mailbox(mailbox):
        return action_type in ACTION_TYPE_SENT
    return action_type in ACTION_TYPE_INBOX


def is_valid_recommended_action_id(action_id: str, mailbox: str) -> bool:
    """Check recommended_actions[*].id matches the given mailbox.

    Schema enum covers union (INBOX ∪ SENT)；用 post-validation 收紧到 mailbox-specific
    子集。空 mailbox → 按收件箱处理（与 ``is_valid_action_type`` 一致）。
    """
    if is_sent_mailbox(mailbox):
        return action_id in RECOMMENDED_ACTION_ID_SENT
    return action_id in RECOMMENDED_ACTION_ID_INBOX
