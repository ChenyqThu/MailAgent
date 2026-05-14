"""AI Agent 接口 — 多轮 tool_use 对话 + 传统快捷操作。

新端点 /agent/chat 走 SSE 流式多轮 agent；
旧端点 /emails/{id}/agent 和 /agent/query 保留兼容。
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from web.api.agent.loop import agent_stream
from web.api.agent.schemas import ChatRequest
from web.api.agent.session import session_manager
from web.api.config import web_config
from web.api.deps import verify_token

router = APIRouter(dependencies=[Depends(verify_token)])


class AgentRequest(BaseModel):
    action: str  # translate, summarize, draft_reply, custom
    prompt: Optional[str] = None
    context: dict = {}


class QueryRequest(BaseModel):
    prompt: str


SYSTEM_PROMPTS = {
    "translate": "你是一个翻译助手。将以下邮件内容翻译为中文。如果原文已经是中文，则翻译为英文。保持原文格式。只输出翻译结果，不要解释。",
    "summarize": "你是一个邮件摘要助手。用中文提取以下邮件的关键要点，用 bullet points 列出。简洁明了，不超过 5 点。",
    "draft_reply": "你是一个邮件助手。根据以下邮件内容，用中文起草一封简洁专业的回复。保持礼貌但不啰嗦。",
}

# Lazy-init anthropic client（复用主项目配置）
_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client

    if not web_config.llm_api_key:
        raise HTTPException(status_code=503, detail="LLM 未配置（需要 LLM_API_KEY）")

    from anthropic import AsyncAnthropic

    _client = AsyncAnthropic(
        api_key=web_config.llm_api_key,
        base_url=web_config.llm_api_base,
        timeout=web_config.llm_timeout,
        default_headers={
            "User-Agent": "MailAgent-Web/0.1 (Mozilla/5.0 compatible)",
        },
    )
    return _client


def _get_model() -> str:
    return web_config.llm_model


@router.post("/emails/{email_id}/agent")
async def run_agent(email_id: int, req: AgentRequest):
    """调用 LLM 处理邮件相关任务。"""
    if req.action == "custom":
        system = "你是一个智能邮件助手。用中文回答。"
        user_msg = (
            f"邮件主题：{req.context.get('subject', '')}\n\n"
            f"邮件正文：\n{req.context.get('body', '')}\n\n"
            f"用户指令：{req.prompt}"
        )
    elif req.action in SYSTEM_PROMPTS:
        system = SYSTEM_PROMPTS[req.action]
        user_msg = (
            f"邮件主题：{req.context.get('subject', '')}\n\n"
            f"{req.context.get('body', '')}"
        )
    else:
        raise HTTPException(status_code=400, detail=f"未知操作: {req.action}")

    client = _get_client()
    try:
        msg = await client.messages.create(
            model=_get_model(),
            max_tokens=2000,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        result_text = msg.content[0].text
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {e!s}")

    return {"result": result_text, "email_id": email_id, "action": req.action}


@router.post("/agent/query")
async def global_query(req: QueryRequest):
    """全局邮件检索 + LLM 汇总。搜索 SQLite 相关邮件后交给 LLM 回答。"""
    from web.api.services.db import get_db

    # 从用户问题中提取关键词搜索邮件
    search_term = req.prompt.strip()
    with get_db() as conn:
        rows = conn.execute("""
            SELECT em.internal_id, em.subject, em.sender, em.sender_name,
                   em.date_received, em.mailbox,
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
            LIMIT 20
        """, tuple(f"%{search_term}%" for _ in range(5))).fetchall()

    import json as _json

    # 构建上下文摘要
    email_summaries: list[str] = []
    for r in rows:
        labels = {}
        try:
            labels = _json.loads(r["labels_json"] or "{}")
        except Exception:
            pass
        summary = labels.get("ai_summary", "")
        category = labels.get("category", "")
        priority = labels.get("priority", "")
        line = (
            f"- [{r['date_received'] or ''}] {r['subject'] or '(无主题)'} "
            f"| 发件人: {r['sender_name'] or r['sender'] or '未知'} "
            f"| 邮箱: {r['mailbox'] or ''}"
        )
        if category:
            line += f" | 分类: {category}"
        if priority:
            line += f" | 优先级: {priority}"
        if summary:
            line += f" | 摘要: {summary}"
        email_summaries.append(line)

    if not email_summaries:
        return {"result": f"未找到与「{search_term}」相关的邮件", "sources": 0}

    context_block = "\n".join(email_summaries)
    system = (
        "你是一个邮件数据分析助手。用中文回答。"
        "根据以下邮件检索结果回答用户的问题。"
        "如果检索结果不能完全回答问题，说明已知信息并指出不足。"
        "回答要简洁有结构。"
    )
    user_msg = (
        f"检索到 {len(email_summaries)} 封相关邮件:\n\n"
        f"{context_block}\n\n"
        f"用户问题: {req.prompt}"
    )

    client = _get_client()
    try:
        msg = await client.messages.create(
            model=_get_model(),
            max_tokens=2000,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        result_text = msg.content[0].text
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {e!s}")

    return {"result": result_text, "sources": len(email_summaries)}


# ---------------------------------------------------------------------------
# 新 Agent 端点 — 多轮 tool_use + SSE 流式
# ---------------------------------------------------------------------------


@router.post("/agent/chat")
async def agent_chat(req: ChatRequest):
    """多轮 Agent 对话，SSE 流式返回。"""
    if not web_config.llm_api_key:
        raise HTTPException(status_code=503, detail="LLM 未配置（需要 LLM_API_KEY）")

    session = session_manager.get_or_create(req.session_id, req.email_context)

    async def event_stream():
        # 先发 session_id 事件
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
    """格式化 SSE 行。"""
    payload = json.dumps({"type": event_type, **data}, ensure_ascii=False)
    return f"data: {payload}\n\n"
