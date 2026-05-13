"""邮件数据模型。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class EmailListItem(BaseModel):
    internal_id: int
    message_id: Optional[str] = None
    subject: Optional[str] = None
    sender: Optional[str] = None
    sender_name: Optional[str] = None
    to_addr: Optional[str] = None
    date_received: Optional[str] = None
    mailbox: Optional[str] = None
    is_read: bool = False
    is_flagged: bool = False
    has_attachments: bool = False
    notion_page_id: Optional[str] = None

    # LLM 字段（从 labels_json 解析）
    ai_summary: Optional[str] = None
    key_points: Optional[str] = None
    category: Optional[str] = None
    priority: Optional[str] = None
    action_type: Optional[str] = None
    action_required: bool = False
    sender_priority: Optional[str] = None
    language: Optional[str] = None
    urgency_reason: Optional[str] = None
    mail_actions: Optional[List[str]] = None
    reply_suggestion: Optional[str] = None
    related_project: Optional[str] = None

    # 处理状态
    llm_status: Optional[str] = None


class EmailDetail(EmailListItem):
    thread_id: Optional[str] = None
    cc_addr: Optional[str] = None
    body_html: Optional[str] = None
    body_text: Optional[str] = None
    # 线程中其他邮件数量
    thread_count: int = 0


class EmailFilter(BaseModel):
    view: Optional[str] = None  # pending | browse | ignore | all
    mailbox: Optional[str] = None
    priority: Optional[str] = None
    action_type: Optional[str] = None
    category: Optional[str] = None
    is_flagged: Optional[bool] = None
    llm_status: Optional[str] = None
    search: Optional[str] = None
    pending_only: bool = True  # 兼容旧逻辑，view 优先
