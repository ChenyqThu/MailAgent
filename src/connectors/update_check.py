"""MCP 连接器更新检测：managed_local 运行时（npm / GitHub Release）+ 远端 HTTP/SSE 工具清单漂移 + 600s 缓存。"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, Optional

import httpx

from src.agent_config.store import AgentConfigStore, ConnectorRow
from src.connectors.client import ConnectorClient
from src.connectors.local_installer import AGENT_DESKTOP_VERSION, get_install_status
from src.connectors.registry import get_connector_def
from src.skills.update_check import version_gt

_CACHE_TTL_SEC = 600.0
_PROBE_TIMEOUT_SEC = 8.0
_UA = "MailAgent-ConnectorUpdateCheck/1.0"

_CACHE_LOCK = threading.Lock()
_CONNECTOR_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def invalidate_connector_update_cache() -> None:
    """安装 / 更新 / 卸载 / 同步连接器后清空缓存。"""
    with _CACHE_LOCK:
        _CONNECTOR_CACHE.clear()


def _canonical_schema(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return ""
        try:
            obj = json.loads(s)
            return json.dumps(obj, sort_keys=True, ensure_ascii=False)
        except json.JSONDecodeError:
            return s
    return json.dumps(raw, sort_keys=True, ensure_ascii=False)


async def _fetch_npm_latest(client: httpx.AsyncClient, package_encoded: str) -> str:
    resp = await client.get(
        f"https://registry.npmjs.org/{package_encoded}/latest",
        headers={"User-Agent": _UA, "Accept": "application/json"},
    )
    resp.raise_for_status()
    data = resp.json()
    ver = data.get("version") if isinstance(data, dict) else None
    if not isinstance(ver, str) or not ver.strip():
        raise ValueError("missing version in npm registry response")
    return ver.strip()


async def _fetch_github_latest_release(client: httpx.AsyncClient, owner_repo: str) -> Optional[str]:
    resp = await client.get(
        f"https://api.github.com/repos/{owner_repo}/releases/latest",
        headers={"User-Agent": _UA, "Accept": "application/vnd.github+json"},
    )
    resp.raise_for_status()
    data = resp.json()
    tag = data.get("tag_name") if isinstance(data, dict) else None
    return tag.strip() if isinstance(tag, str) and tag.strip() else None


async def _check_browser_use(row: Optional[ConnectorRow], client: httpx.AsyncClient) -> Optional[dict[str, Any]]:
    st = get_install_status("browser_use", row.runtime_config if row else None)
    if not st.get("installed"):
        return None
    installed = st.get("version")
    try:
        latest = await _fetch_npm_latest(client, "@playwright%2Fmcp")
        has_update = version_gt(latest, installed)
        err = None
    except Exception as exc:  # noqa: BLE001
        latest = None
        has_update = False
        err = str(exc)
    return {
        "connector_id": "browser_use",
        "source": "managed_local",
        "updateKind": "runtime_version",
        "installedVersion": installed,
        "latestVersion": latest,
        "upstreamLatestVersion": latest,
        "updateAvailable": has_update,
        "canAutoUpdate": has_update,
        "addedTools": [],
        "removedTools": [],
        "changedTools": [],
        "error": err,
    }


async def _check_desktop_use(row: Optional[ConnectorRow], client: httpx.AsyncClient) -> Optional[dict[str, Any]]:
    st = get_install_status("desktop_use", row.runtime_config if row else None)
    if not st.get("installed"):
        return None
    installed = st.get("version")
    pinned_newer = version_gt(AGENT_DESKTOP_VERSION, installed)
    upstream_tag: Optional[str] = None
    err: Optional[str] = None
    try:
        upstream_tag = await _fetch_github_latest_release(client, "vercel-labs/agent-desktop")
    except Exception as exc:  # noqa: BLE001
        err = str(exc)

    return {
        "connector_id": "desktop_use",
        "source": "managed_local",
        "updateKind": "runtime_version",
        "installedVersion": installed,
        "latestVersion": AGENT_DESKTOP_VERSION,
        "upstreamLatestVersion": upstream_tag,
        "updateAvailable": pinned_newer,
        "canAutoUpdate": pinned_newer,
        "addedTools": [],
        "removedTools": [],
        "changedTools": [],
        "error": err if not pinned_newer else None,
    }


async def _check_remote_connector(row: ConnectorRow, store: AgentConfigStore) -> dict[str, Any]:
    cid = row.connector_id
    try:
        definition = await asyncio.to_thread(get_connector_def, cid)
        mcp_client = ConnectorClient(cid, interactive=False, definition=definition)
        remote_tools = await asyncio.wait_for(
            mcp_client.list_tools_manifest(),
            timeout=_PROBE_TIMEOUT_SEC,
        )
        local_rows = [t for t in store.list_connector_tools(cid) if not t.orphan]
        local_by_name = {t.tool_name: t for t in local_rows}
        remote_by_name = {str(t["name"]): t for t in remote_tools if isinstance(t, dict) and t.get("name")}

        added = sorted(name for name in remote_by_name if name not in local_by_name)
        removed = sorted(name for name in local_by_name if name not in remote_by_name)
        changed: list[str] = []
        for name in sorted(set(local_by_name) & set(remote_by_name)):
            lt = local_by_name[name]
            rt = remote_by_name[name]
            ldesc = (lt.description or "").strip()
            rdesc = str(rt.get("description") or "").strip()
            lschema = _canonical_schema(lt.input_schema_json)
            rschema = _canonical_schema(rt.get("input_schema"))
            if ldesc != rdesc or lschema != rschema:
                changed.append(name)

        has_drift = bool(added or removed or changed)
        return {
            "connector_id": cid,
            "source": row.source,
            "updateKind": "tool_schema_drift",
            "installedVersion": None,
            "latestVersion": None,
            "upstreamLatestVersion": None,
            "updateAvailable": has_drift,
            "canAutoUpdate": has_drift,
            "addedTools": added,
            "removedTools": removed,
            "changedTools": changed,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "connector_id": cid,
            "source": row.source,
            "updateKind": "tool_schema_drift",
            "installedVersion": None,
            "latestVersion": None,
            "upstreamLatestVersion": None,
            "updateAvailable": False,
            "canAutoUpdate": False,
            "addedTools": [],
            "removedTools": [],
            "changedTools": [],
            "error": str(exc),
        }


async def check_connector_updates(
    store: AgentConfigStore,
    *,
    force: bool = False,
    include_remote: bool = True,
) -> dict[str, Any]:
    """检测 managed_local 运行时版本与已连接远端 MCP 工具清单漂移（带 600s 缓存）。"""
    rows = store.list_connectors()
    by_id = {r.connector_id: r for r in rows}
    remote_rows = [
        r
        for r in rows
        if include_remote
        and r.transport != "stdio"
        and r.status == "connected"
        and bool(r.server_url)
    ]
    remote_rows.sort(key=lambda r: r.connector_id)

    browser_st = get_install_status("browser_use", by_id["browser_use"].runtime_config if "browser_use" in by_id else None)
    desktop_st = get_install_status("desktop_use", by_id["desktop_use"].runtime_config if "desktop_use" in by_id else None)
    cache_key = "|".join(
        [
            f"remote={int(include_remote)}",
            f"bu={browser_st.get('installed')}:{browser_st.get('version')}",
            f"du={desktop_st.get('installed')}:{desktop_st.get('version')}",
            *[f"{r.connector_id}:{r.last_synced_at}:{r.status}" for r in remote_rows],
        ]
    )

    now = time.time()
    if not force:
        with _CACHE_LOCK:
            hit = _CONNECTOR_CACHE.get(cache_key)
            if hit and (now - hit[0]) < _CACHE_TTL_SEC:
                return hit[1]

    items: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_SEC, trust_env=False) as client:
        local_tasks = [
            _check_browser_use(by_id.get("browser_use"), client),
            _check_desktop_use(by_id.get("desktop_use"), client),
        ]
        remote_tasks = [_check_remote_connector(r, store) for r in remote_rows]
        results = await asyncio.gather(*local_tasks, *remote_tasks)
        for item in results:
            if item is not None:
                items.append(item)

    items.sort(key=lambda x: x["connector_id"])
    updates_count = sum(1 for item in items if item.get("updateAvailable"))
    result = {
        "checkedAt": int(time.time()),
        "updatesAvailableCount": updates_count,
        "connectors": items,
    }

    with _CACHE_LOCK:
        _CONNECTOR_CACHE.clear()
        _CONNECTOR_CACHE[cache_key] = (time.time(), result)
    return result
