"""Connector CRUD, custom MCP, catalog, managed install, tools, and disconnect routes."""

from __future__ import annotations

import re
import time
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Depends, Query, Request
from loguru import logger
from starlette.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings
from src.api.routers.connector_common import (
    _connector_def,
    _credential_view,
    _flow_view,
    _is_custom_row,
    _managed_summary_fields,
    _raise_from_connector_error,
    _require_enabled,
    _require_managed_local_enabled,
    _serialize_connector_summary,
    _store,
)

router = APIRouter()


async def list_connectors(request: Request, settings=Depends(get_settings)) -> Any:
    """**已配置的** connector 行 ∪ 凭证健康 ∪ 在途流。

    🔴 08-05 WP-12 语义变更：以前这里列的是 registry 硬编码全集（连没连过的两家也在），
    现在 registry 常量已退役 —— **列表 = `connector` 表里的行**（connector 行升为一等实体，
    顺手关掉已知限界 §9.3 的僵尸行：库里有的就一定看得见、删得掉）。「还没连过的服务」由
    `GET /catalog` 的预置目录承担，两处不重复渲染同一家。
    """
    _require_enabled(settings)
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for

    store = _store()
    rows = await run_in_threadpool(store.list_connectors)
    items = []
    for row in rows:
        cid = row.connector_id
        cred = await run_in_threadpool(_credential_view, namespace_for(cid))
        meta = await run_in_threadpool(_managed_summary_fields, row)
        items.append(
            _serialize_connector_summary(
                row, cred, _flow_view(get_flow(cid)), managed_meta=meta
            )
        )
    return success_envelope({"connectors": items}, request=request)


_CUSTOM_CONNECTOR_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")


def _validate_http_endpoint(url: str, *, transport: str = "streamable_http") -> str:
    cleaned = url.strip()
    if not cleaned:
        raise APIError("E_INVALID_ARG", f"server_url is required for {transport}", http_status=400)
    parsed = urlparse(cleaned)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host:
        return cleaned
    if parsed.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        return cleaned
    raise APIError(
        "E_INVALID_ARG",
        "server_url must use https:// (or http:// for localhost/127.0.0.1/[::1])",
        http_status=400,
    )


def _validate_str_dict(raw: Any, field_name: str) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise APIError("E_INVALID_ARG", f"{field_name} must be a JSON object", http_status=400)
    out: dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not k.strip() or not isinstance(v, str):
            raise APIError(
                "E_INVALID_ARG",
                f"{field_name} keys must be non-empty strings and values must be strings",
                http_status=400,
            )
        out[k.strip()] = v
    return out


def _parse_stdio_payload(body: dict[str, Any], *, existing: Any = None) -> dict[str, Any]:
    nested = body.get("stdio_command")
    if nested is not None and not isinstance(nested, dict):
        raise APIError("E_INVALID_ARG", "stdio_command must be an object", http_status=400)
    src = nested if isinstance(nested, dict) else body
    if "command" in src:
        raw_cmd = src.get("command")
    elif existing is not None and existing.stdio_command:
        raw_cmd = existing.stdio_command.get("command")
    else:
        raw_cmd = None
    if not isinstance(raw_cmd, str) or not raw_cmd.strip():
        raise APIError("E_INVALID_ARG", "command is required for stdio connector", http_status=400)

    if "args" in src:
        raw_args = src.get("args")
        if raw_args is None:
            args_list: list[str] = []
        elif isinstance(raw_args, list) and all(isinstance(x, str) for x in raw_args):
            args_list = list(raw_args)
        else:
            raise APIError("E_INVALID_ARG", "args must be a list of strings", http_status=400)
    elif existing is not None and existing.stdio_command:
        args_list = list(existing.stdio_command.get("args") or [])
    else:
        args_list = []

    if "cwd" in src:
        raw_cwd = src.get("cwd")
        if raw_cwd is not None and not isinstance(raw_cwd, str):
            raise APIError("E_INVALID_ARG", "cwd must be a string or null", http_status=400)
        cwd_val = raw_cwd.strip() if isinstance(raw_cwd, str) and raw_cwd.strip() else None
    elif existing is not None and existing.stdio_command:
        cwd_val = existing.stdio_command.get("cwd")
    else:
        cwd_val = None

    return {"command": raw_cmd.strip(), "args": args_list, "cwd": cwd_val}


@router.post("/custom", dependencies=[Depends(verify_local_token)])
async def create_custom_connector(
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """创建自定义 MCP connector（HTTP 静态 header 或本机 lazy stdio 进程）。

    🔴 鉴权 = ``Depends(verify_local_token)``（仅本机 desktop renderer / loopback，
    禁止远程 CF JWT 任意拉起本机子进程或探测内网 HTTP 端点）。
    """
    _require_enabled(settings)
    from src.agent_config.store import CONNECTOR_TRANSPORTS
    from src.connectors.catalog import get_direct_entry, get_managed_local_entry
    from src.connectors.composio_catalog import get_catalog_entry
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for

    cid_raw = payload.get("connector_id")
    if not isinstance(cid_raw, str) or not _CUSTOM_CONNECTOR_ID_RE.match(cid_raw.strip()):
        raise APIError(
            "E_INVALID_ARG",
            f"connector_id must match {_CUSTOM_CONNECTOR_ID_RE.pattern}",
            http_status=400,
        )
    cid = cid_raw.strip()
    if (
        get_direct_entry(cid) is not None
        or get_catalog_entry(cid) is not None
        or get_managed_local_entry(cid) is not None
    ):
        raise APIError(
            "E_CONFLICT",
            f"connector_id {cid!r} conflicts with a built-in catalog connector",
            http_status=409,
        )

    store = _store()
    existing = await run_in_threadpool(store.get_connector, cid)
    if existing is not None:
        raise APIError("E_CONFLICT", f"connector {cid!r} already exists", http_status=409)

    display_raw = payload.get("display_name")
    if not isinstance(display_raw, str) or not display_raw.strip():
        raise APIError("E_INVALID_ARG", "display_name is required", http_status=400)
    display_name = display_raw.strip()

    transport = payload.get("transport", "streamable_http")
    if transport not in CONNECTOR_TRANSPORTS:
        raise APIError(
            "E_INVALID_ARG",
            f"transport must be one of {list(CONNECTOR_TRANSPORTS)}",
            http_status=400,
        )

    server_url = ""
    custom_headers: Optional[dict[str, str]] = None
    stdio_cmd: Optional[dict[str, Any]] = None
    stdio_env: Optional[dict[str, str]] = None
    if transport in ("streamable_http", "sse"):
        raw_url = payload.get("server_url")
        if not isinstance(raw_url, str):
            raise APIError("E_INVALID_ARG", "server_url must be a string", http_status=400)
        server_url = _validate_http_endpoint(raw_url, transport=transport)
        if "headers" in payload and payload["headers"] is not None:
            custom_headers = _validate_str_dict(payload["headers"], "headers")
    else:
        stdio_cmd = _parse_stdio_payload(payload)
        if "env" in payload and payload["env"] is not None:
            stdio_env = _validate_str_dict(payload["env"], "env")

    row = await run_in_threadpool(
        lambda: store.upsert_custom_connector(
            cid,
            display_name=display_name,
            transport=transport,
            server_url=server_url,
            custom_headers=custom_headers,
            replace_headers=custom_headers is not None,
            stdio_command=stdio_cmd,
            stdio_env=stdio_env,
            replace_env=stdio_env is not None,
        )
    )
    cred = await run_in_threadpool(_credential_view, namespace_for(cid))
    return success_envelope(
        _serialize_connector_summary(row, cred, _flow_view(get_flow(cid))),
        request=request,
    )


@router.patch("/custom/{connector_id}", dependencies=[Depends(verify_local_token)])
async def update_custom_connector(
    connector_id: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """更新自定义 MCP connector；省略 headers/env 保留原有加密配置，传 `{}` 清空。"""
    _require_enabled(settings)
    from src.agent_config.store import CONNECTOR_TRANSPORTS
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for
    from src.connectors.stdio_pool import stdio_pool

    store = _store()
    existing = await run_in_threadpool(store.get_connector, connector_id)
    if existing is None:
        raise APIError("E_NOT_FOUND", f"connector {connector_id!r} not found", http_status=404)
    if not _is_custom_row(existing):
        raise APIError(
            "E_INVALID_ARG",
            f"connector {connector_id!r} is a catalog connector and cannot be edited here",
            http_status=400,
        )

    display_name = existing.display_name or connector_id
    if "display_name" in payload:
        if not isinstance(payload["display_name"], str) or not payload["display_name"].strip():
            raise APIError("E_INVALID_ARG", "display_name must be a non-empty string", http_status=400)
        display_name = payload["display_name"].strip()

    transport = payload.get("transport", existing.transport or "streamable_http")
    if transport not in CONNECTOR_TRANSPORTS:
        raise APIError(
            "E_INVALID_ARG",
            f"transport must be one of {list(CONNECTOR_TRANSPORTS)}",
            http_status=400,
        )

    server_url = existing.server_url or ""
    custom_headers: Optional[dict[str, str]] = None
    replace_headers = False
    stdio_cmd: Optional[dict[str, Any]] = None
    stdio_env: Optional[dict[str, str]] = None
    replace_env = False

    if transport in ("streamable_http", "sse"):
        if "server_url" in payload:
            if not isinstance(payload["server_url"], str):
                raise APIError("E_INVALID_ARG", "server_url must be a string", http_status=400)
            server_url = _validate_http_endpoint(payload["server_url"], transport=transport)
        else:
            server_url = _validate_http_endpoint(server_url, transport=transport)
        if "headers" in payload:
            if payload["headers"] is None:
                custom_headers = {}
            else:
                custom_headers = _validate_str_dict(payload["headers"], "headers")
            replace_headers = True
    else:
        server_url = ""
        stdio_cmd = _parse_stdio_payload(payload, existing=existing)
        if "env" in payload:
            if payload["env"] is None:
                stdio_env = {}
            else:
                stdio_env = _validate_str_dict(payload["env"], "env")
            replace_env = True

    await stdio_pool.close_connector(connector_id)
    row = await run_in_threadpool(
        lambda: store.upsert_custom_connector(
            connector_id,
            display_name=display_name,
            transport=transport,
            server_url=server_url,
            custom_headers=custom_headers,
            replace_headers=replace_headers,
            stdio_command=stdio_cmd,
            stdio_env=stdio_env,
            replace_env=replace_env,
        )
    )
    cred = await run_in_threadpool(_credential_view, namespace_for(connector_id))
    return success_envelope(
        _serialize_connector_summary(row, cred, _flow_view(get_flow(connector_id))),
        request=request,
    )


@router.delete("/custom/{connector_id}", dependencies=[Depends(verify_local_token)])
async def delete_custom_connector(
    connector_id: str,
    request: Request,
    settings=Depends(get_settings),
) -> Any:
    """删除自定义 MCP connector（关闭在途 stdio 进程 + 清除凭证与工具行）。"""
    _require_enabled(settings)
    from src.agent_config.credentials import delete_credential, list_credentials
    from src.connectors.registry import namespace_for
    from src.connectors.stdio_pool import stdio_pool

    store = _store()
    existing = await run_in_threadpool(store.get_connector, connector_id)
    if existing is None:
        raise APIError("E_NOT_FOUND", f"connector {connector_id!r} not found", http_status=404)
    if not _is_custom_row(existing):
        raise APIError(
            "E_INVALID_ARG",
            f"connector {connector_id!r} is not a custom connector — use /disconnect",
            http_status=400,
        )

    await stdio_pool.close_connector(connector_id)
    namespace = namespace_for(connector_id)
    metas = await run_in_threadpool(list_credentials, namespace)
    for meta in metas:
        await run_in_threadpool(delete_credential, namespace, meta.credential_key)
    purged = await run_in_threadpool(store.delete_connector, connector_id)
    return success_envelope(
        {"connector_id": connector_id, "deleted": purged},
        request=request,
    )


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
    from src.connectors.catalog import catalog_views, row_is_off_track, self_hosted_preset_views
    from src.connectors.local_installer import get_install_status

    rows = {r.connector_id: r for r in await run_in_threadpool(_store().list_connectors)}
    key_status = await run_in_threadpool(composio.api_key_status)
    entries = []
    for view in catalog_views(include_managed_local=True):
        row = rows.get(view.connector_id)
        if view.track == "managed_local":
            st = await run_in_threadpool(
                get_install_status,
                view.connector_id,
                row.runtime_config if row else None,
            )
            runtime_fields = {
                "runtime_installed": bool(st["installed"]),
                "runtime_version": st["version"],
                "runtime_mode": st["mode"],
                "supported_modes": list(st["supported_modes"]),
                "requires_permissions": list(st["requires_permissions"]),
                "platform_supported": bool(st["platform_supported"]),
            }
        else:
            runtime_fields = {
                "runtime_installed": False,
                "runtime_version": None,
                "runtime_mode": None,
                "supported_modes": [],
                "requires_permissions": [],
                "platform_supported": True,
            }
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
                **runtime_fields,
            }
        )
    self_hosted_presets = [
        {
            "connector_id": preset.connector_id,
            "display_name": preset.display_name,
            "description_key": preset.description_key,
            "category": preset.category,
            "logo_text": preset.logo_text,
            "logo_color": preset.logo_color,
            "transport": preset.transport,
            "default_server_url": preset.default_server_url,
            "url_placeholder": preset.url_placeholder,
            "auth_header": preset.auth_header,
            "auth_prefix": preset.auth_prefix,
            "configured": preset.connector_id in rows,
        }
        for preset in self_hosted_preset_views()
    ]
    return success_envelope(
        {
            "composio": key_status,
            "entries": entries,
            "self_hosted_presets": self_hosted_presets,
        },
        request=request,
    )


@router.get("/updates", dependencies=[Depends(verify_cf_access)])
async def connector_updates(
    request: Request,
    force: bool = Query(False),
    include_remote: bool = Query(True),
    settings=Depends(get_settings),
) -> Any:
    """检测 managed_local 运行时版本更新与已连接远端 MCP 工具清单漂移（600s TTL 缓存）。"""
    _require_enabled(settings)
    from src.connectors.update_check import check_connector_updates

    data = await check_connector_updates(
        _store(),
        force=force,
        include_remote=include_remote,
    )
    return success_envelope(data, request=request)



@router.get("/{connector_id}/install-status", dependencies=[Depends(verify_local_token)])
async def managed_install_status(
    connector_id: str,
    request: Request,
    settings=Depends(get_settings),
) -> Any:
    """查看受管本机连接器安装状态与配置摘要（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.local_installer import LocalInstallerError, get_install_status

    row = await run_in_threadpool(_store().get_connector, connector_id)
    try:
        data = await run_in_threadpool(
            get_install_status,
            connector_id,
            row.runtime_config if row else None,
        )
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    return success_envelope(data, request=request)


async def _execute_managed_runtime_install(
    connector_id: str,
    store: Any,
    entry: Any,
    normalized_rc: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    from src.connectors.client import ConnectorClient
    from src.connectors.local_installer import LocalInstallerError, install_runtime
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import get_connector_def, namespace_for
    from src.connectors.stdio_pool import stdio_pool
    from src.connectors.update_check import invalidate_connector_update_cache

    await stdio_pool.invalidate(connector_id)
    try:
        status_view = await run_in_threadpool(install_runtime, connector_id, normalized_rc)
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None

    await run_in_threadpool(
        lambda: store.upsert_connector(
            connector_id,
            server_url="",
            display_name=entry.display_name,
            transport="stdio",
            source="managed_local",
            runtime_config=normalized_rc,
        )
    )
    await run_in_threadpool(
        lambda: store.update_connector_state(
            connector_id,
            status="connected",
            last_error=None,
        )
    )

    try:
        definition = await run_in_threadpool(get_connector_def, connector_id)
        client = ConnectorClient(connector_id, interactive=False, definition=definition)
        tools = await client.list_tools_manifest()
        await run_in_threadpool(store.sync_connector_tools, connector_id, tools)
        await run_in_threadpool(
            lambda: store.update_connector_state(
                connector_id,
                status="connected",
                last_error=None,
                last_synced_at=int(time.time()),
            )
        )
    except Exception as sync_err:  # noqa: BLE001 — 安装/更新成功后初始同步失败保留运行时与行
        logger.warning(
            "[connector] tool sync skipped/failed after install/update for {}: {}",
            connector_id,
            sync_err,
        )

    invalidate_connector_update_cache()
    row = await run_in_threadpool(store.get_connector, connector_id)
    cred = await run_in_threadpool(_credential_view, namespace_for(connector_id))
    meta = await run_in_threadpool(_managed_summary_fields, row)
    summary = _serialize_connector_summary(
        row, cred, _flow_view(get_flow(connector_id)), managed_meta=meta
    )
    return status_view, summary


@router.post("/{connector_id}/install", dependencies=[Depends(verify_local_token)])
async def install_managed_connector(
    connector_id: str,
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
    settings=Depends(get_settings),
) -> Any:
    """一键安装受管本机 stdio MCP 运行时（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.catalog import get_managed_local_entry
    from src.connectors.local_installer import LocalInstallerError, normalize_runtime_options

    entry = get_managed_local_entry(connector_id)
    if entry is None:
        raise APIError(
            "E_CONNECTOR_UNSUPPORTED",
            f"connector {connector_id!r} is not a managed_local catalog entry",
            http_status=404,
        )

    store = _store()
    existing = await run_in_threadpool(store.get_connector, connector_id)
    try:
        normalized_rc = normalize_runtime_options(
            connector_id,
            payload or {},
            existing=existing.runtime_config if existing else None,
        )
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None

    status_view, summary = await _execute_managed_runtime_install(
        connector_id, store, entry, normalized_rc
    )
    return success_envelope(
        {
            "ok": True,
            **status_view,
            "status": dict(status_view),
            "connector": summary,
        },
        request=request,
    )


@router.post("/{connector_id}/uninstall", dependencies=[Depends(verify_local_token)])
async def uninstall_managed_connector(
    connector_id: str,
    request: Request,
    settings=Depends(get_settings),
) -> Any:
    """卸载受管本机运行时、关闭 stdio 池并清库行（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.local_installer import LocalInstallerError, uninstall_runtime
    from src.connectors.stdio_pool import stdio_pool
    from src.connectors.update_check import invalidate_connector_update_cache

    await stdio_pool.invalidate(connector_id)
    try:
        status_view = await run_in_threadpool(uninstall_runtime, connector_id)
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    await run_in_threadpool(_store().delete_connector, connector_id)
    invalidate_connector_update_cache()
    return success_envelope(
        {
            "ok": True,
            **status_view,
            "status": dict(status_view),
            "connector": None,
        },
        request=request,
    )


@router.patch("/{connector_id}/runtime-options", dependencies=[Depends(verify_local_token)])
async def update_managed_runtime_options(
    connector_id: str,
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """切换受管连接器运行选项（如 Chrome CDP/Extension/Isolated），仅 Desktop loopback。"""
    _require_managed_local_enabled(settings)
    from src.connectors.local_installer import (
        LocalInstallerError,
        get_install_status,
        normalize_runtime_options,
    )
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for
    from src.connectors.stdio_pool import stdio_pool

    store = _store()
    existing = await run_in_threadpool(store.get_connector, connector_id)
    if existing is None:
        raise APIError(
            "E_NOT_FOUND",
            f"connector {connector_id!r} is not installed",
            http_status=404,
        )
    if existing.source != "managed_local":
        raise APIError(
            "E_CONNECTOR_UNSUPPORTED",
            f"connector {connector_id!r} does not use managed_local runtime options",
            http_status=400,
        )
    try:
        normalized_rc = normalize_runtime_options(
            connector_id, payload, existing=existing.runtime_config
        )
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None

    updated = await run_in_threadpool(
        store.update_connector_runtime_config, connector_id, normalized_rc
    )
    await stdio_pool.invalidate(connector_id)

    status_view = await run_in_threadpool(get_install_status, connector_id, normalized_rc)
    cred = await run_in_threadpool(_credential_view, namespace_for(connector_id))
    meta = await run_in_threadpool(_managed_summary_fields, updated)
    summary = _serialize_connector_summary(
        updated, cred, _flow_view(get_flow(connector_id)), managed_meta=meta
    )
    return success_envelope(
        {
            "ok": True,
            "connector_id": connector_id,
            "mode": status_view["mode"],
            "browser_mode": status_view["mode"],
            "runtime_config": normalized_rc,
            "connector": summary,
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


async def _execute_connector_sync(connector_id: str) -> dict[str, Any]:
    definition = await _connector_def(connector_id)
    from src.connectors.client import ConnectorClient, ConnectorError
    from src.connectors.gate import ConnectorBusy
    from src.connectors.service import (
        CONNECTOR_REAUTH_MESSAGE,
        should_mark_needs_reauth,
    )
    from src.connectors.update_check import invalidate_connector_update_cache

    store = _store()
    row = await run_in_threadpool(store.get_connector, connector_id)
    if row is None or (definition.transport != "stdio" and not definition.server_url):
        raise APIError(
            "E_CONNECTOR_NOT_CONNECTED",
            f"connector {connector_id!r} has not been connected yet — connect it first",
            http_status=409,
        )
    if not definition.is_custom:
        await run_in_threadpool(
            store.upsert_connector,
            connector_id,
            server_url=definition.server_url,
            display_name=definition.display_name,
            transport=definition.transport,
        )
    client = ConnectorClient(connector_id, interactive=False, definition=definition)
    try:
        tools = await client.list_tools_manifest()
    except ConnectorBusy as e:
        raise APIError("E_CONNECTOR_BUSY", str(e), http_status=409) from e
    except ConnectorError as e:
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
    invalidate_connector_update_cache()
    return {"connector_id": connector_id, **stats}


@router.post("/{connector_id}/sync", dependencies=[Depends(verify_cf_access)])
async def sync_tools(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """用已存授权拉工具清单落库（非交互：无授权 → 409 引导走 oauth/start，不挂浏览器）。"""
    _require_enabled(settings)
    data = await _execute_connector_sync(connector_id)
    return success_envelope(data, request=request)


@router.post("/{connector_id}/update", dependencies=[Depends(verify_cf_access)])
async def update_connector(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """一键更新受管本机运行时（保留既有 runtime_config，仅 Desktop loopback），或同步远端工具清单。"""
    _require_enabled(settings)
    from src.connectors.catalog import get_managed_local_entry
    from src.connectors.local_installer import (
        LocalInstallerError,
        get_install_status,
        normalize_runtime_options,
    )

    entry = get_managed_local_entry(connector_id)
    if entry is not None:
        await verify_local_token(request)
        _require_managed_local_enabled(settings)
        store = _store()
        existing = await run_in_threadpool(store.get_connector, connector_id)
        prev_status = await run_in_threadpool(
            get_install_status,
            connector_id,
            existing.runtime_config if existing else None,
        )
        try:
            normalized_rc = normalize_runtime_options(
                connector_id,
                {},
                existing=existing.runtime_config if existing else None,
            )
        except LocalInstallerError as e:
            raise APIError(e.code, e.message, http_status=e.status_code) from None
        status_view, summary = await _execute_managed_runtime_install(
            connector_id, store, entry, normalized_rc
        )
        return success_envelope(
            {
                "ok": True,
                "connector_id": connector_id,
                "previousVersion": prev_status.get("version"),
                "currentVersion": status_view.get("version"),
                **status_view,
                "status": dict(status_view),
                "connector": summary,
            },
            request=request,
        )

    sync_data = await _execute_connector_sync(connector_id)
    return success_envelope({"ok": True, **sync_data}, request=request)


@router.get("/{connector_id}/tools", dependencies=[Depends(verify_cf_access)])
async def list_tools(
    connector_id: str, request: Request, settings=Depends(get_settings)
) -> Any:
    """已同步工具清单（PR2 的 ``createConnectorTools()`` 读这里）。

    per-tool 三档：``mode_override`` = 用户覆盖原样（null=跟随默认），
    ``effective_mode`` = 服务端折算（非破坏性 read 默认 ``auto``，write/update/destructive
    默认 ``ask``；折算**不在前端重算**——那会成第二处手抄）。orphan 行照常在列（注册侧跳过它们）。
    ``destructive`` 原样透出 —— 设置面 / 审批卡的红警告读它。

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
                    "effective_mode": connector_tool_effective_mode(
                        r.mode, crud_type=r.crud_type, destructive=r.destructive
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

    ``null`` = 清除覆盖回默认档（只读非破坏默认 ``auto``；写/更新/破坏默认 ``ask``）——
    与「显式 off」不是一回事，故键必须在场
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
            "effective_mode": connector_tool_effective_mode(
                row.mode, crud_type=row.crud_type, destructive=row.destructive
            ),
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

    ``caller``（PR3 新增，可选）：``{"context_mode": str, "agent_id": str|null, "job_id"?: int, "dispatch_id"?: int, "child_tool"?: str}``。
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
        is_computer_use_child_destructive_denied,
        is_matter_computer_use_child_authorized,
        is_matter_followup_caller,
        resolve_caller_allowed_tools,
        resolve_caller_ceiling,
    )

    caller = body.get("caller")
    try:
        ceiling = await run_in_threadpool(
            resolve_caller_ceiling, caller, connector_id
        )
        allowed_tools = await run_in_threadpool(
            resolve_caller_allowed_tools, caller, connector_id
        )
        # 0813 批 P —— matter_followup 是无审批链宿主的无人值守场地：ask ≙ 不可用 +
        # destructive 恒拒（gateway 注册期 matterVenueAdmitsEntry 是第一道，这里是
        # 判定与执行同侧的第二道；其余调用面两个开关恒 False，字节不变）。
        # WS-5 Belt 3 —— 若 DB 实证核验是 active running propose_only 行动项的
        # computer_use_run 子代理调 browser_use/desktop_use，豁免 deny_ask_mode（但保留 deny_destructive）。
        matter_venue = is_matter_followup_caller(caller)
        matter_child_granted = (
            await run_in_threadpool(
                is_matter_computer_use_child_authorized, caller, connector_id
            )
            if matter_venue
            else False
        )
        deny_destructive = matter_venue or await run_in_threadpool(
            is_computer_use_child_destructive_denied, caller, connector_id
        )
        invoke_kwargs: dict[str, Any] = {
            "ceiling": ceiling,
            "deny_ask_mode": matter_venue and not matter_child_granted,
            "deny_destructive": deny_destructive,
        }
        if allowed_tools is not None:
            invoke_kwargs["allowed_tools"] = allowed_tools
        result = await invoke_connector_tool(
            connector_id,
            tool_name,
            body.get("arguments"),
            **invoke_kwargs,
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
    from src.connectors.stdio_pool import stdio_pool

    await stdio_pool.close_connector(connector_id)
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

