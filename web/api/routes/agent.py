"""AI Agent 接口 — 多轮 tool_use 流式对话。"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from web.api.agent.loop import agent_stream
from web.api.agent.schemas import ChatRequest
from web.api.agent.session import session_manager
from web.api.config import web_config
from web.api.deps import verify_token

router = APIRouter(dependencies=[Depends(verify_token)])


@router.post("/agent/chat")
async def agent_chat(req: ChatRequest):
    """多轮 Agent 对话，SSE 流式返回。"""
    if not web_config.llm_api_key:
        raise HTTPException(status_code=503, detail="LLM 未配置（需要 LLM_API_KEY）")

    session = session_manager.get_or_create(req.session_id, req.email_context)

    async def event_stream():
        yield _sse_line("session", {"session_id": session.session_id})
        async for event in agent_stream(session, req.message):
            yield _sse_line(event.type, event.data)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/agent/session/{session_id}/history")
async def get_session_history(session_id: str):
    """恢复会话历史消息（重启后前端用）。"""
    sess = session_manager.get_or_create(session_id)
    if not sess.messages:
        return {"session_id": session_id, "messages": []}

    result: list[dict] = []
    for msg in sess.messages:
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "user":
            if isinstance(content, list):
                # tool_result 消息也是 role=user，跳过
                continue
            result.append({"role": "user", "content": content})

        elif role == "assistant":
            text = ""
            tool_calls = []
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            text += block.get("text", "")
                        elif block.get("type") == "tool_use":
                            tool_calls.append({
                                "tool": block.get("name", ""),
                                "toolUseId": block.get("id", ""),
                                "pending": False,
                            })
            result.append({"role": "assistant", "content": text, "toolCalls": tool_calls})

    return {"session_id": session_id, "messages": result}


@router.delete("/agent/session/{session_id}")
async def delete_session(session_id: str):
    """清除指定会话。"""
    deleted = session_manager.delete(session_id)
    return {"deleted": deleted, "session_id": session_id}


@router.get("/agent/sessions")
async def list_sessions():
    """调试用：返回活跃会话数量。"""
    return {"active_sessions": session_manager.count()}


def _sse_line(event_type: str, data: dict) -> str:
    payload = json.dumps({"type": event_type, **data}, ensure_ascii=False)
    return f"data: {payload}\n\n"
