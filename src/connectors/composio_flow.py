"""Composio 预置目录的连接流（08-05 WP-12）—— `custom_mcp` 轨 `run_connect_flow` 的对位物。

同一个 `ConnectorFlowState` 交接面（start 端点等 `auth_url_ready` → 前端开浏览器 → 轮询
`/status`），所以设置页的「等待授权… + deadline」整段**原样复用**；区别只在中间那段：

  | 步骤 | custom_mcp（直连） | composio（本模块） |
  |---|---|---|
  | 端点从哪来 | registry/行里的 server_url | 建/复用 tool-router **session** → `mcp.url` |
  | 授权在哪做 | 我们的 loopback OAuth（PKCE + DCR） | Composio 托管的 **Connect Link** 页 |
  | 怎么知道成了 | rendezvous 收到 code | 轮询 `connected_accounts` 的 status |
  | 多 toolkit | 无此概念 | **顺序**授权（Atlassian = JIRA + CONFLUENCE，见 `link_seq`） |

拉工具清单 → 落双表 → 置 connected 这最后一段两轨**共用**同一份代码路径
（`ConnectorClient.list_tools_manifest` + `store.sync_connector_tools`），所以 per-tool 三档 /
审批链 / 围栏 / orphan 纪律对 composio 行**零改动**成立。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from loguru import logger
from starlette.concurrency import run_in_threadpool

from src.connectors import composio
from src.connectors.composio_catalog import ComposioCatalogEntry
from src.connectors.oauth_flow import ConnectorFlowState

#: 等一个 toolkit 在 Composio 侧连上的上限（秒）——与 loopback 授权的 300s 同量级：
#: 用户要在浏览器里登录 + 点同意。
LINK_WAIT_TIMEOUT_SECONDS = 300.0

#: connected-account 轮询节拍（秒）。
LINK_POLL_INTERVAL_SECONDS = 3.0


async def _ensure_session(
    entry: ComposioCatalogEntry,
    *,
    api_key: str,
    user_id: str,
    existing_session_id: Optional[str],
) -> dict[str, str]:
    """复用既有 session（拿回 `mcp.url`），拿不回来就新建一个。

    🔴 复用优先：session 是服务端持久对象，且**授权是挂在 user 上、不是挂在 session 上**，
    重建 session 不会掉授权；但每次重建都多一个僵尸 session（Composio 没有 DELETE 端点）。
    """
    if existing_session_id:
        try:
            return await composio.get_session(existing_session_id, api_key)
        except composio.ComposioError as e:
            if e.code == "E_COMPOSIO_AUTH":
                raise
            logger.warning(
                "[composio] session {} unusable ({}), creating a new one",
                existing_session_id,
                e.code,
            )
    return await composio.create_session(entry, user_id, api_key)


async def _wait_for_toolkit(
    flow: ConnectorFlowState,
    toolkit: str,
    *,
    api_key: str,
    user_id: str,
    deadline: float,
) -> None:
    """轮询到该 toolkit 的 connected account 变 ACTIVE；失败/超时 → ComposioError。"""
    while True:
        accounts = await composio.list_connected_accounts(user_id, api_key)
        state = composio.toolkit_connected(accounts, toolkit)
        if state is True:
            return
        if state is False:
            raise composio.ComposioError(
                f"Composio reported a failed connection for {toolkit} — retry the connect link",
                code="E_COMPOSIO_HTTP",
            )
        if time.monotonic() >= deadline:
            raise composio.ComposioError(
                f"authorization for {toolkit} was not completed within "
                f"{LINK_WAIT_TIMEOUT_SECONDS:g}s",
                code="E_COMPOSIO_NETWORK",
            )
        await asyncio.sleep(LINK_POLL_INTERVAL_SECONDS)


async def run_composio_connect_flow(
    flow: ConnectorFlowState,
    entry: ComposioCatalogEntry,
    *,
    client_factory: Any = None,
) -> None:
    """整条预置连接流：session → 逐 toolkit Connect Link → 列工具 → 双表落库 → 状态回写。

    与 `client.run_connect_flow` 同纪律：整个协程作为**一个** asyncio task 被 schedule；
    异常不外抛（终态落 `flow` + connector 行）。
    """
    from src.agent_config.store import get_agent_config_store

    connector_id = flow.connector_id
    store = get_agent_config_store()

    try:
        # 🔴 两条都 `run_in_threadpool`：取 key 是 sqlite 读 + Fernet 解密，取 user_id 是
        # `owner_settings` 读写 —— 同步 sqlite 一律不上 event loop（本流是 loop 上的 task）。
        api_key = await run_in_threadpool(composio.require_api_key)
        user_id = await run_in_threadpool(composio.resolve_user_id)

        row = await run_in_threadpool(store.get_connector, connector_id)
        existing_session = (
            row.composio_session_id if row is not None and row.source == "composio" else None
        )
        session = await _ensure_session(
            entry, api_key=api_key, user_id=user_id, existing_session_id=existing_session
        )

        await run_in_threadpool(
            store.upsert_connector,
            connector_id,
            server_url=session["mcp_url"],
            display_name=entry.display_name,
            transport="streamable_http",
            source="composio",
            composio_session_id=session["session_id"],
        )
        await run_in_threadpool(
            store.update_connector_state, connector_id, status="authorizing", last_error=None
        )

        for toolkit in entry.toolkits:
            accounts = await composio.list_connected_accounts(user_id, api_key)
            if composio.toolkit_connected(accounts, toolkit) is True:
                continue  # 之前连过（connected account 跨 session 复用）——不再逼用户点一遍
            link = await composio.create_link(session["session_id"], toolkit, api_key)
            flow.auth_url = link["redirect_url"]
            flow.pending_toolkit = toolkit
            flow.status = "authorizing"
            flow.link_seq += 1
            flow.auth_url_ready.set()
            await _wait_for_toolkit(
                flow,
                toolkit,
                api_key=api_key,
                user_id=user_id,
                deadline=time.monotonic() + LINK_WAIT_TIMEOUT_SECONDS,
            )

        flow.pending_toolkit = None
        if flow.auth_url is None:
            # 一条链接都没起（全部 toolkit 在 Composio 侧之前就 ACTIVE —— 清行重装 / 上一次
            # 授权成功但拉清单失败后重试）。🔴 必须在这里就放行 start 端点：它只等
            # `auth_url_ready`，而这个事件本来只在循环里或 `finally` 里 set —— 不补这一下，
            # 端点会一直挂到整条流跑完（列工具 + 落库），大概率先撞 30s 超时报一个假失败。
            # status 置 authorizing 是给前端的接力信号：行已存在，由它轮询到 connected。
            flow.status = "authorizing"
            flow.auth_url_ready.set()
        factory = client_factory
        kwargs: dict[str, Any] = {}
        if factory is None:
            from src.connectors.client import ConnectorClient
            from src.connectors.registry import get_connector_def

            factory = ConnectorClient
            # 行刚被上面的 upsert 刷成 composio + 新 endpoint —— 在线程池里解一次定义传进去，
            # 既不在 event loop 上读 sqlite，也不重复一次 I/O。
            kwargs["definition"] = await run_in_threadpool(get_connector_def, connector_id)
        cc = factory(connector_id, interactive=False, **kwargs)
        tools = await cc.list_tools_manifest()
        stats = await run_in_threadpool(store.sync_connector_tools, connector_id, tools)
        await run_in_threadpool(
            store.update_connector_state,
            connector_id,
            status="connected",
            last_error=None,
            last_synced_at=int(time.time()),
        )
        flow.tool_count = len(tools)
        flow.status = "connected"
        logger.info(
            "[composio] {} connected: {} tools synced ({})", connector_id, len(tools), stats
        )
    except BaseException as e:  # noqa: BLE001 — 后台 task 没有 caller，终态必须落进 flow/行
        message = f"{type(e).__name__}: {e}"[:500]
        flow.status = "error"
        flow.error = message
        try:
            await run_in_threadpool(
                store.update_connector_state,
                connector_id,
                status="error",
                last_error=message,
            )
        except Exception:  # noqa: BLE001 — 状态回写失败不掩盖原始异常
            logger.warning("[composio] failed to persist error state for {}", connector_id)
        if not isinstance(e, Exception):
            raise  # CancelledError / SystemExit —— 状态已落，取消语义原样传播
        logger.warning("[composio] {} connect flow failed: {}", connector_id, message)
    finally:
        # 失败在 URL 产出之前 → 让 start 端点的等待立刻返回（携 error）。
        flow.auth_url_ready.set()
