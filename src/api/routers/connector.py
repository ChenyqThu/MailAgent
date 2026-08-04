"""MCP connector 路由（08-01 阶段 1 PR1）—— 连接 / OAuth / 工具清单同步的执行权威面。

鉴权分层：
  - list / oauth-start / status / sync / tools / disconnect → ``Depends(verify_cf_access)``
    （owner-only，本地 token 腿 + 远程 CF JWT）。
  - 🔴 ``GET /api/connector/oauth/callback`` **无鉴权依赖** —— 浏览器 302 顶层跳转带不了
    自定义 header（挂 CF 门必 401）。鉴权 = ``state`` 能力令牌（SDK ``token_urlsafe(32)``
    生成、单次消费、短 TTL），对不上一律 404 **不泄露原因**（照 ``routers/island.py`` ack
    先例 + auth.py codex Fix 5 教训）。

灰度开关 ``MAILAGENT_MCP_CONNECTORS``（pydantic ``mcp_connectors_enabled``，默认 off）：
off 时除 callback 外全部 409（callback 永远只认 state —— off 时不会有活 rendezvous，
自然 404，无需再挂 flag 门）。选 pydantic 而非 notion_agent 式 .env 热读的理由：
① env-only 直读有 ratchet 闸（tests/config/test_env_only_reads.py 禁新增）；② 本 flag 在
PR1 没有 Node gateway 侧消费者、无跨端同值刚需（notion_agent 热读正是为镜像 envBool）；
③ island 先例（ship off → dogfood → cutover）就是 pydantic 载体。代价 = 翻开关要重启
serve-api，对灰度开关可接受。

🔴 src.connectors / mcp SDK 一律 **lazy import**（handler 内）：让 ``import src.api.app``
在没装 mcp 的裸 worktree 也不炸（镜像 island.py 的 lazy import 纪律），flag off 时
serve-api 启动零新副作用。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, NoReturn, Optional

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import HTMLResponse
from loguru import logger
from starlette.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings

router = APIRouter(prefix="/api/connector", tags=["connector"])

# fire-and-forget 授权流 task 的强引用集（asyncio 只弱引用 task —— island.py 同手法）。
_bg_tasks: set = set()

#: start 端点等「授权 URL 就绪」的上限（秒）：metadata 发现 + DCR 都在这窗口里。
_AUTH_URL_WAIT_SECONDS = 30.0


def _require_enabled(settings: Any) -> None:
    if not getattr(settings, "mcp_connectors_enabled", False):
        raise APIError(
            "E_CONNECTOR_DISABLED",
            "MCP connectors are disabled (set MAILAGENT_MCP_CONNECTORS=true and restart serve-api)",
            http_status=409,
        )


def _connector_def(connector_id: str):
    from src.connectors.registry import get_connector_def

    try:
        return get_connector_def(connector_id)
    except KeyError as e:
        raise APIError("E_NOT_FOUND", str(e)) from None


def _store():
    from src.agent_config.store import get_agent_config_store

    return get_agent_config_store()


def _raise_from_connector_error(e: Exception, *, message: Optional[str] = None) -> NoReturn:
    """ConnectorError（stable code）→ APIError（HTTP 语义）。

    ``message`` = 覆盖对外文案（授权失效落态点用可行动文案换掉 client 层的技术原文；
    原异常仍挂在 ``__cause__`` 上，日志/调试拿得到）。
    """
    code = getattr(e, "code", "")
    http = {
        "E_CONNECTOR_UNKNOWN": 404,
        "E_CONNECTOR_NOT_CONNECTED": 409,
        "E_CONNECTOR_BUSY": 409,
        "E_CONNECTOR_TIMEOUT": 504,
        "E_CONNECTOR_OAUTH": 502,
        "E_CONNECTOR_NETWORK": 502,
        "E_CONNECTOR_PROTOCOL": 502,
    }.get(code, 500)
    raise APIError(code or "E_INTERNAL", message or str(e), http_status=http) from e


def _flow_view(flow: Any) -> Optional[dict[str, Any]]:
    if flow is None:
        return None
    return {
        "status": flow.status,
        "authorize_url": flow.auth_url,
        "started_at": flow.started_at,
        "error": flow.error,
        "tool_count": flow.tool_count,
    }


def _credential_view(namespace: str) -> dict[str, Any]:
    """凭证健康视图 —— 只走 peek（明文列），master key 不可用照样成立。"""
    from src.agent_config.credentials import peek_credential
    from src.connectors.token_storage import KEY_CLIENT_INFO, KEY_TOKENS

    tokens = peek_credential(namespace, KEY_TOKENS)
    client_info = peek_credential(namespace, KEY_CLIENT_INFO)
    return {
        "has_tokens": tokens is not None,
        "has_client_info": client_info is not None,
        # 明文列语义 = 连接活性（refresh token 寿命；NULL = 未知/不过期）——见 token_storage。
        "expires_at": tokens.expires_at if tokens else None,
        "scope": (tokens.metadata.get("scope") if tokens else None),
        "updated_at": tokens.updated_at if tokens else None,
    }


# ---------------------------------------------------------------------------
# owner-only 端点（verify_cf_access + flag 门）
# ---------------------------------------------------------------------------


@router.get("", dependencies=[Depends(verify_cf_access)])
async def list_connectors(request: Request, settings=Depends(get_settings)) -> Any:
    """registry 全集 ∪ DB 运行态 ∪ 凭证健康（未连接过的也列出来，供设置页起步）。"""
    _require_enabled(settings)
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import CONNECTORS, namespace_for

    store = _store()
    rows = {r.connector_id: r for r in await run_in_threadpool(store.list_connectors)}
    items = []
    for cid, definition in sorted(CONNECTORS.items()):
        row = rows.get(cid)
        cred = await run_in_threadpool(_credential_view, namespace_for(cid))
        items.append(
            {
                "connector_id": cid,
                "display_name": definition.display_name,
                "server_url": definition.server_url,
                "transport": definition.transport,
                "status": row.status if row else "disconnected",
                "enabled": row.enabled if row else True,
                # PR3：分类侧独立授权位（默认关；行不存在 = 从未连接 → 同样是关）。
                "preprocess_enabled": row.preprocess_enabled if row else False,
                "scopes": row.scopes if row else None,
                "last_error": row.last_error if row else None,
                "last_synced_at": row.last_synced_at if row else None,
                "credential": cred,
                "flow": _flow_view(get_flow(cid)),
            }
        )
    return success_envelope({"connectors": items}, request=request)


@router.post("/{connector_id}/oauth/start", dependencies=[Depends(verify_cf_access)])
async def oauth_start(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """发起授权：起后台授权流（单 task 全生命周期）→ 等授权 URL 就绪 → 返回给 owner 开浏览器。

    重复 start = 替换在途流（旧 task 取消 + 旧 state 作废）——owner 重点「连接」应当重来。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    from src.connectors.client import run_connect_flow
    from src.connectors.oauth_flow import begin_flow

    flow = begin_flow(connector_id)
    task = asyncio.create_task(run_connect_flow(flow))
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


@router.get("/{connector_id}/status", dependencies=[Depends(verify_cf_access)])
async def connector_status(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    _require_enabled(settings)
    definition = _connector_def(connector_id)
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for

    row = await run_in_threadpool(_store().get_connector, connector_id)
    cred = await run_in_threadpool(_credential_view, namespace_for(connector_id))
    return success_envelope(
        {
            "connector_id": connector_id,
            "display_name": definition.display_name,
            "status": row.status if row else "disconnected",
            "enabled": row.enabled if row else True,
            "preprocess_enabled": row.preprocess_enabled if row else False,
            "scopes": row.scopes if row else None,
            "last_error": row.last_error if row else None,
            "last_synced_at": row.last_synced_at if row else None,
            "credential": cred,
            "flow": _flow_view(get_flow(connector_id)),
        },
        request=request,
    )


@router.post("/{connector_id}/sync", dependencies=[Depends(verify_cf_access)])
async def sync_tools(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """用已存授权拉工具清单落库（非交互：无授权 → 409 引导走 oauth/start，不挂浏览器）。"""
    _require_enabled(settings)
    definition = _connector_def(connector_id)
    from src.connectors.client import ConnectorClient, ConnectorError
    from src.connectors.gate import ConnectorBusy
    from src.connectors.service import (
        CONNECTOR_REAUTH_ERROR_CODES,
        CONNECTOR_REAUTH_MESSAGE,
    )

    store = _store()
    await run_in_threadpool(
        store.upsert_connector,
        connector_id,
        server_url=definition.server_url,
        display_name=definition.display_name,
        transport=definition.transport,
    )
    client = ConnectorClient(connector_id, interactive=False)
    try:
        tools = await client.list_tools_manifest()
    except ConnectorBusy as e:
        raise APIError("E_CONNECTOR_BUSY", str(e), http_status=409) from e
    except ConnectorError as e:
        # 刷新失败 / 授权失效 → 连接落 needs_reauth + **可行动**文案（PRD「不静默重试到死」）。
        # 码表与文案与 invoke 侧同一份（service.py）—— 两个落态点绝不各抄一遍。
        if e.code in CONNECTOR_REAUTH_ERROR_CODES:
            await run_in_threadpool(
                store.update_connector_state,
                connector_id,
                status="needs_reauth",
                last_error=CONNECTOR_REAUTH_MESSAGE,
            )
            logger.warning("[connector] {} needs reauth (sync): {}", connector_id, e)
            _raise_from_connector_error(e, message=CONNECTOR_REAUTH_MESSAGE)
        _raise_from_connector_error(e)
    stats = await run_in_threadpool(store.sync_connector_tools, connector_id, tools)
    await run_in_threadpool(
        store.update_connector_state,
        connector_id,
        status="connected",
        last_error=None,
        last_synced_at=int(time.time()),
    )
    return success_envelope({"connector_id": connector_id, **stats}, request=request)


@router.get("/{connector_id}/tools", dependencies=[Depends(verify_cf_access)])
async def list_tools(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """已同步工具清单（PR2 的 ``createConnectorTools()`` 读这里）。

    ``effective_enabled`` 已折算（read 默认开 / write·update 默认关 / delete 恒 False）；
    delete 行照常在列（Q16=A 清单完整），orphan 行照常在列（PR2 不注册它们）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    from src.agent_config.store import connector_tool_effective_enabled

    rows = await run_in_threadpool(_store().list_connector_tools, connector_id)
    return success_envelope(
        {
            "connector_id": connector_id,
            "tools": [
                {
                    "name": r.tool_name,
                    "description": r.description,
                    "input_schema_json": r.input_schema_json,
                    "output_schema_json": r.output_schema_json,
                    "crud_type": r.crud_type,
                    "destructive": r.destructive,
                    "enabled_override": r.enabled,
                    "effective_enabled": connector_tool_effective_enabled(
                        r.crud_type, r.enabled
                    ),
                    "orphan": r.orphan,
                    "first_seen_at": r.first_seen_at,
                    "last_seen_at": r.last_seen_at,
                }
                for r in rows
            ],
        },
        request=request,
    )


@router.post("/{connector_id}/enabled", dependencies=[Depends(verify_cf_access)])
async def set_connector_enabled(
    connector_id: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """connector 整体启停（PR4 设置面）：``{"enabled": bool}``。

    关掉 = 整族工具不再注册给模型（PR2 注册期读 ``connector.enabled``），但**凭证与
    per-tool 配置都保留** —— 这是与 disconnect 的分工：那条是删凭证、这条只是收起来。
    行不存在 → 404（镜像 preprocess 的「先连接」语义：没连过就没有可启停的东西）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise APIError(
            "E_INVALID_ARG", "enabled must be a JSON boolean", http_status=400
        )
    try:
        await run_in_threadpool(
            _store().update_connector_state, connector_id, enabled=enabled
        )
    except KeyError as e:
        raise APIError(
            "E_NOT_FOUND",
            f"connector {connector_id!r} has no row yet — connect it first",
            http_status=404,
        ) from e
    return success_envelope(
        {"connector_id": connector_id, "enabled": enabled}, request=request
    )


def _set_tool_enabled_and_read(
    connector_id: str, tool_name: str, enabled: Optional[bool]
) -> Any:
    """写 per-tool 覆盖 + 回读该行（一次线程跳；行不存在由写侧 KeyError 抛）。"""
    store = _store()
    store.set_connector_tool_enabled(connector_id, tool_name, enabled)
    for row in store.list_connector_tools(connector_id):
        if row.tool_name == tool_name:
            return row
    raise KeyError(f"connector tool not found: {connector_id}/{tool_name}")


@router.post(
    "/{connector_id}/tools/{tool_name}/enabled",
    dependencies=[Depends(verify_cf_access)],
)
async def set_tool_enabled(
    connector_id: str,
    tool_name: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """per-tool 启用覆盖（PR4 设置面）：``{"enabled": bool | null}``，**三态**。

    ``null`` = 清除覆盖回默认（read 开 / write·update 关）—— 与「显式关」不是一回事，
    故键必须在场（缺键 → 400，不把「没说」当成 null 猜）。响应带**更新后的事实**
    （``enabled_override`` 原样 + ``effective_enabled`` 折算），免得前端自己再折算一遍
    默认规则（第二处手抄）。

    🔴 delete 类置 True → 403 ``E_CONNECTOR_TOOL_FORBIDDEN``（与 invoke 端点同码）：
    写侧闸在 store，这里只做 HTTP 映射；置 False / null 照常允许（清配置不是放权）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    from src.agent_config.store import connector_tool_effective_enabled

    if "enabled" not in payload:
        raise APIError(
            "E_INVALID_ARG",
            'body must carry an "enabled" key (JSON boolean, or null to clear the override)',
            http_status=400,
        )
    enabled = payload["enabled"]
    if enabled is not None and not isinstance(enabled, bool):
        raise APIError(
            "E_INVALID_ARG",
            "enabled must be a JSON boolean or null",
            http_status=400,
        )
    try:
        row = await run_in_threadpool(
            _set_tool_enabled_and_read, connector_id, tool_name, enabled
        )
    except KeyError as e:
        raise APIError(
            "E_NOT_FOUND",
            f"tool {tool_name!r} is not in the synced manifest of connector "
            f"{connector_id!r} — sync the connector first",
            http_status=404,
        ) from e
    except ValueError as e:
        raise APIError(
            "E_CONNECTOR_TOOL_FORBIDDEN",
            f"tool {tool_name!r} is delete-class and cannot be enabled "
            "（删除类工具暂不支持启用：清单里保留，但 MVP 恒关）",
            http_status=403,
        ) from e
    return success_envelope(
        {
            "connector_id": connector_id,
            "tool_name": tool_name,
            "enabled_override": row.enabled,
            "effective_enabled": connector_tool_effective_enabled(
                row.crud_type, row.enabled
            ),
        },
        request=request,
    )


@router.post(
    "/{connector_id}/tools/purge_orphans", dependencies=[Depends(verify_cf_access)]
)
async def purge_orphan_tools(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """清掉该 connector 的 orphan 工具行（PR5 设置面「清理已失效工具」）。

    orphan = 远端清单里已消失、但按 refresh 纪律 4 保留下来的历史行（防服务器抖一下就把
    用户配置抹掉）。攒久了在设置面就是噪音，这里是 owner **显式**清理的出口 —— 自动回收
    永远不做。只删 ``orphan=1``，在册工具与其 enabled 覆盖一行不碰。

    未知 connector id → 404（与 ``GET /{id}/tools`` 同判法：registry 里没有就是没有）。
    已知但从未连接 / 没有 orphan 行 → 200 ``{"purged": 0}``（删空不是错，前端不必先探）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    purged = await run_in_threadpool(
        _store().purge_orphan_connector_tools, connector_id
    )
    return success_envelope(
        {"connector_id": connector_id, "purged": purged}, request=request
    )


@router.post("/{connector_id}/preprocess", dependencies=[Depends(verify_cf_access)])
async def set_preprocess_enabled(
    connector_id: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """分类侧独立授权开关（PR3 坑 3）：``{"enabled": bool}``。

    🔴 **只有开关，没有天花板** —— 邮件预处理分类的 crud 天花板硬编码为 ``read``
    （``llm_tools`` 工厂只造 read 类工具），owner 不存在「给分类侧配 write」的入口。
    这是 lethal trifecta（untrusted 邮件正文 + 私有数据 + 外部写）的结构性收紧：
    分类是全自动逐封跑的，比 headless custom agent 更敞，所以它**不复用** custom agent 的
    ``grant_connectors``（免得给 agent 配了 write、分类侧跟着继承）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise APIError(
            "E_INVALID_ARG", "enabled must be a JSON boolean", http_status=400
        )
    store = _store()
    try:
        await run_in_threadpool(
            store.set_connector_preprocess_enabled, connector_id, enabled
        )
    except KeyError as e:
        raise APIError(
            "E_NOT_FOUND",
            f"connector {connector_id!r} has no row yet — connect it first",
            http_status=404,
        ) from e
    return success_envelope(
        {"connector_id": connector_id, "preprocess_enabled": enabled}, request=request
    )


@router.post(
    "/{connector_id}/tools/{tool_name}/invoke", dependencies=[Depends(verify_cf_access)]
)
async def invoke_tool(
    connector_id: str,
    tool_name: str,
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
    settings=Depends(get_settings),
) -> Any:
    """MCP 工具调用代理（PR2 gateway 工具 execute 的执行权威面；「gateway 只带信封」纪律）。

    flag 门在这里；**闸序与执行在 ``src/connectors/service.py``**（PR3 起 Python 侧 LLM
    工厂是第二个调用面，两面共用同一份闸——绝不手抄两份）。

    ``caller``（PR3 新增，可选）：``{"context_mode": str, "agent_id": str|null}``。
    headless（untrusted_trigger / cron_headless）时按该 agent 的 ``grant_connectors``
    重新判天花板 = **授权判定与执行同侧**的第二道闸（gateway 注册期过滤是第一道）；
    ``im_chat`` 恒拒；缺席 / ``manual_chat`` → 与 PR2 逐字节相同（owner 面）。
    结果已在 ``ConnectorClient.call_tool`` 截断（``CALL_RESULT_MAX_CHARS``）；
    UNTRUSTED_MCP_TOOL 围栏由调用面各自套（TS gateway / Python llm_tools）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    body = payload or {}
    from src.connectors.client import ConnectorError
    from src.connectors.gate import ConnectorBusy
    from src.connectors.service import (
        ConnectorInvokeDenied,
        invoke_connector_tool,
        resolve_caller_ceiling,
    )

    try:
        ceiling = await run_in_threadpool(
            resolve_caller_ceiling, body.get("caller"), connector_id
        )
        result = await invoke_connector_tool(
            connector_id, tool_name, body.get("arguments"), ceiling=ceiling
        )
    except ConnectorInvokeDenied as e:
        raise APIError(e.code, str(e), http_status=e.http_status) from None
    except ConnectorBusy as e:
        raise APIError("E_CONNECTOR_BUSY", str(e), http_status=409) from e
    except ConnectorError as e:
        _raise_from_connector_error(e)
    return success_envelope(
        {"connector_id": connector_id, "tool_name": tool_name, **result},
        request=request,
    )


@router.post("/{connector_id}/disconnect", dependencies=[Depends(verify_cf_access)])
async def disconnect(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """断开：**逐条删凭证**（tokens + client_info + 任何将来槽位）+ 状态回 disconnected。

    工具清单行**保留**（含用户 per-tool 配置 —— 重连后配置还在；refresh 纪律的另一面）。
    client_info 一并删（重连走全新 DCR，避免残留注册与新授权错配）。
    """
    _require_enabled(settings)
    _connector_def(connector_id)
    from src.agent_config.credentials import delete_credential, list_credentials
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for

    namespace = namespace_for(connector_id)
    metas = await run_in_threadpool(list_credentials, namespace)
    deleted = 0
    for meta in metas:
        if await run_in_threadpool(delete_credential, namespace, meta.credential_key):
            deleted += 1
    # 在途授权流一并作废（状态终局由流自己落，这里只取消）。
    flow = get_flow(connector_id)
    if flow is not None and flow.task is not None and not flow.task.done():
        flow.task.cancel()
    store = _store()
    row = await run_in_threadpool(store.get_connector, connector_id)
    if row is not None:
        await run_in_threadpool(
            store.update_connector_state,
            connector_id,
            status="disconnected",
            last_error=None,
            scopes=None,
        )
    logger.info("[connector] {} disconnected ({} credential rows deleted)", connector_id, deleted)
    return success_envelope(
        {"connector_id": connector_id, "deleted_credentials": deleted}, request=request
    )


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
