"""Shared helpers and serializers for connector router slices."""

from __future__ import annotations

from typing import Any, NoReturn, Optional

from starlette.concurrency import run_in_threadpool

from src.api.app import APIError

def _require_enabled(settings: Any) -> None:
    if not getattr(settings, "mcp_connectors_enabled", False):
        raise APIError(
            "E_CONNECTOR_DISABLED",
            "MCP connectors are disabled (set MAILAGENT_MCP_CONNECTORS=true and restart serve-api)",
            http_status=409,
        )


def _require_managed_local_enabled(settings: Any) -> None:
    _require_enabled(settings)


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


def _is_custom_row(row: Any) -> bool:
    from src.connectors.catalog import get_direct_entry, get_managed_local_entry
    from src.connectors.composio_catalog import get_catalog_entry

    in_catalog = (
        get_direct_entry(row.connector_id) is not None
        or get_catalog_entry(row.connector_id) is not None
        or get_managed_local_entry(row.connector_id) is not None
    )
    return bool(
        row.source == "custom_mcp"
        and (
            row.transport == "stdio"
            or getattr(row, "custom_header_names", ())
            or not in_catalog
        )
    )


def _managed_summary_fields(row: Any) -> dict[str, Any]:
    if row.source != "managed_local":
        return {
            "stdio_command": getattr(row, "stdio_command", None),
            "runtime_installed": False,
            "runtime_version": None,
            "runtime_mode": None,
            "supported_modes": [],
            "requires_permissions": [],
            "platform_supported": True,
            "runtime_config": None,
        }
    from src.connectors.local_installer import (
        LocalInstallerError,
        get_install_status,
        resolve_stdio_command,
    )

    rc = getattr(row, "runtime_config", None)
    try:
        st = get_install_status(row.connector_id, rc)
        cmd = resolve_stdio_command(row.connector_id, rc)
        return {
            "stdio_command": cmd,
            "runtime_installed": bool(st["installed"]),
            "runtime_version": st["version"],
            "runtime_mode": st["mode"],
            "supported_modes": list(st["supported_modes"]),
            "requires_permissions": list(st["requires_permissions"]),
            "platform_supported": bool(st["platform_supported"]),
            "runtime_config": st["runtime_config"],
        }
    except LocalInstallerError:
        return {
            "stdio_command": None,
            "runtime_installed": False,
            "runtime_version": None,
            "runtime_mode": None,
            "supported_modes": [],
            "requires_permissions": [],
            "platform_supported": False,
            "runtime_config": rc,
        }


def _serialize_connector_summary(
    row: Any,
    cred: dict[str, Any],
    flow: Any,
    *,
    managed_meta: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    from src.connectors.catalog import row_is_off_track

    cid = row.connector_id
    meta = managed_meta if managed_meta is not None else _managed_summary_fields(row)
    return {
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
        "source": row.source,
        "superseded_by_catalog": row_is_off_track(row.source, cid),
        "is_custom": _is_custom_row(row),
        "custom_header_names": list(getattr(row, "custom_header_names", ()) or ()),
        "stdio_command": meta["stdio_command"],
        "stdio_env_keys": list(getattr(row, "stdio_env_keys", ()) or ()),
        "runtime_installed": meta["runtime_installed"],
        "runtime_version": meta["runtime_version"],
        "runtime_mode": meta["runtime_mode"],
        "supported_modes": meta["supported_modes"],
        "requires_permissions": meta["requires_permissions"],
        "platform_supported": meta["platform_supported"],
        "runtime_config": meta["runtime_config"],
        "credential": cred,
        "flow": flow,
    }

