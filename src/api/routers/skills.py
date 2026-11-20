"""skills 路由 —— /api/skills (manifest) + /api/skills/invoke (统一调用面) + /mcp (MCP over HTTP/SSE)。

对外 agent（OpenClaw / Claude Code / MCP client）经 scoped Bearer key 调 MailAgent 能力的
唯一表面。鉴权用 ``authenticate_principal``（四腿 dev→local→bearer→CF）；**只有本路由认
Bearer key** —— 其余写端点对 agent key 天然 401，越权 by construction 不可达。

invoke 主路径 **不 fork 子进程调 CLI**（BASE-1；E2-C 起 serve-api 全线退役该模式，
不止本路由）：``invoke_skill`` 走 ``src/skills`` registry → handler 调 services /
repository / ReportStore / run_report_once / notion_agent。

MCP 传输（JSON-RPC 分派复用 ``mailagent_mcp.handle_request``，鉴权同 ``/api/skills``）：
  - ``POST /mcp``：无 ``Mcp-Session-Id`` 非 ``initialize`` 保持 100% 无状态向后兼容；
    ``initialize`` 签发绑定 principal 的 ``Mcp-Session-Id``，携带该 header 的调用校验所有权
    并支持 ``Accept: text/event-stream``。
  - ``GET /mcp`` / ``DELETE /mcp``：有状态 SSE 下行流（15s keepalive）与显式关停会话。
  - ``GET /mcp/sse`` + ``POST /mcp/messages``：Legacy MCP HTTP+SSE 传输，绑定 principal 会话。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from src.api.agent_auth import Principal, authenticate_principal
from src.api.app import APIError, success_envelope
from src.api.deps import get_report_store, get_repository, get_settings
from src.mcp.http_sessions import (
    TRANSPORT_LEGACY_SSE,
    TRANSPORT_STREAMABLE_HTTP,
    McpHttpSession,
    McpSessionManager,
    SessionClosedError,
    get_mcp_session_manager,
)
from src.mcp.mailagent_mcp import PrincipalSkillClient, handle_request
from src.security import api_keys as _api_keys
from src.skills.context import SkillContext
from src.skills.errors import SkillError
from src.skills.invoke import invoke_skill
from src.skills.registry import build_manifest

if TYPE_CHECKING:
    from src.config import Config
    from src.reports.store import ReportStore
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/skills", tags=["skills"])
mcp_router = APIRouter(tags=["mcp"])
_log = logging.getLogger("mailagent.api.skills")


def _audit(
    principal: Principal,
    *,
    skill: Optional[str],
    tool: Optional[str],
    status: str,
    error_code: Optional[str],
    t0: float,
    route: str = "/api/skills/invoke",
) -> None:
    """agent principal 调用记一行 audit + last_used（human owner 不记）。失败吞掉不阻断响应。"""
    if not getattr(principal, "is_agent", False) or not principal.key_id:
        return
    try:
        _api_keys.get_api_key_store().write_audit(
            route=route,
            status=status,
            key_id=principal.key_id,
            skill=skill,
            tool=tool,
            scopes=sorted(principal.scopes or set()),
            error_code=error_code,
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
    except Exception:  # noqa: BLE001 — audit best-effort，不能因审计失败而吞掉调用结果
        _log.warning("agent api-key audit write failed (key_id=%s, tool=%s.%s)", principal.key_id, skill, tool)


@router.get("", dependencies=[])
async def list_skills(
    request: Request,
    principal: Principal = Depends(authenticate_principal),
):
    """返回当前 principal 可见的 Skill manifest v1（按 scopes 过滤 tool）。"""
    manifest = build_manifest(principal)
    return success_envelope(
        manifest.model_dump(),
        request=request,
        source="sqlite",
        meta_extra={"skills": len(manifest.skills)},
    )


@router.post("/invoke")
async def invoke(
    request: Request,
    body: Optional[dict[str, Any]] = None,
    principal: Principal = Depends(authenticate_principal),
    repo: "EmailRepository" = Depends(get_repository),
    report_store: "ReportStore" = Depends(get_report_store),
    cfg: "Config" = Depends(get_settings),
):
    """调用一个 skill tool。body = {skill, tool, input?, confirm?}。返回统一 envelope。

    SkillContext 经 FastAPI deps 注入（repo/store/config）—— 测试可经 dependency_overrides
    指向临时 DB，与既有 email/reports 路由一致。
    """
    raw = body or {}
    skill = raw.get("skill")
    tool = raw.get("tool")
    params = raw.get("input") or {}
    # 🔴 confirm 必须是真布尔，**不做** truthiness 转换（codex blocker）：拒 "false"/"true"/1 等
    # 非布尔值，免得字符串 "false" 被当成已确认击穿发信确认闸。缺省 False。
    confirm = raw.get("confirm", False)
    if not isinstance(confirm, bool):
        raise APIError("E_INVALID_ARG", "body.confirm must be a JSON boolean", source="cli")
    if not isinstance(skill, str) or not isinstance(tool, str):
        raise APIError("E_INVALID_ARG", "body.skill and body.tool are required strings", source="cli")
    if not isinstance(params, dict):
        raise APIError("E_INVALID_ARG", "body.input must be an object", source="cli")

    ctx = SkillContext(repository=repo, report_store=report_store, config=cfg)
    t0 = time.perf_counter()
    try:
        result = await invoke_skill(principal, skill, tool, params, confirm=confirm, ctx=ctx)
    except SkillError as exc:
        _audit(principal, skill=skill, tool=tool, status="error", error_code=exc.code, t0=t0)
        raise APIError(
            exc.code, exc.message, hint=exc.hint, http_status=exc.http_status, source="cli"
        ) from exc

    _audit(principal, skill=skill, tool=tool, status="ok", error_code=None, t0=t0)
    return success_envelope(
        result, request=request, source="cli", meta_extra={"skill": skill, "tool": tool}
    )


def _jsonrpc_error(code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": message}}


_SAFE_PATH_PREFIX_RE = re.compile(r"^/(?:[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)?/?$")


def _normalize_path_prefix(raw: Optional[str]) -> str:
    """Strict path-only sanitizer for X-Forwarded-Prefix / ASGI root_path (no CRLF/scheme/host)."""
    if not raw or not isinstance(raw, str):
        return ""
    if any(ch in raw for ch in ("\r", "\n", "\x00")):
        return ""
    candidate = raw.strip()
    if not candidate or candidate.startswith("//") or "://" in candidate:
        return ""
    if not _SAFE_PATH_PREFIX_RE.fullmatch(candidate):
        return ""
    parts = [p for p in candidate.split("/") if p]
    if any(p in (".", "..") for p in parts):
        return ""
    if not parts:
        return ""
    return "/" + "/".join(parts)


def _resolve_sse_prefix(request: Request) -> str:
    forwarded = _normalize_path_prefix(request.headers.get("x-forwarded-prefix"))
    root_path = _normalize_path_prefix(request.scope.get("root_path"))
    if forwarded and root_path:
        if forwarded == root_path or forwarded.endswith(root_path):
            return forwarded
        return f"{forwarded}{root_path}"
    return forwarded or root_path


def _prefers_sse(request: Request) -> bool:
    """Return True when Accept explicitly requests/prefers text/event-stream over application/json."""
    accept = (request.headers.get("accept") or "").strip()
    if not accept:
        return False
    json_score: Optional[tuple[float, int]] = None
    sse_score: Optional[tuple[float, int]] = None
    for idx, raw_part in enumerate(accept.split(",")):
        part = raw_part.strip()
        if not part:
            continue
        segs = [s.strip() for s in part.split(";")]
        media = segs[0].lower()
        q = 1.0
        for param in segs[1:]:
            if param.lower().startswith("q="):
                try:
                    q = max(0.0, min(1.0, float(param[2:].strip())))
                except ValueError:
                    q = 0.0
                break
        if q == 0.0:
            continue
        score = (q, -idx)
        if media == "text/event-stream":
            if sse_score is None or score > sse_score:
                sse_score = score
        elif media == "application/json":
            if json_score is None or score > json_score:
                json_score = score
    if sse_score is None:
        return False
    if json_score is None:
        return True
    return sse_score > json_score


def _sse_event(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


def _sse_jsonrpc_response(
    payload: Any,
    *,
    headers: Optional[dict[str, str]] = None,
) -> Response:
    items = payload if isinstance(payload, list) else [payload]
    body = "".join(
        _sse_event("message", json.dumps(item, ensure_ascii=False)) for item in items
    )
    resp_headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    if headers:
        resp_headers.update(headers)
    return Response(
        content=body,
        status_code=200,
        media_type="text/event-stream",
        headers=resp_headers,
    )


def _make_mcp_client(
    principal: Principal,
    repo: "EmailRepository",
    report_store: "ReportStore",
    cfg: "Config",
    *,
    route: str,
) -> PrincipalSkillClient:
    def _on_call(skill: str, tool: str, error_code: Optional[str], t0: float) -> None:
        _audit(
            principal,
            skill=skill,
            tool=tool,
            status="error" if error_code else "ok",
            error_code=error_code,
            t0=t0,
            route=route,
        )

    ctx = SkillContext(repository=repo, report_store=report_store, config=cfg)
    return PrincipalSkillClient(principal, ctx, on_call=_on_call)


async def _dispatch_jsonrpc_payload(
    payload: Any,
    client: PrincipalSkillClient,
) -> Any:
    async def _one(msg: Any) -> Optional[dict[str, Any]]:
        if not isinstance(msg, dict):
            return _jsonrpc_error(-32600, "invalid request")
        if "method" not in msg:
            return None  # 客户端发来的 JSON-RPC response，本 server 不发请求，直接接收
        return await handle_request(msg, client)

    if isinstance(payload, list):
        return [r for r in [await _one(m) for m in payload] if r is not None]
    return await _one(payload)


async def _stream_session_events(
    request: Request,
    mgr: McpSessionManager,
    session: McpHttpSession,
    *,
    initial_events: tuple[str, ...] = (),
    close_on_exit: bool = False,
) -> AsyncIterator[str]:
    try:
        for frame in initial_events:
            yield frame
        while not session.closed:
            if await request.is_disconnected():
                break
            try:
                msg = await asyncio.wait_for(
                    session.queue.get(),
                    timeout=mgr.keepalive_interval_seconds,
                )
            except asyncio.TimeoutError:
                if await request.is_disconnected() or session.closed or mgr.is_expired(session):
                    break
                yield ": keepalive\n\n"
                continue
            if msg is None:
                break
            mgr.touch(session)
            yield _sse_event("message", json.dumps(msg, ensure_ascii=False))
    except asyncio.CancelledError:
        raise
    finally:
        if close_on_exit:
            mgr.close_session_by_id(session.session_id)


def _has_initialize_call(payload: Any) -> bool:
    if isinstance(payload, dict):
        return payload.get("method") == "initialize"
    if isinstance(payload, list):
        return any(isinstance(item, dict) and item.get("method") == "initialize" for item in payload)
    return False


def _has_initialize_result(response_payload: Any) -> bool:
    if isinstance(response_payload, dict):
        return "result" in response_payload
    if isinstance(response_payload, list):
        return any(isinstance(item, dict) and "result" in item for item in response_payload)
    return False


@mcp_router.post("/mcp")
async def mcp_post(
    request: Request,
    principal: Principal = Depends(authenticate_principal),
    repo: "EmailRepository" = Depends(get_repository),
    report_store: "ReportStore" = Depends(get_report_store),
    cfg: "Config" = Depends(get_settings),
):
    """Streamable HTTP POST `/mcp`：无状态向后兼容 + 有状态 `Mcp-Session-Id` 会话。"""
    has_session_header = "mcp-session-id" in request.headers
    sid = (request.headers.get("mcp-session-id") or "").strip()
    mgr = get_mcp_session_manager(request.app)

    if has_session_header:
        session = mgr.get_owned(sid, principal, transport_kind=TRANSPORT_STREAMABLE_HTTP)
        if session is None:
            raise HTTPException(status_code=404, detail="session not found")

    try:
        payload = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(_jsonrpc_error(-32700, "parse error"))

    client = _make_mcp_client(principal, repo, report_store, cfg, route="/mcp")
    result = await _dispatch_jsonrpc_payload(payload, client)

    is_empty = (isinstance(result, list) and not result) or (result is None)
    if is_empty:
        return Response(status_code=202)

    resp_headers: dict[str, str] = {}
    if not has_session_header and _has_initialize_call(payload) and _has_initialize_result(result):
        created = mgr.create_session(principal, transport_kind=TRANSPORT_STREAMABLE_HTTP)
        resp_headers["Mcp-Session-Id"] = created.session_id

    if _prefers_sse(request):
        return _sse_jsonrpc_response(result, headers=resp_headers or None)
    return JSONResponse(result, headers=resp_headers or None)


@mcp_router.get("/mcp")
async def mcp_get(request: Request) -> Response:
    """Streamable HTTP GET `/mcp`：建立会话下行 SSE 流。"""
    principal = await authenticate_principal(request)
    sid = (request.headers.get("mcp-session-id") or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="Mcp-Session-Id header is required")

    mgr = get_mcp_session_manager(request.app)
    session = mgr.get_owned(sid, principal, transport_kind=TRANSPORT_STREAMABLE_HTTP)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    return StreamingResponse(
        _stream_session_events(request, mgr, session, close_on_exit=False),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@mcp_router.delete("/mcp")
async def mcp_delete(request: Request) -> Response:
    """Streamable HTTP DELETE `/mcp`：校验归属后关停 SSE 流并删除会话。"""
    principal = await authenticate_principal(request)
    sid = (request.headers.get("mcp-session-id") or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="Mcp-Session-Id header is required")

    mgr = get_mcp_session_manager(request.app)
    if not mgr.delete_owned(sid, principal, transport_kind=TRANSPORT_STREAMABLE_HTTP):
        raise HTTPException(status_code=404, detail="session not found")
    return Response(status_code=204)


@mcp_router.get("/mcp/sse")
async def mcp_legacy_sse(
    request: Request,
    principal: Principal = Depends(authenticate_principal),
) -> Response:
    """Legacy MCP HTTP+SSE 建连端点：签发 `endpoint` 事件并推下行 JSON-RPC 消息流。"""
    mgr = get_mcp_session_manager(request.app)
    session = mgr.create_session(principal, transport_kind=TRANSPORT_LEGACY_SSE)
    prefix = _resolve_sse_prefix(request)
    endpoint_event = _sse_event("endpoint", f"{prefix}/mcp/messages?session_id={session.session_id}")
    return StreamingResponse(
        _stream_session_events(
            request,
            mgr,
            session,
            initial_events=(endpoint_event,),
            close_on_exit=True,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@mcp_router.post("/mcp/messages")
async def mcp_legacy_messages(
    request: Request,
    session_id: Optional[str] = Query(default=None),
    principal: Principal = Depends(authenticate_principal),
    repo: "EmailRepository" = Depends(get_repository),
    report_store: "ReportStore" = Depends(get_report_store),
    cfg: "Config" = Depends(get_settings),
) -> Response:
    """Legacy MCP HTTP+SSE 上行消息端点：校验会话归属、执行 JSON-RPC、响应入 SSE 队列并返回 202。"""
    sid = (session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id query parameter is required")

    mgr = get_mcp_session_manager(request.app)
    session = mgr.get_owned(sid, principal, transport_kind=TRANSPORT_LEGACY_SSE)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    try:
        payload = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid JSON payload") from None

    client = _make_mcp_client(principal, repo, report_store, cfg, route="/mcp/messages")
    result = await _dispatch_jsonrpc_payload(payload, client)

    items = result if isinstance(result, list) else ([] if result is None else [result])
    for item in items:
        try:
            mgr.enqueue(session, item)
        except asyncio.QueueFull:
            raise HTTPException(status_code=429, detail="session message queue is full") from None
        except SessionClosedError:
            break

    return JSONResponse({"status": "accepted"}, status_code=202)
