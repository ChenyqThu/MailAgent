"""Desktop Electron 原生 ``WebContentsView`` 浏览器的 loopback CDP/Cookie 桥接。

打包态与 dev 态 Electron 主进程启动目标隔离的 ``EmbeddedBrowserCdpServer`` 后：
  1. 若由 Electron ``BackendLifecycleManager`` 拉起 ``serve-api``，通过进程 env
     （``MAILAGENT_DESKTOP_BROWSER_CDP_WS_URL`` / ``MAILAGENT_DESKTOP_BROWSER_CONTROL_URL``）注入；
  2. 同时通过 ``POST /api/connector/browser_use/desktop-bridge`` 热注册（覆盖 dev 模式外部
     pm2 ``serve-api`` 或 Electron 先/后重启）。

安全契约：
  - 仅接受严格 ``127.0.0.1:<port>`` loopback 地址；
  - WebSocket 路径必须以 ``/cdp/`` 开头；
  - 每次使用前短超时探测 ``GET /health``，不存活时自动回落 Python ``managed_browser``；
  - 绝不把含 token 的 ``cdp_ws_url`` 放进 CLI ``argv``，仅通过环境变量 ``PLAYWRIGHT_MCP_CDP_ENDPOINT``
    传入受控子进程。
"""

from __future__ import annotations

import os
import threading
import urllib.parse
from typing import Any, Optional

import httpx

from src.connectors.local_installer import LocalInstallerError

_ENV_CDP_WS_URL = "MAILAGENT_DESKTOP_BROWSER_CDP_WS_URL"
_ENV_CONTROL_URL = "MAILAGENT_DESKTOP_BROWSER_CONTROL_URL"
_ENV_LOCAL_TOKEN = "MAILAGENT_LOCAL_API_TOKEN"
_LOCAL_TOKEN_HEADER = "X-MailAgent-Local-Token"


def _validate_loopback_url(raw: str, *, expected_scheme: str, require_cdp_path: bool = False) -> str:
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty URL")
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme != expected_scheme:
        raise ValueError(f"invalid scheme {parsed.scheme!r}, expected {expected_scheme!r}")
    if parsed.hostname != "127.0.0.1":
        raise ValueError(f"non-loopback host {parsed.hostname!r} rejected")
    if parsed.port is None or parsed.port <= 0 or parsed.port > 65535:
        raise ValueError(f"invalid port in URL: {raw!r}")
    if parsed.username or parsed.password:
        raise ValueError("credentials not allowed in bridge URL")
    if require_cdp_path:
        if not parsed.path.startswith("/cdp/") or len(parsed.path) <= len("/cdp/"):
            raise ValueError("cdp_ws_url must include /cdp/<token> path")
        return text
    return f"http://127.0.0.1:{parsed.port}"


class DesktopBrowserBridge:
    """线程安全的 Electron 原生浏览器桥接注册表。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cdp_ws_url: Optional[str] = None
        self._control_url: Optional[str] = None
        self._control_token: Optional[str] = None

    def register(
        self,
        cdp_ws_url: str,
        control_url: str,
        *,
        control_token: Optional[str] = None,
    ) -> None:
        valid_ws = _validate_loopback_url(cdp_ws_url, expected_scheme="ws", require_cdp_path=True)
        valid_ctrl = _validate_loopback_url(control_url, expected_scheme="http", require_cdp_path=False)
        clean_token = (
            control_token.strip()
            if isinstance(control_token, str) and control_token.strip()
            else None
        )
        with self._lock:
            self._cdp_ws_url = valid_ws
            self._control_url = valid_ctrl
            self._control_token = clean_token

    def clear(self) -> None:
        with self._lock:
            self._cdp_ws_url = None
            self._control_url = None
            self._control_token = None

    def _resolve_endpoints(self) -> tuple[Optional[str], Optional[str], Optional[str]]:
        with self._lock:
            ws_url = self._cdp_ws_url
            ctrl_url = self._control_url
            reg_token = self._control_token

        if not ws_url or not ctrl_url:
            env_ws = (os.environ.get(_ENV_CDP_WS_URL) or "").strip()
            env_ctrl = (os.environ.get(_ENV_CONTROL_URL) or "").strip()
            if env_ws and env_ctrl:
                try:
                    ws_url = _validate_loopback_url(
                        env_ws, expected_scheme="ws", require_cdp_path=True
                    )
                    ctrl_url = _validate_loopback_url(
                        env_ctrl, expected_scheme="http", require_cdp_path=False
                    )
                except ValueError:
                    return None, None, None

        token = (os.environ.get(_ENV_LOCAL_TOKEN) or "").strip() or reg_token
        return ws_url, ctrl_url, token

    def _auth_headers(self, token: Optional[str]) -> dict[str, str]:
        return {_LOCAL_TOKEN_HEADER: token} if token else {}

    def probe_cdp_ws_url(self, *, timeout: float = 1.5) -> Optional[str]:
        ws_url, ctrl_url, token = self._resolve_endpoints()
        if not ws_url or not ctrl_url:
            return None
        try:
            with httpx.Client(trust_env=False, timeout=timeout) as client:
                resp = client.get(f"{ctrl_url}/health", headers=self._auth_headers(token))
            if resp.status_code != 200:
                return None
            data = resp.json()
            if isinstance(data, dict) and data.get("ok") is True:
                return ws_url
        except Exception:  # noqa: BLE001 — 探测失败静默回落无头 Chrome
            return None
        return None

    def is_alive(self, *, timeout: float = 1.5) -> bool:
        return self.probe_cdp_ws_url(timeout=timeout) is not None

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        payload: Optional[dict[str, Any]] = None,
        timeout: float = 10.0,
        error_code: str,
        error_msg: str,
    ) -> dict[str, Any]:
        ws_url, ctrl_url, token = self._resolve_endpoints()
        if not ws_url or not ctrl_url:
            raise LocalInstallerError(
                error_code,
                "桌面内置浏览器桥接未就绪。",
                status_code=503,
            )
        try:
            with httpx.Client(trust_env=False, timeout=timeout) as client:
                resp = client.request(
                    method,
                    f"{ctrl_url}{path}",
                    headers=self._auth_headers(token),
                    json=payload,
                )
            if resp.status_code >= 400:
                raise LocalInstallerError(
                    error_code,
                    f"{error_msg}（HTTP {resp.status_code}）",
                    status_code=resp.status_code if 400 <= resp.status_code < 500 else 500,
                )
            data = resp.json()
            if not isinstance(data, dict):
                raise LocalInstallerError(error_code, f"{error_msg}：响应格式无效", status_code=500)
            return data
        except LocalInstallerError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise LocalInstallerError(
                error_code,
                f"{error_msg}：{exc}",
                status_code=500,
            ) from exc

    def set_cookies(self, cookies: list[dict[str, Any]]) -> dict[str, int]:
        data = self._request_json(
            "POST",
            "/internal/cookies/set",
            payload={"cookies": cookies},
            timeout=15.0,
            error_code="E_COOKIE_INJECT_FAILED",
            error_msg="向桌面内置浏览器写入 Cookie 失败",
        )
        return {
            "imported": int(data.get("imported") or 0),
            "skipped": int(data.get("skipped") or 0),
        }

    def list_cookie_domains(self) -> dict[str, Any]:
        data = self._request_json(
            "GET",
            "/internal/cookies/domains",
            timeout=5.0,
            error_code="E_COOKIE_QUERY_FAILED",
            error_msg="读取桌面内置浏览器登录态域名失败",
        )
        return {
            "domains": list(data.get("domains") or []),
            "total_cookies": int(data.get("total_cookies") or 0),
        }

    def clear_cookies(self, domain: Optional[str] = None) -> dict[str, Any]:
        clean = domain.strip() if isinstance(domain, str) and domain.strip() else None
        data = self._request_json(
            "POST",
            "/internal/cookies/clear",
            payload={"domain": clean} if clean is not None else {},
            timeout=10.0,
            error_code="E_COOKIE_CLEAR_FAILED",
            error_msg="清理桌面内置浏览器 Cookie 失败",
        )
        return {
            "cleared": int(data.get("cleared") or 0),
            "domain": data.get("domain"),
        }


desktop_browser_bridge = DesktopBrowserBridge()
