"""Agent 请求/响应模型。"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class EmailContext(BaseModel):
    """当前选中邮件的上下文信息。"""

    internal_id: int
    subject: str = ""
    sender: str = ""
    sender_name: str = ""
    date: str = ""
    mailbox: str = ""
    body: str = ""
    thread_id: str = ""


class ChatRequest(BaseModel):
    """聊天请求。"""

    message: str = Field(..., min_length=1, max_length=4000)
    session_id: Optional[str] = None
    email_context: Optional[EmailContext] = None


class ChatResponse(BaseModel):
    """非流式场景的 fallback 响应。"""

    session_id: str
    content: str
    tool_calls: list[dict[str, Any]] = []


class SSEEvent(BaseModel):
    """SSE 事件（序列化为 data: JSON 行）。"""

    type: str  # text_delta | tool_start | tool_result | session | done | error
    data: dict[str, Any] = {}
