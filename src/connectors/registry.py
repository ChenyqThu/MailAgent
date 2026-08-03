"""已知 MCP connector 的常量表（PR1 只做 Notion / Atlassian 两家，两家都是 Streamable HTTP）。

server_url 是各家官方 remote MCP 端点（epic research 实测过 .well-known）；namespace 是
``external_credential`` 表的分区键（``connector:<id>``，形状受 ``credentials._NAMESPACE_RE``
约束）。加新 connector = 在 ``CONNECTORS`` 填一行 —— 双表模型天然通用（PRD Expansion Sweep）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ConnectorDef:
    """一个已知 connector 的静态定义（运行态 status / 工具清单在 ``agent_config.db``）。"""

    connector_id: str
    server_url: str
    display_name: str
    #: OAuth DCR 注册时的 client_name（对方授权页展示给用户看的名字）。
    client_name: str = "MailAgent"
    #: transport 留位：MVP 只实现 streamable_http，stdio 只留表结构（PRD Assumptions）。
    transport: str = "streamable_http"


CONNECTORS: dict[str, ConnectorDef] = {
    "notion": ConnectorDef(
        connector_id="notion",
        server_url="https://mcp.notion.com/mcp",
        display_name="Notion",
    ),
    "atlassian": ConnectorDef(
        connector_id="atlassian",
        server_url="https://mcp.atlassian.com/v1/mcp/authv2",
        display_name="Atlassian (Jira / Confluence)",
    ),
}


def get_connector_def(connector_id: str) -> ConnectorDef:
    """按 id 取定义；未知 id → KeyError（router 转 404，client 转 E_CONNECTOR_UNKNOWN）。"""
    try:
        return CONNECTORS[connector_id]
    except KeyError:
        raise KeyError(f"unknown connector: {connector_id!r} (known: {sorted(CONNECTORS)})") from None


def namespace_for(connector_id: str) -> str:
    """``external_credential`` 分区键（``connector:notion`` 风格，阶段 0a 约定）。"""
    return f"connector:{connector_id}"


#: OAuth 回调路径（DCR 注册的固定 redirect_uri 的 path 部分；router 挂同一路径）。
CALLBACK_PATH = "/api/connector/oauth/callback"


def resolve_redirect_uri() -> str:
    """固定端口 loopback redirect_uri（排雷报告 §四：DCR 自注册固定 URI，不用 CIMD）。

    serve-api 恒 bind 127.0.0.1；端口读 ``MAILAGENT_API_PORT``（进程注入键，默认 8200 ——
    与 ``island_agent.resolve_api_port`` 同源同默认）。127.0.0.1 vs localhost 的白名单
    接受度 = owner spike 第一步（风险 1）。
    """
    port = os.environ.get("MAILAGENT_API_PORT", "8200")
    return f"http://127.0.0.1:{port}{CALLBACK_PATH}"
