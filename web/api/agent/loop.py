"""Agent 主循环 — 多轮 tool_use + SSE 流式输出。

核心流程:
1. 拼 system prompt（身份 + 时间 + context + 邮件上下文）
2. 调 Anthropic Messages API (stream=True)
3. 流式 yield SSE 事件（text_delta / tool_start / tool_result / done）
4. 遇到 tool_use → 本地执行 → 结果拼回 messages → 继续下一轮
5. stop_reason=="end_turn" 或达到最大轮次 → 结束
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

from loguru import logger

from web.api.config import web_config

from .schemas import EmailContext, SSEEvent
from .session import Session, session_manager
from .tools import TOOL_SCHEMAS, execute_tool

_MAX_TURNS = 8
_MAX_TOKENS = 4000
_PROMPT_PATH = Path(__file__).parent / "system_prompt.md"

# Lazy-init
_client = None
_prompt_text: str | None = None
_prompt_mtime: float = 0


def _get_client():
    global _client
    if _client is not None:
        return _client

    from anthropic import AsyncAnthropic

    _client = AsyncAnthropic(
        api_key=web_config.llm_api_key,
        base_url=web_config.llm_api_base,
        timeout=web_config.llm_timeout,
        default_headers={
            "User-Agent": "MailAgent-WebAgent/0.1 (Mozilla/5.0 compatible)",
        },
    )
    return _client


def _load_prompt() -> str:
    """读取 system_prompt.md，带 mtime 热重载。"""
    global _prompt_text, _prompt_mtime
    try:
        mt = _PROMPT_PATH.stat().st_mtime
        if _prompt_text is None or mt != _prompt_mtime:
            _prompt_text = _PROMPT_PATH.read_text("utf-8")
            _prompt_mtime = mt
            logger.info(f"[agent] loaded system_prompt.md ({len(_prompt_text)} chars)")
    except FileNotFoundError:
        if _prompt_text is None:
            _prompt_text = "你是邮件 AI 助手。"
    return _prompt_text  # type: ignore[return-value]


def _build_system(email_ctx: Optional[EmailContext] = None) -> str:
    """构建 system prompt。"""
    now = time.strftime("%Y-%m-%d %H:%M %A", time.localtime())

    parts = [
        _load_prompt(),
        "",
        f"当前时间: {now}",
    ]

    if email_ctx:
        parts.extend([
            "",
            "## 当前选中邮件",
            f"- 主题: {email_ctx.subject}",
            f"- 发件人: {email_ctx.sender_name} <{email_ctx.sender}>",
            f"- 日期: {email_ctx.date}",
            f"- 邮箱: {email_ctx.mailbox}",
            f"- internal_id: {email_ctx.internal_id}",
        ])
        if email_ctx.thread_id:
            parts.append(f"- thread_id: {email_ctx.thread_id}")
        if email_ctx.body:
            body_preview = email_ctx.body[:3000]
            parts.extend(["", "### 邮件正文预览", body_preview])

    return "\n".join(parts)


async def agent_stream(
    session: Session,
    user_msg: str,
) -> AsyncGenerator[SSEEvent, None]:
    """Agent 主循环，yield SSE 事件。"""
    client = _get_client()
    model = web_config.llm_model

    system = _build_system(session.email_context)

    # 追加用户消息到 session
    session.messages.append({"role": "user", "content": user_msg})

    for turn in range(_MAX_TURNS):
        # 流式调用 LLM
        collected_text = ""
        tool_uses: list[dict[str, Any]] = []

        try:
            async with client.messages.stream(
                model=model,
                max_tokens=_MAX_TOKENS,
                system=system,
                messages=session.messages,
                tools=TOOL_SCHEMAS,
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_start":
                        block = event.content_block
                        if block.type == "tool_use":
                            tool_uses.append({
                                "id": block.id,
                                "name": block.name,
                                "input_json": "",
                            })
                            yield SSEEvent(
                                type="tool_start",
                                data={"tool": block.name, "tool_use_id": block.id},
                            )

                    elif event.type == "content_block_delta":
                        delta = event.delta
                        if delta.type == "text_delta":
                            collected_text += delta.text
                            yield SSEEvent(
                                type="text_delta",
                                data={"text": delta.text},
                            )
                        elif delta.type == "input_json_delta":
                            if tool_uses:
                                tool_uses[-1]["input_json"] += delta.partial_json

                # 获取最终消息
                final_message = await stream.get_final_message()

        except Exception as e:
            logger.error(f"[agent-loop] LLM call failed: {e!r}")
            yield SSEEvent(type="error", data={"message": f"LLM 调用失败: {e!s}"})
            return

        # 记录 assistant 消息（手动构建，避免 model_dump 带 None 值导致 SDK 校验失败）
        content_blocks = []
        for cb in final_message.content:
            if cb.type == "text":
                content_blocks.append({"type": "text", "text": cb.text})
            elif cb.type == "tool_use":
                content_blocks.append({
                    "type": "tool_use",
                    "id": cb.id,
                    "name": cb.name,
                    "input": cb.input,
                })
        session.messages.append({
            "role": "assistant",
            "content": content_blocks,
        })

        # 检查是否需要执行工具
        if final_message.stop_reason == "tool_use" and tool_uses:
            tool_results: list[dict[str, Any]] = []
            for tu in tool_uses:
                try:
                    tool_input = json.loads(tu["input_json"]) if tu["input_json"] else {}
                except json.JSONDecodeError:
                    tool_input = {}

                result_str = await execute_tool(tu["name"], tool_input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu["id"],
                    "content": result_str,
                })

                # 发送 tool_result 事件给前端
                # 解析结果，提取摘要给前端显示
                try:
                    result_data = json.loads(result_str)
                except json.JSONDecodeError:
                    result_data = {"raw": result_str}

                yield SSEEvent(
                    type="tool_result",
                    data={
                        "tool": tu["name"],
                        "tool_use_id": tu["id"],
                        "summary": _tool_result_summary(tu["name"], result_data),
                    },
                )

            # 将 tool results 追加到 messages
            session.messages.append({"role": "user", "content": tool_results})
            continue  # 下一轮

        # 没有 tool_use → 结束
        break

    session_manager.save(session)
    yield SSEEvent(type="done", data={"turns": turn + 1})


def _tool_result_summary(tool_name: str, data: dict[str, Any]) -> str:
    """为前端生成工具结果的简短摘要。"""
    if "error" in data:
        return f"错误: {data['error']}"

    if tool_name == "search_emails":
        count = data.get("count", 0)
        return f"找到 {count} 封邮件"

    if tool_name == "read_email_body":
        total = data.get("total_chars", 0)
        return f"已读取正文 ({total} 字符)"

    if tool_name == "get_thread_context":
        count = data.get("count", 0)
        return f"线程包含 {count} 封邮件"

    if tool_name == "get_sender_stats":
        total = data.get("total_30d", 0)
        return f"30 天内 {total} 封邮件"

    if tool_name == "search_by_date":
        count = data.get("count", 0)
        return f"找到 {count} 封邮件"

    if tool_name == "get_email_ai_labels":
        labels = data.get("labels", {})
        priority = labels.get("priority", "")
        category = labels.get("category", "")
        parts = []
        if priority:
            parts.append(f"优先级: {priority}")
        if category:
            parts.append(f"分类: {category}")
        return " | ".join(parts) if parts else "已获取标签"

    if tool_name == "get_view_summary":
        total = data.get("total", 0)
        showing = data.get("showing", 0)
        return f"共 {total} 封，返回 {showing} 封"

    if tool_name == "batch_action":
        count = data.get("count", len(data.get("processed", [])))
        action = data.get("action", "")
        return f"已执行 {action}，处理 {count} 封"

    return "完成"
