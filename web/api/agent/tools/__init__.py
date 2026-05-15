"""Agent 工具集合：路由器 + schema 导出。"""

from __future__ import annotations

import json
from typing import Any

from loguru import logger

from .batch_action import batch_action
from .reader import get_email_ai_labels, read_email_body
from .schemas import TOOL_SCHEMAS
from .search import search_by_date, search_emails
from .sender import get_sender_stats
from .thread_ctx import get_thread_context
from .view_summary import get_view_summary

__all__ = ["TOOL_SCHEMAS", "execute_tool"]


_SYNC_TOOLS = {
    "search_emails": search_emails,
    "get_thread_context": get_thread_context,
    "get_sender_stats": get_sender_stats,
    "search_by_date": search_by_date,
    "get_view_summary": get_view_summary,
    "get_email_ai_labels": get_email_ai_labels,
}

_ASYNC_TOOLS = {
    "read_email_body": read_email_body,
    "batch_action": batch_action,
}


async def execute_tool(tool_name: str, tool_input: dict[str, Any]) -> str:
    """路由到对应工具实现，返回 JSON 字符串结果。"""
    try:
        if tool_name in _SYNC_TOOLS:
            return _SYNC_TOOLS[tool_name](tool_input)
        if tool_name in _ASYNC_TOOLS:
            return await _ASYNC_TOOLS[tool_name](tool_input)
        return json.dumps({"error": f"unknown tool: {tool_name}"})
    except Exception as e:  # noqa: BLE001 — agent 工具必须返回结构化错误
        logger.warning(f"[agent-tool] {tool_name} failed: {e!r}")
        return json.dumps({"error": str(e)})
