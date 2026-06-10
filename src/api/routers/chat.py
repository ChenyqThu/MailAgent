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
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from dotenv import dotenv_values

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_chat_db, get_env_file_path, get_settings
from src.chat.kos_save import SaveConversationError, save_conversation_to_kos
from src.chat.notion_agent import run_notion_agent, sse_encode
from src.kos.client import KOSClient, KOSError

router = APIRouter(prefix="/api/chat", tags=["chat"])

# task 06-08-chat 第二波 Bug B — reuse the email-classification context page
# (user profile / Sender Priority / focus projects / 研发课组 / 邮件风格 / 时区)
# for the custom-api chat system prompt. Lazy singleton (NOT a module-level
# instance): ContextLoader imports `src.config.config` at module load, which
# would bypass deps.py's lazy-config discipline and crash import-time when the
# required .env is absent (bare worktree / CI import self-check). The singleton
# still preserves the 1800s TTL cache across /config requests once built.
_context_loader = None  # type: ignore[var-annotated]


def _get_context_loader():
    """Lazily build the ContextLoader singleton (defers the config import)."""
    global _context_loader
    if _context_loader is None:
        from src.llm_agent.context_loader import ContextLoader

        _context_loader = ContextLoader()
    return _context_loader

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


@router.get("/config", dependencies=[Depends(verify_cf_access)])
async def chat_config(request: Request):
    """chat 运行配置快照（V2.1 阶段 3c — renderer 构造 HttpChatPlatform 前预取）。

    serve-api 读 config.py（pydantic env_file → .env）暴露 chat 引擎运行配置；前端
    原样覆盖 DEFAULT_HTTP_CONFIG（D-3c-3：配置以 serve-api 为准）。data 形状 =
    HttpPlatformConfig（frontend/src/shared/chat/http_platform.ts），camelCase 对齐前端。

    ``kosConfigured`` = ``kos_consumer_enabled``（对齐 electron kosConfig().configured =
    isKosConsumerEnabled() —— createBuiltinTools 据此 gate 9 个 KOS 工具注册；**非**
    OAuth 凭据齐的 ``_kos_available``，后者 gate 的是 [✨ 保存到 KOS] 按钮）。
    """
    cfg = get_settings()
    # 归一化对齐 electron chat/config.ts getter 的防御（malformed/empty env 不漂移 ——
    # cutover 后 serve-api 单源，但过渡期 3c-2/3c-3 与 electron getter 并存须等价）：
    #   getMaxIter = max(1, floor(n)); getMaxCostUsd = n>0 ? n : 0.5; getLlmModel '' → fallback。
    # bool 字段：pydantic 已解析（1/true/yes/on → true）。electron readEnvBool 仅 '1'/'true'
    # → true、未设/空 → default、其余非空（含 yes/on）→ false。两者对标准 true/false/1/0
    # 一致，差异仅在 yes/on 等非标准值（罕见）+ cutover 后 serve-api 单源无漂移，不额外归一化
    # （codex 3c-1 review MEDIUM/nit 已记此微差）。
    max_iter = max(1, int(cfg.agent_max_iter))
    max_cost = cfg.agent_max_cost_usd if cfg.agent_max_cost_usd > 0 else 0.5
    default_model = cfg.llm_model or "claude-sonnet-4-6"
    # task 06-08-chat 第二波 Bug B — user context (Notion context page markdown,
    # TTL-cached) injected into the custom-api chat system prompt so the assistant
    # knows the user's role / responsibilities / Sender Priority. Not configured
    # (LLM_CONTEXT_PAGE_ID empty) → "". Fetch failure → "" (graceful, never blocks
    # /config — chat still runs, just without the user profile).
    user_context = ""
    try:
        user_context = await _get_context_loader().get_markdown()
    except Exception:  # noqa: BLE001 — context is best-effort; never fail /config
        user_context = ""
    # enabledModels: hot-read LLM_ENABLED_MODELS from .env (dotenv_values, not pydantic
    # Config) so changes take effect without a serve-api restart — same pattern as
    # 155eb006 (SYNC_FOLDERS hot-read). Best-effort: empty list on any error.
    enabled_models: list = []
    try:
        env_path = get_env_file_path()
        if env_path:
            raw = dotenv_values(env_path).get("LLM_ENABLED_MODELS") or ""
            enabled_models = [m.strip() for m in raw.split(",") if m.strip()]
    except Exception:  # noqa: BLE001 — best-effort; never fail /config
        enabled_models = []
    return success_envelope(
        {
            "maxIter": max_iter,
            "maxCostUsd": max_cost,
            "harnessEnabled": cfg.agent_harness_enabled,
            "kosL1HotBlockEnabled": cfg.kos_l1_hot_block_enabled,
            "defaultModel": default_model,
            "kosConsumerEnabled": cfg.kos_consumer_enabled,
            "kosConfigured": cfg.kos_consumer_enabled,
            "kosTimeDecayEnabled": cfg.kos_time_decay_enabled,
            "userContext": user_context,
            "enabledModels": enabled_models,
        },
        request=request,
        source="config",
    )


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
    except Exception as exc:  # noqa: BLE001 — codex review LOW
        # httpx.InvalidURL（malformed LLM_API_BASE）不是 HTTPError，旧 except httpx.HTTPError
        # 会漏它 → 跳过 aclose 泄漏 + generic 500。broad except 兜底：必 aclose + 502 envelope。
        await client.aclose()
        raise APIError(
            "E_UPSTREAM", f"LLM upstream request failed: {exc}", http_status=502
        )

    # 非 2xx 一律透传 status（空 body），shared 据 response.ok 分类，不泄漏上游 body。
    # codex review MEDIUM：含 3xx —— follow_redirects 默认 False，3xx body 非 SSE，不能当
    # streaming success 转发 redirect body。用 <200 or >=300 覆盖全部非 2xx（仅 2xx passthrough）。
    if upstream_resp.status_code < 200 or upstream_resp.status_code >= 300:
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


@router.post("/notion-agent", dependencies=[Depends(verify_cf_access)])
async def notion_agent(request: Request):
    """notion-agent 多轮对话（V2.1 阶段 3 3b-2）：asyncio spawn ``notion-agent chat --stream``
    复刻 frontend ``notion_agent.ts`` 全语义，输出「语义 event SSE」。

    **非 envelope**（chat 流式端点，对齐 llm-proxy）：成功 → StreamingResponse
    （``text/event-stream``，每个事件一行 ``data: {ChatStreamEvent}\\n\\n``：
    tool_call / chunk / usage / done / error），client 端 ``notionAgentStream``（3b-5）fetch +
    parseSse 反序列化为 ChatStreamEvent —— 与 custom-api 后端在 UI 进程产出的 event 同形。

    req body = ChatStreamRequest 子集 ``{history, model, agentPageId, emailContext}``（去
    signal/tools/iterHistory —— notion-agent CLI 不支持工具，单遍 end_turn）。流内错误（空
    history / spawn 失败 / exit 分类）作 ``error`` 事件随流下发（对齐 TS runNotionAgent），
    仅 body 不可解析（client bug）才 pre-stream APIError envelope。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "notion-agent body must be JSON")
    if not isinstance(payload, dict):
        raise APIError("E_INVALID_ARG", "notion-agent body must be a JSON object")

    async def event_stream():
        async for event in run_notion_agent(payload):
            yield sse_encode(event)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── chat 持久化写端点（V2.1 阶段 3 3b-3：ChatPersistPort 写面）──────────────
#
# serve-api 镜像 chat_db.ts 写函数（ChatDb 写方法 SQL verbatim 镜像）。**envelope**（非 SSE）。
# ai_chat.db schema 归前端 owns（chat_db.ts migrate），serve-api 只写既有表、不建 schema。
# 单读端点（getSession/getMessage/getToolCallByUseId）返 envelope data=row|null（不 404）——
# ChatPersistPort 契约是 ``| null``，null 是正常结果（尤其 getToolCallByUseId「没见过此
# tool_use_id」），区别于 reports.py「找不到=错误」的 404 语义。
# 写校验缺失 → APIError E_INVALID_ARG（malformed JSON 由全局 RequestValidationError handler
# → E_INVALID_ARG）。3b 不接 renderer（http persist 仅 3b-5 mock-fetch 测）→ 生产单 writer。
#
# 路由顺序：静态段（/sessions/new、/sessions/all[阶段2]）须在动态 {id:int} 之前能被匹配；
# ``:int`` 转换器已挡住非 int（"new"/"all" 不匹配 {id:int}），此处顺序兼顾可读性。


@router.post("/sessions", dependencies=[Depends(verify_cf_access)])
async def open_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """getOrCreateSession：复用既有 (emailId,backendKind,pageId) session 或新建。
    镜像 chat:getOrCreateSession → ChatSession。body = OpenSessionInput（camelCase）。"""
    opts = body or {}
    email_id = opts.get("emailId")
    backend_kind = opts.get("backendKind")
    if not isinstance(email_id, int) or isinstance(email_id, bool):
        raise APIError("E_INVALID_ARG", "sessions requires emailId:int", source="sqlite")
    if backend_kind not in ("notion-agent", "custom-api"):
        raise APIError(
            "E_INVALID_ARG",
            "sessions requires backendKind in {notion-agent, custom-api}",
            source="sqlite",
        )
    session = get_chat_db().get_or_create_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
    )
    return success_envelope(session, request=request, source="sqlite")


@router.post("/sessions/new", dependencies=[Depends(verify_cf_access)])
async def new_session(request: Request, body: Optional[Dict[str, Any]] = None):
    """createNewSession：无条件 INSERT 新 session（绕过复用）。镜像 chat:newSession → ChatSession。"""
    opts = body or {}
    email_id = opts.get("emailId")
    backend_kind = opts.get("backendKind")
    if not isinstance(email_id, int) or isinstance(email_id, bool):
        raise APIError("E_INVALID_ARG", "sessions/new requires emailId:int", source="sqlite")
    if backend_kind not in ("notion-agent", "custom-api"):
        raise APIError(
            "E_INVALID_ARG",
            "sessions/new requires backendKind in {notion-agent, custom-api}",
            source="sqlite",
        )
    session = get_chat_db().create_new_session(
        email_id=email_id,
        backend_kind=backend_kind,
        backend_model=opts.get("backendModel"),
        backend_agent_page_id=opts.get("backendAgentPageId"),
    )
    return success_envelope(session, request=request, source="sqlite")


@router.get("/sessions/{session_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_session(request: Request, session_id: int):
    """单 session 行。镜像 chat_db getSession → ChatSession | null（data=null 当不存在，不 404）。"""
    session = get_chat_db().get_session(session_id)
    return success_envelope(session, request=request, source="sqlite")


@router.delete("/sessions/{session_id:int}", dependencies=[Depends(verify_cf_access)])
async def delete_session(request: Request, session_id: int):
    """deleteSession：删整个 session（其消息 + 工具调用经 FK CASCADE 连带删）。镜像 chat_db
    deleteSession（fire-and-forget，删不存在的 id 也返 {deleted: True}）。3c-2 补：cutover 后
    renderer ChatRuntime.deleteSession 经此删（取代 electron chat:deleteSession IPC）。"""
    get_chat_db().delete_session(session_id)
    return success_envelope({"deleted": True}, request=request, source="sqlite")


@router.post("/sessions/{session_id:int}/messages", dependencies=[Depends(verify_cf_access)])
async def append_message(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """appendMessage：INSERT 一条消息 + bump session updated_at。镜像 chat_db appendMessage →
    ChatMessage。body = AppendMessageInput（camelCase，去 sessionId — 取自 path）。"""
    opts = body or {}
    role = opts.get("role")
    content = opts.get("content")
    status = opts.get("status")
    if not isinstance(role, str) or not role:
        raise APIError("E_INVALID_ARG", "messages requires role:str", source="sqlite")
    if not isinstance(content, str):  # "" 合法（NOT NULL 不是 non-empty）
        raise APIError("E_INVALID_ARG", "messages requires content:str", source="sqlite")
    if not isinstance(status, str) or not status:
        raise APIError("E_INVALID_ARG", "messages requires status:str", source="sqlite")
    msg = get_chat_db().append_message(
        session_id=session_id,
        role=role,
        content=content,
        status=status,
        model=opts.get("model"),
        tokens_input=opts.get("tokensInput"),
        tokens_output=opts.get("tokensOutput"),
        cost_usd=opts.get("costUsd"),
        error_message=opts.get("errorMessage"),
        metadata=opts.get("metadata"),
    )
    return success_envelope(msg, request=request, source="sqlite")


@router.patch("/messages/{message_id:int}/stream", dependencies=[Depends(verify_cf_access)])
async def stream_content(
    request: Request, message_id: int, body: Optional[Dict[str, Any]] = None
):
    """streamContent：仅更新 content（流式增量）。镜像 chat_db updateMessage 的 content-only 子集。
    HttpChatPlatform 在此端点上做 debounce（~1/s 合并 PATCH，3b-5）。"""
    opts = body or {}
    content = opts.get("content")
    if not isinstance(content, str):
        raise APIError("E_INVALID_ARG", "stream requires content:str", source="sqlite")
    get_chat_db().update_message(message_id, {"content": content})
    return success_envelope({"ok": True}, request=request, source="sqlite")


@router.patch("/messages/{message_id:int}", dependencies=[Depends(verify_cf_access)])
async def finalize_message(
    request: Request, message_id: int, body: Optional[Dict[str, Any]] = None
):
    """finalizeMessage：终态 patch（status/content/token/cost/model/metadata/error 任意子集）。
    镜像 chat_db updateMessage 全字段。body = UpdateMessagePatch（camelCase；省略的 key 不更新
    = TS undefined 语义）。**缺 body（None / JSON null）→ E_INVALID_ARG**（PATCH 必须带 patch
    对象，对齐写端点「body 校验缺失→E_INVALID_ARG」纪律）；显式空对象 {} → no-op（对齐
    chat_db.ts updateMessage 无字段早返）。codex review LOW。"""
    if body is None:
        raise APIError(
            "E_INVALID_ARG", "messages PATCH requires a patch object body", source="sqlite"
        )
    get_chat_db().update_message(message_id, body)
    return success_envelope({"ok": True}, request=request, source="sqlite")


@router.delete(
    "/sessions/{session_id:int}/messages/from/{from_message_id:int}",
    dependencies=[Depends(verify_cf_access)],
)
async def delete_messages_from(request: Request, session_id: int, from_message_id: int):
    """deleteMessagesFromId：删 from_message_id 及之后所有消息（行内编辑重跑）。镜像 chat_db
    deleteMessagesFromId → {deleted: count}。"""
    count = get_chat_db().delete_messages_from_id(session_id, from_message_id)
    return success_envelope({"deleted": count}, request=request, source="sqlite")


@router.post("/sessions/{session_id:int}/abort", dependencies=[Depends(verify_cf_access)])
async def abort_streaming(request: Request, session_id: int):
    """abortStreamingMessages：把 pending/streaming 消息标 aborted。镜像 chat_db
    abortStreamingMessages → {aborted: count}。"""
    count = get_chat_db().abort_streaming_messages(session_id)
    return success_envelope({"aborted": count}, request=request, source="sqlite")


@router.post("/messages/{message_id:int}/tool-calls", dependencies=[Depends(verify_cf_access)])
async def append_tool_call(
    request: Request, message_id: int, body: Optional[Dict[str, Any]] = None
):
    """appendToolCall：INSERT 一条工具调用审计行。镜像 chat_db appendToolCall → ChatToolCall
    （ChatPersistPort 仅需 .id，返回全行 = 超集）。body = AppendToolCallInput（camelCase，
    去 messageId — 取自 path）。"""
    opts = body or {}
    tool_use_id = opts.get("toolUseId")
    tool_name = opts.get("toolName")
    input_json = opts.get("inputJson")
    confirmation_tier = opts.get("confirmationTier")
    status = opts.get("status")
    if not isinstance(tool_use_id, str) or not tool_use_id:
        raise APIError("E_INVALID_ARG", "tool-calls requires toolUseId:str", source="sqlite")
    if not isinstance(tool_name, str) or not tool_name:
        raise APIError("E_INVALID_ARG", "tool-calls requires toolName:str", source="sqlite")
    if not isinstance(input_json, str):
        raise APIError("E_INVALID_ARG", "tool-calls requires inputJson:str", source="sqlite")
    if not isinstance(confirmation_tier, str) or not confirmation_tier:
        raise APIError(
            "E_INVALID_ARG", "tool-calls requires confirmationTier:str", source="sqlite"
        )
    if not isinstance(status, str) or not status:
        raise APIError("E_INVALID_ARG", "tool-calls requires status:str", source="sqlite")
    # contentOffset（task 06-08-chat Bug 2）= 可选 int（工具卡在 content 里的插入偏移）；
    # 缺省 / null → None（持久化 NULL，前端 degrade 到「工具卡在正文后」）。非 int 拒绝。
    content_offset = opts.get("contentOffset")
    if content_offset is not None and not isinstance(content_offset, int):
        raise APIError(
            "E_INVALID_ARG", "tool-calls contentOffset must be an int", source="sqlite"
        )
    call = get_chat_db().append_tool_call(
        message_id=message_id,
        tool_use_id=tool_use_id,
        tool_name=tool_name,
        input_json=input_json,
        confirmation_tier=confirmation_tier,
        status=status,
        content_offset=content_offset,
    )
    return success_envelope(call, request=request, source="sqlite")


@router.patch("/tool-calls/{tool_call_id:int}", dependencies=[Depends(verify_cf_access)])
async def update_tool_call(
    request: Request, tool_call_id: int, body: Optional[Dict[str, Any]] = None
):
    """updateToolCall：patch 工具调用（status/outputJson/durationMs/userEditedInputJson/
    confirmedAt 任意子集）。镜像 chat_db updateToolCall。**缺 body（None / JSON null）→
    E_INVALID_ARG**（同 finalize_message）；显式空对象 {} → no-op。codex review LOW。"""
    if body is None:
        raise APIError(
            "E_INVALID_ARG",
            "tool-calls PATCH requires a patch object body",
            source="sqlite",
        )
    get_chat_db().update_tool_call(tool_call_id, body)
    return success_envelope({"ok": True}, request=request, source="sqlite")


@router.get(
    "/messages/{message_id:int}/tool-calls/{tool_use_id}",
    dependencies=[Depends(verify_cf_access)],
)
async def get_tool_call_by_use_id(request: Request, message_id: int, tool_use_id: str):
    """单工具调用（by message + tool_use_id）。镜像 chat_db getToolCallByUseId →
    ChatToolCall | null（data=null 当不存在，不 404）。"""
    call = get_chat_db().get_tool_call_by_use_id(message_id, tool_use_id)
    return success_envelope(call, request=request, source="sqlite")


@router.get("/messages/{message_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_message(request: Request, message_id: int):
    """单消息行。镜像 chat_db getMessage → ChatMessage | null（data=null 当不存在，不 404）。"""
    msg = get_chat_db().get_message(message_id)
    return success_envelope(msg, request=request, source="sqlite")


# ── KOS 代理端点（V2.1 阶段 3 3b-4：工具板 kosCallTool / saveToKos 的 http 面）─────────────
#
# 镜像前端 chat 工具板（ChatToolPlatform）KOS 成员：9 KOS 工具全收敛 kosCallTool(name,args)
# → 本端点 → src/kos/client.py KOSClient.call_tool；chat:saveToKos → save-to-kos（复刻
# kos_save.ts：读 chat_db + summarize LLM + put_page）。KOSClient 同步（httpx.Client），用
# run_in_threadpool 避免阻塞 event loop。HttpChatPlatform（3b-5）fetch 这俩端点。
#
# KOSClient 单例（复用 OAuth token cache 跨请求；env KOS_MCP_BASE/CLIENT_ID/SECRET 由 serve-api
# 注入）。与 chat:kosAvailable 的 _kos_available() env 检查同源。

_kos_client_singleton: Optional[KOSClient] = None


def _get_kos_client() -> KOSClient:
    global _kos_client_singleton
    if _kos_client_singleton is None:
        _kos_client_singleton = KOSClient()
    return _kos_client_singleton


@router.post("/kos-call", dependencies=[Depends(verify_cf_access)])
async def kos_call(request: Request):
    """KOS 通用工具代理（3b-4）：``{name, args}`` → KOSClient.call_tool → caller-friendly value。

    镜像前端工具板 kosCallTool（query/put_page/recall/find_experts/get_page/list_skills/
    get_skill/extract_facts 全收敛 tools/call）。data = call_tool 返回（list/dict/str）。KOS 不可达
    → KOSError 转 502 envelope（code=E_KOS_*，前端工具 duck-type 读 code → LLM fallback 本地 FTS5）。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "kos-call body must be JSON")
    if not isinstance(payload, dict):
        raise APIError("E_INVALID_ARG", "kos-call body must be a JSON object")
    name = payload.get("name")
    args = payload.get("args")
    if not isinstance(name, str) or not name:
        raise APIError("E_INVALID_ARG", "kos-call requires name:str")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise APIError("E_INVALID_ARG", "kos-call requires args:object")
    try:
        result = await run_in_threadpool(_get_kos_client().call_tool, name, args)
    except KOSError as e:
        raise APIError(e.code, str(e), http_status=502)
    return success_envelope(result, request=request, source="kos")


@router.post("/save-to-kos", dependencies=[Depends(verify_cf_access)])
async def save_to_kos(request: Request, body: Optional[Dict[str, Any]] = None):
    """chat 一键保存对话到 KOS（3b-4）：复刻 kos_save.ts（读 chat_db + summarize LLM + put_page）。

    body = SaveConversationInput ``{messageId, slug?, title?}``。data = {slug, status, contentBytes}。
    summarize LLM 失败非致命（fallback raw transcript）；校验 / KOS 错误 → 对应 status envelope
    （E_NOT_FOUND→404 / E_INVALID_ARG→400 / E_KOS_*→502）。 """
    opts = body or {}
    message_id = opts.get("messageId")
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 0:
        raise APIError("E_INVALID_ARG", "save-to-kos requires messageId:int (non-negative)")
    slug = opts.get("slug")
    title = opts.get("title")
    cfg = get_settings()
    # saved_at（动态；frontmatter saved_at 行，非字节对齐字段）。ISO 8601 + 真实毫秒 + Z
    # （仿 TS new Date().toISOString()，codex review NIT）。
    _now = datetime.now(timezone.utc)
    saved_at_iso = _now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{_now.microsecond // 1000:03d}Z"
    try:
        result = await run_in_threadpool(
            save_conversation_to_kos,
            chat_db=get_chat_db(),
            kos_client=_get_kos_client(),
            message_id=message_id,
            slug=slug if isinstance(slug, str) and slug else None,
            title=title if isinstance(title, str) and title else None,
            sync_db_path=cfg.sync_store_db_path,
            saved_at_iso=saved_at_iso,
            llm_api_key=(cfg.llm_api_key or "").strip(),
            llm_api_base=(cfg.llm_api_base or ""),
            llm_model=(cfg.llm_model or ""),
        )
    except SaveConversationError as e:
        if e.code == "E_NOT_FOUND":
            status = 404
        elif e.code == "E_INVALID_ARG":
            status = 400
        else:
            status = 502
        raise APIError(e.code, str(e), http_status=status)
    return success_envelope(result, request=request, source="kos")
