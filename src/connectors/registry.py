"""connector 定义的**解析**（08-05 WP-12 起：connector 行是一等实体，不再有硬编码常量表）。

原先这里是 `CONNECTORS = {notion, atlassian}` 两行常量：加一家 = 改代码发版，且
`list`/`status`/`disconnect` 全都以「id 在不在这张表里」为准（已知限界 §9.3：从表里删一行
就会在库里留下永远访问不到的僵尸行 + 僵尸凭证）。

**08-05 单轨改造后的解析顺序**（`get_connector_def`）：

  1. **`connector` 表里的行**（权威）—— server_url / transport / display_name / source 全部
     以行为准。存量直连行（Notion / Atlassian）因此**原样可用**，不需要任何常量表兜着；
     `custom_mcp` 轨将来用户自填的 URL 也天然落这条路（WP-24）。
  2. **Composio 预置目录**（`composio_catalog`）—— 还没连过的目录条目：有 display_name，
     但**没有 server_url**（托管 MCP endpoint 要等 session 建出来才存在）。这类 def 只用于
     「列目录 / 起连接」，任何要发请求的路径拿到它都会看到空 server_url 并被显式拒。
  3. 都不是 → `KeyError`（router 转 404、client 转 `E_CONNECTOR_UNKNOWN`）。

🔴 顺序不能反：目录里有 `notion`，库里也有一行老的直连 `notion`。**行优先**才能让老行继续走
直连（它的 token 是直连拿的），否则一次升级就把老连接的装配路线换掉 → 每次调用都用一把
Composio key 去打 Notion 的端点。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from src.connectors.composio_catalog import COMPOSIO_CATALOG, get_catalog_entry


@dataclass(frozen=True)
class ConnectorDef:
    """一个 connector 的解析结果（运行态 status / 工具清单在 ``agent_config.db``）。"""

    connector_id: str
    server_url: str
    display_name: str
    #: OAuth DCR 注册时的 client_name（对方授权页展示给用户看的名字）。`custom_mcp` 轨才用。
    client_name: str = "MailAgent"
    #: transport 留位：MVP 只实现 streamable_http，stdio 只留表结构（PRD Assumptions）。
    transport: str = "streamable_http"
    #: 装配路线（`store.CONNECTOR_SOURCES`）：`composio` = 静态 header 打托管 MCP endpoint；
    #: `custom_mcp` = OAuth 2.1/PKCE/DCR 直连。
    source: str = "custom_mcp"


def _def_from_row(row) -> ConnectorDef:
    return ConnectorDef(
        connector_id=row.connector_id,
        server_url=row.server_url or "",
        display_name=row.display_name or row.connector_id,
        transport=row.transport or "streamable_http",
        source=row.source,
    )


def _def_from_catalog(connector_id: str) -> Optional[ConnectorDef]:
    entry = get_catalog_entry(connector_id)
    if entry is None:
        return None
    # server_url 留空 = 「还没有托管 endpoint」。任何要发请求的调用路径都必须自己看到这一点
    # 并报 not-connected —— 拿空 URL 去发请求是静默失败，比显式拒糟得多。
    return ConnectorDef(
        connector_id=entry.connector_id,
        server_url="",
        display_name=entry.display_name,
        source="composio",
    )


def get_connector_def(connector_id: str) -> ConnectorDef:
    """按 id 解析定义（行优先 → 目录兜底）；都没有 → ``KeyError``。"""
    if not connector_id or not isinstance(connector_id, str):
        raise KeyError(f"unknown connector: {connector_id!r}")
    try:
        from src.agent_config.store import get_agent_config_store

        row = get_agent_config_store().get_connector(connector_id)
    except Exception as e:  # noqa: BLE001 — 库不可用不该让「目录里有没有这一家」也答不出来
        # 🔴 不静默：读不到行时目录条目会顶上（server_url 空 ⇒ 后续路径显式报 not-connected，
        # 不会拿错 endpoint 发请求），但「为什么突然说没连接」必须在日志里留痕。
        logger.warning("[connector] row lookup failed for {}: {}", connector_id, e)
        row = None
    if row is not None:
        return _def_from_row(row)
    catalog_def = _def_from_catalog(connector_id)
    if catalog_def is not None:
        return catalog_def
    raise KeyError(
        f"unknown connector: {connector_id!r} (not a configured connector, and not in the "
        f"preset catalog: {sorted(COMPOSIO_CATALOG)})"
    )


def namespace_for(connector_id: str) -> str:
    """``external_credential`` 分区键（``connector:notion`` 风格，阶段 0a 约定）。"""
    return f"connector:{connector_id}"


#: OAuth 回调路径（DCR 注册的固定 redirect_uri 的 path 部分；router 挂同一路径）。
CALLBACK_PATH = "/api/connector/oauth/callback"


def resolve_redirect_uri() -> str:
    """固定端口 loopback redirect_uri（排雷报告 §四：DCR 自注册固定 URI，不用 CIMD）。

    serve-api 恒 bind 127.0.0.1；端口读 ``MAILAGENT_API_PORT``（进程注入键，默认 8200 ——
    与 ``island_agent.resolve_api_port`` 同源同默认）。仅 `custom_mcp` 轨用得到。
    """
    port = os.environ.get("MAILAGENT_API_PORT", "8200")
    return f"http://127.0.0.1:{port}{CALLBACK_PATH}"
