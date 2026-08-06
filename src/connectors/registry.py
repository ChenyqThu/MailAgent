"""connector 定义的**解析**（08-05 WP-12 起：connector 行是一等实体，不再有硬编码常量表）。

原先这里是 `CONNECTORS = {notion, atlassian}` 两行常量：加一家 = 改代码发版，且
`list`/`status`/`disconnect` 全都以「id 在不在这张表里」为准（已知限界 §9.3：从表里删一行
就会在库里留下永远访问不到的僵尸行 + 僵尸凭证）。

**08-05 单轨改造后的解析顺序**（`get_connector_def`）：

  1. **`connector` 表里的行**（权威）—— server_url / transport / display_name / source 全部
     以行为准。存量直连行（Notion / Atlassian）因此**原样可用**，不需要任何常量表兜着；
     `custom_mcp` 轨将来用户自填的 URL 也天然落这条路（WP-24）。
  2. **预置目录**（`catalog`，08-06 起双轨）—— 还没连过的目录条目：
     - `direct` 轨（Notion / Atlassian）：**带官方 server_url** + `source='custom_mcp'`，
       所以「还没连过的直连家」也解析得出可用的 def，点连接直接走 loopback OAuth/DCR。
     - `composio` 轨：有 display_name，但**没有 server_url**（托管 MCP endpoint 要等
       session 建出来才存在）。这类 def 只用于「列目录 / 起连接」，任何要发请求的路径拿到
       它都会看到空 server_url 并被显式拒。
  3. 都不是 → `KeyError`（router 转 404、client 转 `E_CONNECTOR_UNKNOWN`）。

🔴 顺序不能反：目录里有 `notion`，库里也有一行老的直连 `notion`。**行优先**才能让老行继续走
直连（它的 token 是直连拿的），否则一次升级就把老连接的装配路线换掉 → 每次调用都用一把
Composio key 去打 Notion 的端点。

🔴 **「没有行」与「读不出行」不是一回事**（08-06）：读 `connector` 行抛异常时兜底仍走目录，
但 direct 条目的 `server_url` 会被抹空 —— 那一刻我们并不知道这一家是不是已经连成 composio 了，
交出官方端点就会拿一把不存在的直连 token 去真的出网。抹空后两轨的兜底同性质：**失败在本地、
零出网**，DB 恢复后下一次解析自动回正。判据落在 `_def_from_catalog` 的 `row_lookup_ok`。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from src.connectors.catalog import catalog_ids, get_direct_entry
from src.connectors.composio_catalog import get_catalog_entry


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


def _def_from_catalog(connector_id: str, *, row_lookup_ok: bool) -> Optional[ConnectorDef]:
    """目录兜底。``row_lookup_ok`` = 「行查询**正常**返回了（结论可信：这家确实没有行）」。

    🔴 这个参数存在的唯一理由是 direct 轨：读行**抛异常**时 caller 也只能给出 ``row=None``，
    但那是「不知道」而不是「没有」——两者折成同一个值就会把一行**健康的** composio 连接
    临时解析成直连 def，见下面 direct 分支的红标。
    """
    direct = get_direct_entry(connector_id)
    if direct is not None:
        # 🔴 direct 轨条目**带**官方端点：这就是「还没连过的直连家」也能点连接的原因
        # （08-06 双轨；WP-12 之前那张常量表干的正是这件事）。
        # 🔴 但端点只在 `row_lookup_ok` 时才交出去。读行失败时抹成空 —— 此时无从知道这一家
        # 是不是已经连成 composio 了，交出官方端点 = 拿 `connector:<id>` 下并不存在的直连
        # token 去打 mcp.notion.com / mcp.atlassian.com：**真的出网**发了 DCR/授权请求。
        # 这是抹空的**主理由**，与下面 composio 分支同性质：失败在本地、零出网，DB 恢复后
        # 下一次解析自动回正。
        # （原先这里还列了第二条后果：失败码 E_CONNECTOR_NOT_CONNECTED ∈
        # CONNECTOR_REAUTH_ERROR_CODES 会把那条健康连接落成 needs_reauth。那条后果 08-06 起
        # 已由 `service.should_mark_needs_reauth` 独立兜住（空端点抛 `ConnectorUnconfigured`，
        # 两个落态点都据类型放行），**但抹空仍然必须保留** —— 它守的是「零出网」。）
        return ConnectorDef(
            connector_id=direct.connector_id,
            server_url=direct.server_url if row_lookup_ok else "",
            display_name=direct.display_name,
            source="custom_mcp",
        )
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
    row_lookup_ok = True
    try:
        from src.agent_config.store import get_agent_config_store

        row = get_agent_config_store().get_connector(connector_id)
    except Exception as e:  # noqa: BLE001 — 库不可用不该让「目录里有没有这一家」也答不出来
        # 🔴 不静默：读不到行时目录条目会顶上，「为什么突然说没连接」必须在日志里留痕。
        # 🔴 `row_lookup_ok=False` 把「查过了、没有行」与「压根没查出来」分开（08-06）：
        # 两者都得到 row=None，但只有前者能让 direct 条目交出官方端点。折成同一个值时，
        # 一次读行失败就会让 notion / atlassian 的**存量 composio 行**临时被解析成直连并
        # 真的出网 —— 兜底的安全论证（失败在本地、零出网）正是靠这个区分才继续成立。
        row_lookup_ok = False
        logger.warning("[connector] row lookup failed for {}: {}", connector_id, e)
        row = None
    if row is not None:
        return _def_from_row(row)
    catalog_def = _def_from_catalog(connector_id, row_lookup_ok=row_lookup_ok)
    if catalog_def is not None:
        return catalog_def
    raise KeyError(
        f"unknown connector: {connector_id!r} (not a configured connector, and not in the "
        f"preset catalog: {list(catalog_ids())})"
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
