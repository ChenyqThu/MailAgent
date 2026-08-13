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


async def _connector_def(connector_id: str):
    """解析 connector 定义（行优先 → 预置目录兜底）；未知 → 404。

    🔴 `run_in_threadpool`：08-05 WP-12 起解析要读 `connector` 行 = 一次同步 sqlite，
    别人持写锁时不能把 event loop 冻住（本文件其余 store 读写同款纪律）。
    """
    from src.connectors.registry import get_connector_def

    try:
        return await run_in_threadpool(get_connector_def, connector_id)
    except KeyError as e:
        raise APIError("E_NOT_FOUND", str(e)) from None


def get_composio_entry(connector_id: str):
    """**Composio 轨**的目录条目（无 → None）。模块级薄封装：handler 内 lazy import 纪律的
    例外只在这一处，因为 `composio_catalog` / `catalog` 都是**纯数据模块**（零第三方 import），
    裸 worktree 也 import 得动。

    🔴 08-06 双轨后它**不再**等于「目录里有没有这一家」——notion / atlassian 出厂是 direct
    轨（`catalog.track_for`），但它俩在 COMPOSIO_CATALOG 里的条目仍然活着，供**存量 composio
    行**（行优先解析出 source='composio'）重连/续期用。判「目录里有没有」一律走 `track_for`。"""
    from src.connectors.composio_catalog import get_catalog_entry as _get

    return _get(connector_id)


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
        # 08-05 WP-12：composio 多 toolkit 的**顺序**授权（Atlassian = JIRA + CONFLUENCE）——
        # 前端比对序号，涨了就再开一次浏览器。custom_mcp 轨从不递增（恒 0，只产一条 URL）。
        "link_seq": getattr(flow, "link_seq", 0),
        "pending_toolkit": getattr(flow, "pending_toolkit", None),
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
    """**已配置的** connector 行 ∪ 凭证健康 ∪ 在途流。

    🔴 08-05 WP-12 语义变更：以前这里列的是 registry 硬编码全集（连没连过的两家也在），
    现在 registry 常量已退役 —— **列表 = `connector` 表里的行**（connector 行升为一等实体，
    顺手关掉已知限界 §9.3 的僵尸行：库里有的就一定看得见、删得掉）。「还没连过的服务」由
    `GET /catalog` 的预置目录承担，两处不重复渲染同一家。
    """
    _require_enabled(settings)
    from src.connectors.catalog import row_is_off_track
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for

    store = _store()
    rows = await run_in_threadpool(store.list_connectors)
    items = []
    for row in rows:
        cid = row.connector_id
        cred = await run_in_threadpool(_credential_view, namespace_for(cid))
        items.append(
            {
                "connector_id": cid,
                "display_name": row.display_name or cid,
                "server_url": row.server_url,
                "transport": row.transport,
                "status": row.status,
                "enabled": row.enabled,
                # PR3：分类侧独立授权位（默认关）。
                "preprocess_enabled": row.preprocess_enabled,
                "scopes": row.scopes,
                "last_error": row.last_error,
                "last_synced_at": row.last_synced_at,
                # 08-05 WP-12：装配路线 —— 设置页据此显示「经 Composio」/「直连」（出站告知
                # 三处之一），并对与目录出厂轨道不符的行给迁移提示。
                # 🔴 08-06 双轨改判：判据从「custom_mcp 行 + 目录里有同 id」改成
                # `row_is_off_track` —— 老判据会把**正确的直连行**（notion / atlassian 出厂
                # 就是 direct 轨）误标成「已被目录取代」，把 owner 诱导去断开重连一遍。
                "source": row.source,
                "superseded_by_catalog": row_is_off_track(row.source, cid),
                "credential": cred,
                "flow": _flow_view(get_flow(cid)),
            }
        )
    return success_envelope({"connectors": items}, request=request)


@router.get("/catalog", dependencies=[Depends(verify_cf_access)])
async def connector_catalog(request: Request, settings=Depends(get_settings)) -> Any:
    """预置目录（08-06 起**双轨**）+ BYOK key 状态。

    每条带 `track`（出厂轨道，跨 lane 契约）：
      - `direct`   —— Notion / Atlassian：自建 MCP 直连（OAuth 2.1 + PKCE + DCR，打官方
        端点），**必带 `server_url`**；`toolkits=[]` / `tool_count=null` —— 直连轨没有
        curated 白名单这个概念，工具清单以实际 `tools/list` 为准（套 Composio 那份 slug
        白名单会得到一份对不上的假清单）。
      - `composio` —— 其余 14 家：托管 MCP，`server_url=null`（endpoint 要 session 建出来）。

    🔴 **BYOK gate 只对 composio 轨成立**：`composio.configured=false` 时前端把**该轨**的
    目录卡渲染成 disabled + 引导（注册 Composio → 取 key → 粘贴）；direct 轨条目不需要
    任何 key。这里照常返回全部条目内容（描述/logo/白名单大小都是代码内数据），gate 是 UI
    语义 —— 真正的强制在连接端点（composio 轨没 key → 409 `E_COMPOSIO_NO_KEY`）。

    `configured` = 库里已有同 id 行（= 已在列表端点里）；`superseded` = 那一行的装配路线
    与本条目的出厂轨道**不符**（老直连行遇上 composio 轨条目，或 08-06 之后 owner 活库那种
    composio 行遇上 direct 轨条目）—— 要换轨得先断开并清除配置，见 §9.3 一等实体化。
    """
    _require_enabled(settings)
    from src.connectors import composio
    from src.connectors.catalog import catalog_views, row_is_off_track

    rows = {r.connector_id: r for r in await run_in_threadpool(_store().list_connectors)}
    key_status = await run_in_threadpool(composio.api_key_status)
    entries = []
    for view in catalog_views():
        row = rows.get(view.connector_id)
        entries.append(
            {
                "connector_id": view.connector_id,
                "display_name": view.display_name,
                "track": view.track,
                "server_url": view.server_url,
                "description_key": view.description_key,
                "category": view.category,
                "logo_text": view.logo_text,
                "logo_color": view.logo_color,
                "toolkits": list(view.toolkits),
                "tool_count": view.tool_count,
                "configured": row is not None,
                "superseded": row is not None
                and row_is_off_track(row.source, view.connector_id),
            }
        )
    return success_envelope(
        {"composio": key_status, "entries": entries}, request=request
    )


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


@router.get("/{connector_id}/status", dependencies=[Depends(verify_cf_access)])
async def connector_status(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    _require_enabled(settings)
    definition = await _connector_def(connector_id)
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
            "source": row.source if row else definition.source,
            "credential": cred,
            "flow": _flow_view(get_flow(connector_id)),
        },
        request=request,
    )


@router.post("/{connector_id}/sync", dependencies=[Depends(verify_cf_access)])
async def sync_tools(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """用已存授权拉工具清单落库（非交互：无授权 → 409 引导走 oauth/start，不挂浏览器）。

    🔴 08-05 WP-12：**要求行已存在** —— sync 的语义是「用已存的连接重拉清单」。以前靠
    registry 常量能凭空 upsert 出一行，那是撒谎：连都没连，行里写个 server_url 会让列表
    凭空多一行「未连接」的假象。

    🔴 08-06：判据从「`definition.server_url` 空」改成**直接查行**。空 URL 以前只是「没连过」
    的代理判据，且只对 composio 轨成立；双轨后 direct 轨的目录条目**自带**官方 endpoint，
    照旧判会让一个从没连过的 Notion 走进下面的 upsert，把那个假象原样放回来。
    """
    _require_enabled(settings)
    definition = await _connector_def(connector_id)
    from src.connectors.client import ConnectorClient, ConnectorError
    from src.connectors.gate import ConnectorBusy
    from src.connectors.service import (
        CONNECTOR_REAUTH_MESSAGE,
        should_mark_needs_reauth,
    )

    store = _store()
    row = await run_in_threadpool(store.get_connector, connector_id)
    if row is None or not definition.server_url:
        raise APIError(
            "E_CONNECTOR_NOT_CONNECTED",
            f"connector {connector_id!r} has not been connected yet — connect it first",
            http_status=409,
        )
    await run_in_threadpool(
        store.upsert_connector,
        connector_id,
        server_url=definition.server_url,
        display_name=definition.display_name,
        transport=definition.transport,
    )
    # definition 复用上面解析好的那一份（别在 event loop 上再读一次 `connector` 行）。
    client = ConnectorClient(connector_id, interactive=False, definition=definition)
    try:
        tools = await client.list_tools_manifest()
    except ConnectorBusy as e:
        raise APIError("E_CONNECTOR_BUSY", str(e), http_status=409) from e
    except ConnectorError as e:
        # 授权**真的**失效 → 连接落 needs_reauth + **可行动**文案（PRD「不静默重试到死」）。
        # 判定与文案与 invoke 侧同一份（service.py）—— 两个落态点绝不各抄一遍。
        # 🔴 08-06：判据从「码表命中」换成 should_mark_needs_reauth —— 码表命中不充分（本地
        # 装配不出请求的那一形状同码，零出网），且两个面必须同判，否则同一次失败会在 sync 与
        # invoke 上得到相反的状态。
        if should_mark_needs_reauth(e):
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

    08-05 per-tool 三档：``mode_override`` = 用户覆盖原样（null=跟随默认），
    ``effective_mode`` = 服务端折算（NULL→auto；折算**不在前端重算**——那会成第二处
    手抄）。orphan 行照常在列（注册侧跳过它们）。``destructive`` 原样透出 —— 设置面 /
    审批卡的红警告读它。

    🔴 顶层还带 ``source``（08-05 WP-12 出站告知第三处）：`McpApprovalCard` 就是从这条
    **live** 通道拿事实的（镜像 destructive 红警告的做法 —— 模型无法把「经 Composio 云
    执行」这行字从卡上说没），所以它必须和工具清单同一次请求返回。
    """
    _require_enabled(settings)
    definition = await _connector_def(connector_id)
    from src.agent_config.store import connector_tool_effective_mode

    rows = await run_in_threadpool(_store().list_connector_tools, connector_id)
    return success_envelope(
        {
            "connector_id": connector_id,
            "source": definition.source,
            "tools": [
                {
                    "name": r.tool_name,
                    "description": r.description,
                    "input_schema_json": r.input_schema_json,
                    "output_schema_json": r.output_schema_json,
                    "crud_type": r.crud_type,
                    "destructive": r.destructive,
                    "mode_override": r.mode,
                    "effective_mode": connector_tool_effective_mode(r.mode),
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
    await _connector_def(connector_id)
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


def _set_tool_mode_and_read(
    connector_id: str, tool_name: str, mode: Optional[str]
) -> Any:
    """写 per-tool 档位覆盖 + 回读该行（一次线程跳；行不存在由写侧 KeyError 抛）。"""
    store = _store()
    store.set_connector_tool_mode(connector_id, tool_name, mode)
    for row in store.list_connector_tools(connector_id):
        if row.tool_name == tool_name:
            return row
    raise KeyError(f"connector tool not found: {connector_id}/{tool_name}")


def _validate_mode_value(payload: dict[str, Any]) -> Optional[str]:
    """``{"mode": 'auto'|'ask'|'off'|null}`` 的键在场 + 值域校验（缺键/野值 → 400）。"""
    from src.agent_config.store import CONNECTOR_TOOL_MODES

    if "mode" not in payload:
        raise APIError(
            "E_INVALID_ARG",
            'body must carry a "mode" key ("auto"|"ask"|"off", or null to clear the '
            "override back to the default tier)",
            http_status=400,
        )
    mode = payload["mode"]
    if mode is not None and mode not in CONNECTOR_TOOL_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"mode must be one of {list(CONNECTOR_TOOL_MODES)} or null",
            http_status=400,
        )
    return mode


@router.post(
    "/{connector_id}/tools/{tool_name}/mode",
    dependencies=[Depends(verify_cf_access)],
)
async def set_tool_mode(
    connector_id: str,
    tool_name: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """per-tool 三档覆盖（08-05 改判，取代旧 ``…/enabled`` 端点）：
    ``{"mode": "auto"|"ask"|"off"|null}``。

    ``null`` = 清除覆盖回默认档（**auto**）—— 与「显式 off」不是一回事，故键必须在场
    （缺键 → 400，不把「没说」当成 null 猜）。响应带**更新后的事实**（``mode_override``
    原样 + ``effective_mode`` 折算），免得前端自己再折算一遍默认规则（第二处手抄）。

    🔴 08-03 起**在册工具一律可配置**；08-05 起 write/update/destructive 也可设 ``auto``
    免卡（owner 拍板，master-plan WP-10）——destructive 设 auto 的一次性红色确认在设置面，
    审批卡红警告链在 ``ask`` 档原样保留。
    """
    _require_enabled(settings)
    await _connector_def(connector_id)
    from src.agent_config.store import connector_tool_effective_mode

    mode = _validate_mode_value(payload)
    try:
        row = await run_in_threadpool(
            _set_tool_mode_and_read, connector_id, tool_name, mode
        )
    except KeyError as e:
        raise APIError(
            "E_NOT_FOUND",
            f"tool {tool_name!r} is not in the synced manifest of connector "
            f"{connector_id!r} — sync the connector first",
            http_status=404,
        ) from e
    return success_envelope(
        {
            "connector_id": connector_id,
            "tool_name": tool_name,
            "mode_override": row.mode,
            "effective_mode": connector_tool_effective_mode(row.mode),
        },
        request=request,
    )


@router.post(
    "/{connector_id}/tools/bulk_mode", dependencies=[Depends(verify_cf_access)]
)
async def bulk_set_tool_mode(
    connector_id: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """组级批量设档（差距表 #6）+ Reset permissions（#8）：
    ``{"mode": "auto"|"ask"|"off"|null, "crud_type"?: "read"|"write"|"update"}``。

    ``mode=null`` = 批量清覆盖回默认（Reset permissions 的后端）；``crud_type`` 缺席 =
    整个 connector 的全部在册工具。orphan 行跳过（store 侧纪律——恒不注册的行不吃批量
    动作）。响应 ``updated`` = 实际改动行数（0 不是错——从未同步过的 connector 也 200）。
    """
    _require_enabled(settings)
    await _connector_def(connector_id)
    from src.agent_config.store import CONNECTOR_CRUD_TYPES

    mode = _validate_mode_value(payload)
    crud_type = payload.get("crud_type")
    if crud_type is not None and crud_type not in CONNECTOR_CRUD_TYPES:
        raise APIError(
            "E_INVALID_ARG",
            f"crud_type must be one of {list(CONNECTOR_CRUD_TYPES)} or absent",
            http_status=400,
        )
    updated = await run_in_threadpool(
        lambda: _store().bulk_set_connector_tool_mode(
            connector_id, mode, crud_type=crud_type
        )
    )
    return success_envelope(
        {
            "connector_id": connector_id,
            "mode": mode,
            "crud_type": crud_type,
            "updated": updated,
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
    await _connector_def(connector_id)
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

    🔴 08-05 场地放开（owner 知情拍板，master-plan WP-10）：原「天花板硬编码 read」已
    退役——开了本开关后，分类侧工具面 = 该 connector 里 per-tool ``mode='auto'`` 的工具
    （**含 write/update**；``ask`` 在该无人值守场地 ≙ 不注册，``off`` 恒不注册，见
    ``llm_tools`` 的 ``only_auto_tools``）。本开关仍**独立、默认关**，不复用 custom agent
    的 ``grant_connectors``（免得给 agent 配了 write、分类侧跟着继承）。
    """
    _require_enabled(settings)
    await _connector_def(connector_id)
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
    缺席 / owner-present（``manual_chat`` / ``im_chat`` —— 后者自阶段 2 PR-1 起与 manual
    同档，08-04 拍板「全开放」；写类的审批档位在 gateway 侧按 per-tool 三档判——
    ``ask`` 弹卡 / ``auto`` 免卡，08-05 改判）→ 与 PR2 逐字节相同（owner 面）。
    结果已在 ``ConnectorClient.call_tool`` 截断（``CALL_RESULT_MAX_CHARS``）；
    UNTRUSTED_MCP_TOOL 围栏由调用面各自套（TS gateway / Python llm_tools）。
    """
    _require_enabled(settings)
    await _connector_def(connector_id)
    body = payload or {}
    from src.connectors.client import ConnectorError
    from src.connectors.gate import ConnectorBusy
    from src.connectors.service import (
        ConnectorInvokeDenied,
        invoke_connector_tool,
        is_matter_followup_caller,
        resolve_caller_ceiling,
    )

    try:
        ceiling = await run_in_threadpool(
            resolve_caller_ceiling, body.get("caller"), connector_id
        )
        # 0813 批 P —— matter_followup 是无审批链宿主的无人值守场地：ask ≙ 不可用 +
        # destructive 恒拒（gateway 注册期 matterVenueAdmitsEntry 是第一道，这里是
        # 判定与执行同侧的第二道；其余调用面两个开关恒 False，字节不变）。
        matter_venue = is_matter_followup_caller(body.get("caller"))
        result = await invoke_connector_tool(
            connector_id,
            tool_name,
            body.get("arguments"),
            ceiling=ceiling,
            deny_ask_mode=matter_venue,
            deny_destructive=matter_venue,
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
    connector_id: str,
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
    settings=Depends(get_settings),
) -> Any:
    """断开：**逐条删凭证**（tokens + client_info + 任何将来槽位）+ 状态回 disconnected。

    工具清单行**保留**（含用户 per-tool 配置 —— 重连后配置还在；refresh 纪律的另一面）。
    client_info 一并删（重连走全新 DCR，避免残留注册与新授权错配）。

    ``{"purge": true}``（08-05 WP-12，差距表 #10「Uninstall 语义补全」）= 连行一起清：
    connector 行 + 全部工具行都删掉，等于「当它没存在过」。这是把老直连行换成预置目录
    Composio 版本的**唯一**出口（同 id 一行，不做并存），也是自定义 MCP 行的卸载出口。
    默认 false —— 删用户配置永远要显式说。
    """
    _require_enabled(settings)
    await _connector_def(connector_id)
    from src.agent_config.credentials import delete_credential, list_credentials
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for

    purge = bool((payload or {}).get("purge") is True)
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
    purged = False
    if row is not None and purge:
        purged = await run_in_threadpool(store.delete_connector, connector_id)
    elif row is not None:
        await run_in_threadpool(
            store.update_connector_state,
            connector_id,
            status="disconnected",
            last_error=None,
            scopes=None,
        )
    logger.info(
        "[connector] {} disconnected ({} credential rows deleted, purged={})",
        connector_id,
        deleted,
        purged,
    )
    return success_envelope(
        {"connector_id": connector_id, "deleted_credentials": deleted, "purged": purged},
        request=request,
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
