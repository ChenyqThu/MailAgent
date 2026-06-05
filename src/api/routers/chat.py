"""chat 路由 — /api/chat/* (V2.1 远程 chat 历史只读 [阶段 2] + 对话 [阶段 3])。

**阶段 2（本次）**：5 读端点，镜像本地 IPC ``handlers/chat.ts`` 的 listSessions /
listAllSessions / listMessages / listToolCalls / kosAvailable。读 ai_chat.db
（``src/chat/db.py``，serve-api 新连）+ listAllSessions join sync_store.db
email_metadata（subject/sender，best-effort）。形状对齐前端 ChatSession /
ChatSessionSummary / ChatSessionListItem / ChatMessage / ChatToolCall（``types.ts``）。

**阶段 3（后续，B-pure-unified）**：llm-proxy / chat 持久化 / notion-agent spawn /
写工具端点 —— harness 在 browser 跑，serve-api 退化为数据/代理面。

鉴权：所有端点 ``Depends(verify_cf_access)``。读 graceful（库不存在/锁 → []）。
"""

from __future__ import annotations

import os
import sqlite3
from typing import Any, Dict, List

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response, StreamingResponse

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db, get_settings

router = APIRouter(prefix="/api/chat", tags=["chat"])

# 3b-1：CRS/Cloudflare 挑剔 UA（mirror custom_api.ts / electron_platform.ts llmFetch 注入侧）。
_CRS_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/146.0.0.0 Safari/537.36"
)
# 上游 LLM 流式 deadline（与 shared custom_api REQUEST_DEADLINE_MS=60s 对齐；read 给足长
# 流式，connect/write 短）。
_LLM_PROXY_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


def _kos_available() -> bool:
    """KOS OAuth 凭据齐全（对齐前端 ``isKosSaveAvailable`` / chat:kosAvailable）。

    三 env 都非空才算可用 —— 决定远程 [✨ 保存到 KOS] 按钮是否渲染。
    """
    return bool(
        os.environ.get("KOS_MCP_BASE")
        and os.environ.get("KOS_OAUTH_CLIENT_ID")
        and os.environ.get("KOS_OAUTH_CLIENT_SECRET")
    )


def _email_meta_for_sessions(
    email_ids: List[int], sync_db_path: str
) -> Dict[int, Dict[str, Any]]:
    """批量取 session 所属邮件的 subject/sender（join sync_store.db email_metadata）。

    best-effort：sync_store.db 不可用 / FDA 未授权 → 空 map（端点降级 nulls），
    对齐 chat:listAllSessions「降级 preview-only 行」。
    """
    if not email_ids:
        return {}
    # serve-api 只读：库不存在直接短路，不让 connect 建空库（与 ChatDb._read_all 一致）。
    if not os.path.exists(sync_db_path):
        return {}
    meta: Dict[int, Dict[str, Any]] = {}
    try:
        conn = sqlite3.connect(sync_db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" * len(email_ids))
            rows = conn.execute(
                f"SELECT internal_id, subject, sender_name, sender FROM email_metadata "
                f"WHERE internal_id IN ({placeholders})",
                email_ids,
            ).fetchall()
            for r in rows:
                # sender_name ?? sender（对齐 chat.ts：仅 NULL 回退 sender，空字符串 "" 保留）。
                sender_name = r["sender_name"]
                meta[r["internal_id"]] = {
                    "subject": r["subject"],
                    "sender": sender_name if sender_name is not None else r["sender"],
                }
        finally:
            conn.close()
    except sqlite3.Error:
        pass
    return meta


# 注意路由顺序：静态 /sessions/all 在动态 /sessions/{id}/messages 之前声明。后者 {session_id:int}
# 约束已能挡住 "all"（非 int 不匹配），此处顺序仅为可读性 + 双保险。


@router.get("/sessions/all", dependencies=[Depends(verify_cf_access)])
async def list_all_sessions(request: Request):
    """跨邮件 session 历史（含 first_user_message 预览 + message_count + join email
    subject/sender）。镜像 chat:listAllSessions → ChatSessionListItem[]。"""
    summaries = get_chat_db().list_all_sessions()
    email_ids = list({s["email_id"] for s in summaries})
    # email_ids 空（无 session）时不调 get_settings()（省 config 访问，codex review）。
    meta = (
        _email_meta_for_sessions(email_ids, get_settings().sync_store_db_path)
        if email_ids
        else {}
    )
    items = [
        {
            **s,
            "email_subject": meta.get(s["email_id"], {}).get("subject"),
            "email_sender": meta.get(s["email_id"], {}).get("sender"),
        }
        for s in summaries
    ]
    return success_envelope(
        items, request=request, source="sqlite", meta_extra={"count": len(items)}
    )


@router.get("/sessions", dependencies=[Depends(verify_cf_access)])
async def list_sessions(request: Request, email_id: int = Query(..., alias="emailId")):
    """某邮件的 chat sessions（按 updated_at 倒序）。镜像 chat:listSessions → ChatSession[]。"""
    sessions = get_chat_db().list_sessions_for_email(email_id)
    return success_envelope(
        sessions, request=request, source="sqlite", meta_extra={"count": len(sessions)}
    )


@router.get("/sessions/{session_id:int}/messages", dependencies=[Depends(verify_cf_access)])
async def list_messages(request: Request, session_id: int):
    """某 session 的全部消息（按 created_at/id 升序）。镜像 chat:listMessages → ChatMessage[]。"""
    messages = get_chat_db().list_messages(session_id)
    return success_envelope(
        messages, request=request, source="sqlite", meta_extra={"count": len(messages)}
    )


@router.get("/messages/{message_id:int}/tool-calls", dependencies=[Depends(verify_cf_access)])
async def list_tool_calls(request: Request, message_id: int):
    """某 assistant 消息的工具调用审计。镜像 chat:listToolCalls → ChatToolCall[]。无 tool_use 返 []。"""
    calls = get_chat_db().list_tool_calls_for_message(message_id)
    return success_envelope(
        calls, request=request, source="sqlite", meta_extra={"count": len(calls)}
    )


@router.get("/kos-available", dependencies=[Depends(verify_cf_access)])
async def kos_available(request: Request):
    """KOS 可用性（OAuth 凭据齐全）。镜像 chat:kosAvailable → boolean。"""
    return success_envelope(_kos_available(), request=request, source="sqlite")


@router.post("/llm-proxy", dependencies=[Depends(verify_cf_access)])
async def llm_proxy(request: Request):
    """custom-api LLM 上游代理（V2.1 阶段 3 3b-1）：注入 key + 透传原始 SSE。

    **非 envelope**（chat 端点唯一例外）：成功 → StreamingResponse（text/event-stream，
    原始上游 SSE 字节流，shared custom_api 在 UI 进程解析）；上游非 2xx → 透传 status（空
    body，shared 据 response.ok 分类 E_QUOTA/E_UPSTREAM，不泄漏上游错误页 body）。key 注入
    在此（永不进 renderer/browser，REVIEW-LOG C-04）。

    req body = ``{protocol: 'anthropic'|'openai', body: {…上游请求体…}}``；body 由 shared
    custom_api 构造（model/max_tokens/system/messages/tools/stream:true）。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "llm-proxy body must be JSON")
    protocol = payload.get("protocol") if isinstance(payload, dict) else None
    upstream_body = payload.get("body") if isinstance(payload, dict) else None
    if protocol not in ("anthropic", "openai") or not isinstance(upstream_body, dict):
        raise APIError(
            "E_INVALID_ARG",
            "llm-proxy requires {protocol: 'anthropic'|'openai', body: object}",
        )

    cfg = get_settings()
    api_key = (cfg.llm_api_key or "").strip()
    if not api_key:
        raise APIError("E_NO_LLM_KEY", "LLM_API_KEY not configured on serve-api host")
    base_url = (cfg.llm_api_base or "").rstrip("/")
    if protocol == "anthropic":
        url = f"{base_url}/v1/messages"
        headers = {
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "user-agent": _CRS_USER_AGENT,
        }
    else:
        url = f"{base_url}/v1/chat/completions"
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        }

    client = httpx.AsyncClient(timeout=_LLM_PROXY_TIMEOUT)
    try:
        upstream_req = client.build_request(
            "POST", url, json=upstream_body, headers=headers
        )
        upstream_resp = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        # 上游连接失败 → 502（shared 据 !response.ok 归 E_UPSTREAM）。
        raise APIError(
            "E_UPSTREAM", f"LLM upstream connect failed: {exc}", http_status=502
        )

    # 上游非 2xx：透传 status（空 body），shared 据 response.ok 分类，不泄漏上游错误页。
    if upstream_resp.status_code >= 400:
        status = upstream_resp.status_code
        await upstream_resp.aclose()
        await client.aclose()
        return Response(status_code=status)

    async def passthrough():
        # aiter_bytes 解 content-encoding → 明文 SSE（shared TextDecoder 解 UTF-8）。
        try:
            async for chunk in upstream_resp.aiter_bytes():
                yield chunk
        finally:
            await upstream_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        passthrough(),
        status_code=upstream_resp.status_code,
        media_type="text/event-stream",
    )
