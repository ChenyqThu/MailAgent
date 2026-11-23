"""Composio BYOK key management and connector OAuth flow/callback routes."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import HTMLResponse
from loguru import logger
from starlette.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.connector_common import _connector_def, _require_enabled

router = APIRouter()

# fire-and-forget 授权流 task 的强引用集（asyncio 只弱引用 task —— island.py 同手法）。
_bg_tasks: set = set()

#: start 端点等「授权 URL 就绪」的上限（秒）：metadata 发现 + DCR 都在这窗口里。
_AUTH_URL_WAIT_SECONDS = 30.0



def get_composio_entry(connector_id: str):
    """**Composio 轨**的目录条目（无 → None）。模块级薄封装：handler 内 lazy import 纪律的
    例外只在这一处，因为 `composio_catalog` / `catalog` 都是**纯数据模块**（零第三方 import），
    裸 worktree 也 import 得动。

    🔴 08-06 双轨后它**不再**等于「目录里有没有这一家」——notion / atlassian 出厂是 direct
    轨（`catalog.track_for`），但它俩在 COMPOSIO_CATALOG 里的条目仍然活着，供**存量 composio
    行**（行优先解析出 source='composio'）重连/续期用。判「目录里有没有」一律走 `track_for`。"""
    from src.connectors.composio_catalog import get_catalog_entry as _get

    return _get(connector_id)



@router.post("/composio/key", dependencies=[Depends(verify_cf_access)])
async def set_composio_key(
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """写 Composio API key（BYOK）：`{"api_key": "..."}`。

    落 `external_credential`（Fernet + Keychain），**不进 .env**（明文落盘 + 第二事实来源 +
    要重启，与「设置页填完即生效」矛盾）。响应**只回状态不回显任何字符**（脱敏纪律）。
    """
    _require_enabled(settings)
    from src.connectors import composio

    api_key = payload.get("api_key")
    if not isinstance(api_key, str) or not api_key.strip():
        raise APIError("E_INVALID_ARG", "api_key must be a non-empty string", http_status=400)
    await run_in_threadpool(composio.set_api_key, api_key)
    logger.info("[composio] api key updated (value never logged)")
    return success_envelope(await run_in_threadpool(composio.api_key_status), request=request)


@router.delete("/composio/key", dependencies=[Depends(verify_cf_access)])
async def clear_composio_key(request: Request, settings=Depends(get_settings)) -> Any:
    """删掉 Composio API key（幂等）。connector 行与 session id **不动** —— 重新填即可用。"""
    _require_enabled(settings)
    from src.connectors import composio

    deleted = await run_in_threadpool(composio.clear_api_key)
    status = await run_in_threadpool(composio.api_key_status)
    return success_envelope({**status, "deleted": deleted}, request=request)



# ---------------------------------------------------------------------------
# OAuth 回调（无鉴权依赖 —— state 即能力令牌；模块 docstring 的威胁模型）
# ---------------------------------------------------------------------------


@router.get("/oauth/callback")
async def oauth_callback(
    state: Optional[str] = None,
    code: Optional[str] = None,
    iss: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
) -> HTMLResponse:
    """浏览器回调落点：state → rendezvous 单次投递。未知 / 过期 / 已消费一律 404 不泄因。

    刻意**不读 settings、不挂 flag 门**：flag off 时不存在活 rendezvous，天然 404；
    端点自身零副作用（不落库、不发网络），把「能不能进」完全交给 state 令牌。
    """
    from src.connectors.oauth_flow import oauth_rendezvous

    if not state:
        return HTMLResponse(status_code=404, content=_CALLBACK_404_HTML)
    err = error_description or error
    delivered = oauth_rendezvous.deliver(state, code=code, iss=iss, error=err)
    if not delivered:
        return HTMLResponse(status_code=404, content=_CALLBACK_404_HTML)
    if err:
        return HTMLResponse(content=_CALLBACK_DENIED_HTML)
    return HTMLResponse(content=_CALLBACK_OK_HTML)


_CALLBACK_OK_HTML = (
    "<!doctype html><meta charset='utf-8'><title>MailAgent</title>"
    "<body style='font-family:system-ui;padding:3rem;text-align:center'>"
    "<h2>授权完成</h2><p>可以关闭此页，回到 MailAgent。</p></body>"
)
_CALLBACK_DENIED_HTML = (
    "<!doctype html><meta charset='utf-8'><title>MailAgent</title>"
    "<body style='font-family:system-ui;padding:3rem;text-align:center'>"
    "<h2>授权未完成</h2><p>你取消了授权（或授权被拒）。可以关闭此页。</p></body>"
)
_CALLBACK_404_HTML = (
    "<!doctype html><meta charset='utf-8'><title>MailAgent</title>"
    "<body style='font-family:system-ui;padding:3rem;text-align:center'>"
    "<h2>链接无效或已过期</h2><p>请回到 MailAgent 重新发起连接。</p></body>"
)


@router.post("/{connector_id}/oauth/start", dependencies=[Depends(verify_cf_access)])
async def oauth_start(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """发起授权：起后台授权流（单 task 全生命周期）→ 等授权 URL 就绪 → 返回给 owner 开浏览器。

    重复 start = 替换在途流（旧 task 取消 + 旧 state 作废）——owner 重点「连接」应当重来。

    🔴 08-05 WP-12 **按 source 分派**（判据顺序 = `registry.get_connector_def`：行优先、
    目录兜底）：`composio` → 托管 session + Connect Link 流；`custom_mcp`（含全部存量直连
    行）→ 原 loopback OAuth 流，逐字节不变。端点名保留 `oauth/start` 是有意的：对前端而言
    它就是「连接」这一个动作，分派是服务端的事（前端不该学会两套流程）。

    🔴 08-06 双轨后这条分派**同时**覆盖了「按 track 分流」：还没连过的 direct 轨条目
    （Notion / Atlassian）解析出的 def 就是 `source='custom_mcp'` + 官方 server_url ⇒ 走
    loopback OAuth；composio 轨条目解析出 `source='composio'` ⇒ 走托管流。已有行仍**行
    优先**（`source` 是既成事实）—— owner 活库那行 composio 的 atlassian 点重连仍走托管流，
    换轨的唯一出口是 `disconnect(purge=true)` 后重连（设置页据 `superseded_by_catalog` 提示）。
    """
    _require_enabled(settings)
    definition = await _connector_def(connector_id)
    from src.connectors.client import run_connect_flow
    from src.connectors.oauth_flow import begin_flow

    if definition.source == "managed_local":
        raise APIError(
            "E_CONNECTOR_UNSUPPORTED",
            f"connector {connector_id!r} uses local installation (/install) rather than OAuth",
            http_status=400,
        )
    if definition.source == "composio":
        entry = get_composio_entry(connector_id)
        if entry is None:
            # 行说自己是 composio、Composio 目录里却没有这一家（手改 DB / 目录删过条目）：
            # 不猜白名单。08-06 起还有第二种成因 —— 某家从 Composio 轨整体挪到了 direct 轨
            # 且它的 composio 条目被删掉；两种的处置相同（断开 + 清配置后重连换轨）。
            raise APIError(
                "E_NOT_FOUND",
                f"connector {connector_id!r} has a Composio row but is no longer a Composio "
                "catalog entry — disconnect it with purge to clear the row, then connect "
                "again to use the current track",
                http_status=404,
            )
        from src.connectors import composio
        from src.connectors.composio_flow import run_composio_connect_flow

        if await run_in_threadpool(composio.get_api_key) is None:
            raise APIError(
                "E_COMPOSIO_NO_KEY",
                "Composio API key is not configured — add it in the Connectors console "
                "(sidebar → Connectors → Composio account); the preset catalog is "
                "unavailable until then",
                http_status=409,
            )
        flow = begin_flow(connector_id)
        coro = run_composio_connect_flow(flow, entry)
    else:
        flow = begin_flow(connector_id)
        coro = run_connect_flow(flow)
    task = asyncio.create_task(coro)
    flow.task = task
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

    try:
        await asyncio.wait_for(flow.auth_url_ready.wait(), _AUTH_URL_WAIT_SECONDS)
    except asyncio.TimeoutError:
        raise APIError(
            "E_CONNECTOR_TIMEOUT",
            f"authorization URL was not ready within {_AUTH_URL_WAIT_SECONDS:g}s "
            "(metadata discovery / client registration slow or hung); "
            "check GET /api/connector/{id}/status",
            http_status=504,
        ) from None
    if flow.error is not None:
        raise APIError("E_CONNECTOR_OAUTH", flow.error, http_status=502)
    return success_envelope(
        {
            "connector_id": connector_id,
            "authorize_url": flow.auth_url,
            "status": flow.status,
            "callback_timeout_seconds": 300,
        },
        request=request,
    )

