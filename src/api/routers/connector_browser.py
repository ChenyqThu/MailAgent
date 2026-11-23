"""Managed local browser and macOS permission routes for connectors."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from loguru import logger
from starlette.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token, verify_websocket_access
from src.api.deps import get_settings
from src.api.routers.connector_common import (
    _credential_view,
    _flow_view,
    _managed_summary_fields,
    _require_enabled,
    _require_managed_local_enabled,
    _serialize_connector_summary,
    _store,
)

router = APIRouter()

@router.get("/system-permissions", dependencies=[Depends(verify_local_token)])
async def system_permissions(request: Request, settings=Depends(get_settings)) -> Any:
    """检测本机 TCC 权限（仅 Desktop loopback，拒绝远程 CF JWT）。"""
    _require_enabled(settings)
    from src.connectors.local_installer import check_system_permissions

    data = await run_in_threadpool(check_system_permissions)
    return success_envelope(data, request=request)


@router.post("/system-permissions/open", dependencies=[Depends(verify_local_token)])
async def open_system_permissions(
    request: Request,
    payload: dict[str, Any] = Body(...),
    settings=Depends(get_settings),
) -> Any:
    """打开 macOS 系统设置 TCC 面板（仅 Desktop loopback）。"""
    _require_enabled(settings)
    from src.connectors.local_installer import (
        LocalInstallerError,
        open_system_permission_pane,
    )

    kind = payload.get("kind") or payload.get("permission")
    if not isinstance(kind, str) or not kind.strip():
        raise APIError(
            "E_INVALID_ARG",
            "kind must be 'accessibility' or 'screen_recording'",
            http_status=400,
        )
    try:
        data = await run_in_threadpool(open_system_permission_pane, kind.strip())
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    return success_envelope(data, request=request)


@router.get("/browser_use/chrome-profiles", dependencies=[Depends(verify_local_token)])
async def list_browser_chrome_profiles(
    request: Request, settings=Depends(get_settings)
) -> Any:
    """列出本机 Chrome Profile 列表供一键导入凭据（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.chrome_import import list_chrome_profiles

    profiles = await run_in_threadpool(list_chrome_profiles)
    return success_envelope({"profiles": profiles}, request=request)


@router.get("/browser_use/chrome-domains", dependencies=[Depends(verify_local_token)])
async def list_browser_chrome_domains(
    request: Request,
    profile_id: str = "Default",
    settings=Depends(get_settings),
) -> Any:
    """按域名汇总 Chrome Profile 可导入 Cookie 数量（绝不返回明文值，亦不触发 Keychain 弹窗）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.chrome_import import list_chrome_cookie_domains
    from src.connectors.local_installer import LocalInstallerError

    try:
        data = await run_in_threadpool(list_chrome_cookie_domains, profile_id)
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    return success_envelope(data, request=request)


@router.get("/browser_use/cookies/domains", dependencies=[Depends(verify_local_token)])
async def list_managed_browser_cookie_domains(
    request: Request,
    settings=Depends(get_settings),
) -> Any:
    """查看内置浏览器当前已保存登录态的域名与数量（绝不返回明文 Cookie 值）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.chrome_import import list_managed_cookie_domains
    from src.connectors.local_installer import LocalInstallerError

    try:
        data = await run_in_threadpool(list_managed_cookie_domains)
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    return success_envelope(data, request=request)


@router.post("/browser_use/cookies/clear", dependencies=[Depends(verify_local_token)])
async def clear_managed_browser_cookies(
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
    settings=Depends(get_settings),
) -> Any:
    """清除内置浏览器指定域名或全部已保存 Cookie（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.chrome_import import clear_managed_cookies
    from src.connectors.local_installer import LocalInstallerError
    from src.connectors.stdio_pool import stdio_pool

    raw = payload or {}
    domain = raw.get("domain")
    if domain is not None and not isinstance(domain, str):
        raise APIError("E_INVALID_ARG", "domain must be a string", http_status=400)

    await stdio_pool.invalidate("browser_use")
    try:
        data = await run_in_threadpool(clear_managed_cookies, domain)
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    return success_envelope(data, request=request)


@router.post("/browser_use/import-chrome-cookies", dependencies=[Depends(verify_local_token)])
async def import_browser_chrome_cookies(
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
    settings=Depends(get_settings),
) -> Any:
    """从本机 Chrome 导入 Cookie 至内置受管浏览器持久目录（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.chrome_import import import_chrome_cookies
    from src.connectors.local_installer import LocalInstallerError, normalize_runtime_options
    from src.connectors.oauth_flow import get_flow
    from src.connectors.registry import namespace_for
    from src.connectors.stdio_pool import stdio_pool

    raw = payload or {}
    profile_id = raw.get("profile_id") or "Default"
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise APIError("E_INVALID_ARG", "profile_id must be a non-empty string", http_status=400)
    raw_domains = raw.get("domain_filters")
    domain_filters: Optional[list[str]] = None
    if raw_domains is not None:
        if not isinstance(raw_domains, list) or not all(isinstance(d, str) for d in raw_domains):
            raise APIError(
                "E_INVALID_ARG",
                "domain_filters must be a list of domain strings",
                http_status=400,
            )
        cleaned = [d.strip() for d in raw_domains if d.strip()]
        domain_filters = cleaned or None

    await stdio_pool.invalidate("browser_use")
    try:
        imported = await run_in_threadpool(
            import_chrome_cookies,
            profile_id.strip(),
            domain_filters=domain_filters,
        )
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    except (TimeoutError, asyncio.TimeoutError):
        raise APIError(
            "E_COOKIE_INJECT_FAILED",
            "向内置浏览器写入登录态超时，请重试。",
            http_status=504,
        ) from None

    store = _store()
    existing = await run_in_threadpool(store.get_connector, "browser_use")
    updated_rc: Optional[dict[str, Any]] = None
    summary: Optional[dict[str, Any]] = None
    if existing is not None and existing.source == "managed_local":
        base_rc = normalize_runtime_options("browser_use", existing.runtime_config)
        base_rc["last_imported_profile"] = imported["profile_id"]
        base_rc["last_imported_at"] = int(time.time())
        base_rc["last_imported_count"] = imported["imported"]
        updated_row = await run_in_threadpool(
            store.update_connector_runtime_config, "browser_use", base_rc
        )
        updated_rc = base_rc
        cred = await run_in_threadpool(_credential_view, namespace_for("browser_use"))
        meta = await run_in_threadpool(_managed_summary_fields, updated_row)
        summary = _serialize_connector_summary(
            updated_row, cred, _flow_view(get_flow("browser_use")), managed_meta=meta
        )

    return success_envelope(
        {
            **imported,
            "runtime_config": updated_rc,
            "connector": summary,
        },
        request=request,
    )


@router.post("/browser_use/launch-window", dependencies=[Depends(verify_local_token)])
async def launch_browser_managed_window(
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
    settings=Depends(get_settings),
) -> Any:
    """以可视窗口模式打开内置受管浏览器供手动登录或检查状态（仅 Desktop loopback）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.chrome_import import launch_managed_browser_window
    from src.connectors.local_installer import LocalInstallerError
    from src.connectors.managed_browser import managed_browser
    from src.connectors.stdio_pool import stdio_pool

    raw = payload or {}
    start_url = raw.get("url")
    if start_url is not None and not isinstance(start_url, str):
        raise APIError("E_INVALID_ARG", "url must be a string", http_status=400)

    await stdio_pool.invalidate("browser_use")
    await managed_browser.stop()
    try:
        res = await run_in_threadpool(launch_managed_browser_window, start_url=start_url)
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None
    return success_envelope(res, request=request)


@router.post("/browser_use/desktop-bridge", dependencies=[Depends(verify_local_token)])
async def register_browser_desktop_bridge(
    request: Request,
    payload: Optional[dict[str, Any]] = Body(default=None),
) -> Any:
    """Electron 主进程注册或注销原生 WebContentsView 浏览器 loopback CDP/Cookie 桥接。"""
    from src.connectors.desktop_bridge import desktop_browser_bridge
    from src.connectors.stdio_pool import stdio_pool

    raw = payload or {}
    active = bool(raw.get("active"))
    if active:
        cdp_ws_url = raw.get("cdp_ws_url")
        control_url = raw.get("control_url")
        if not isinstance(cdp_ws_url, str) or not isinstance(control_url, str):
            raise APIError(
                "E_INVALID_ARG",
                "cdp_ws_url and control_url are required when active=true",
                http_status=400,
            )
        try:
            desktop_browser_bridge.register(
                cdp_ws_url,
                control_url,
                control_token=request.headers.get("X-MailAgent-Local-Token"),
            )
        except ValueError as e:
            raise APIError("E_INVALID_ARG", str(e), http_status=400) from None
    else:
        desktop_browser_bridge.clear()

    await stdio_pool.invalidate("browser_use")
    return success_envelope({"active": active}, request=request)


@router.get("/browser_use/live/status", dependencies=[Depends(verify_cf_access)])
async def browser_live_status(request: Request, settings=Depends(get_settings)) -> Any:
    """只读查看内置受管浏览器的安装态、运行态与打开标签列表（永不拉起进程）。"""
    _require_managed_local_enabled(settings)
    from src.connectors.desktop_bridge import desktop_browser_bridge
    from src.connectors.local_installer import LocalInstallerError, get_install_status
    from src.connectors.managed_browser import managed_browser

    row = await run_in_threadpool(_store().get_connector, "browser_use")
    try:
        install = await run_in_threadpool(
            get_install_status,
            "browser_use",
            row.runtime_config if row else None,
        )
    except LocalInstallerError as e:
        raise APIError(e.code, e.message, http_status=e.status_code) from None

    desktop_alive = await run_in_threadpool(desktop_browser_bridge.is_alive)
    if desktop_alive:
        return success_envelope(
            {
                "installed": bool(install.get("installed")),
                "mode": str(install.get("mode") or "isolated_profile"),
                "headless": bool((install.get("runtime_config") or {}).get("headless", True)),
                "running": True,
                "engine": "electron_native",
                "cdp_url": None,
                "active_viewers": 1,
                "tabs": [],
            },
            request=request,
        )

    live = await managed_browser.get_status()
    return success_envelope(
        {
            "installed": bool(install.get("installed")),
            "mode": str(install.get("mode") or "isolated_profile"),
            "headless": bool((install.get("runtime_config") or {}).get("headless", True)),
            "running": bool(live.get("running")),
            "engine": "headless_screencast",
            "cdp_url": live.get("cdp_url"),
            "active_viewers": int(live.get("active_viewers") or 0),
            "tabs": live.get("tabs") or [],
        },
        request=request,
    )


@router.post("/browser_use/live/stop", dependencies=[Depends(verify_cf_access)])
async def stop_browser_live(request: Request, settings=Depends(get_settings)) -> Any:
    """停止内置受管 Chromium 进程与 Browser Use stdio 会话池。"""
    _require_managed_local_enabled(settings)
    from src.connectors.managed_browser import managed_browser
    from src.connectors.stdio_pool import stdio_pool

    await stdio_pool.invalidate("browser_use")
    await managed_browser.stop()
    return success_envelope({"stopped": True}, request=request)


@router.websocket("/browser_use/live")
async def browser_live_websocket(
    websocket: WebSocket,
    settings=Depends(get_settings),
) -> None:
    """WebSocket 双向桥：向界面推送受管浏览器实时画面并转发键鼠与导航指令。"""
    try:
        await verify_websocket_access(websocket)
    except HTTPException:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    from src.connectors.local_installer import LocalInstallerError, get_install_status
    from src.connectors.managed_browser import managed_browser

    try:
        _require_managed_local_enabled(settings)
        row = await run_in_threadpool(_store().get_connector, "browser_use")
        install = await run_in_threadpool(
            get_install_status,
            "browser_use",
            row.runtime_config if row else None,
        )
        if not install.get("installed"):
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "E_RUNTIME_NOT_INSTALLED",
                    "message": "请先在设置 → 连接器中一键安装并启用 Browser Use。",
                }
            )
            await websocket.close(code=4409)
            return
        mode = str(install.get("mode") or "isolated_profile")
        if mode != "isolated_profile":
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "E_MODE_NOT_LIVE_VIEWABLE",
                    "message": "当前 Browser Use 未处于「内置受管浏览器」模式，切回该模式后即可在应用内直接查看与操作。",
                }
            )
            await websocket.close(code=4409)
            return

        headless = bool((install.get("runtime_config") or {}).get("headless", True))
        await managed_browser.stream_live_session(websocket, headless=headless)
    except WebSocketDisconnect:
        return
    except APIError as err:
        try:
            await websocket.send_json({"type": "error", "code": err.code, "message": err.message})
            await websocket.close(code=4409)
        except Exception:  # noqa: BLE001
            pass
    except LocalInstallerError as err:
        try:
            await websocket.send_json({"type": "error", "code": err.code, "message": err.message})
            await websocket.close(code=4500)
        except Exception:  # noqa: BLE001
            pass
    except Exception as err:  # noqa: BLE001
        logger.warning("[connector.ws] live session error: {}", err)
        try:
            await websocket.send_json({"type": "error", "code": "E_INTERNAL", "message": str(err)})
            await websocket.close(code=4500)
        except Exception:  # noqa: BLE001
            pass

