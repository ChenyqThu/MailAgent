"""受管 Chromium CDP 守护进程、实时画面流（Screencast）与键鼠事件桥接（Wave 7）。

设计目标：
  1. **零启动常驻成本**：App 启动时不拉起浏览器；首次由用户面板打开（``stream_live_session``）
     或由 AI Agent（``browser_use`` 连接器首次 ``list_tools``/``call_tool``）触发时才按需启动。
  2. **双路共享同一持久化 Chrome 实例**：
     - AI 侧：``src/connectors/client.py`` 在 ``isolated_profile`` 模式下把受管 CDP URL
       （``http://127.0.0.1:<port>``）注入 ``@playwright/mcp --cdp-endpoint=...``；
     - UI 侧：``GET /api/connector/browser_use/live`` WebSocket 连接同一个 CDP Target，
       用 ``Page.screencastFrame`` 推流给前端 ``<canvas>``，并把鼠标、滚轮、键盘与中文 IME
       （``Input.insertText``）回传给浏览器的受控页面。
  3. **代理与锁安全**：
     - 本机 loopback CDP HTTP / WS 请求一律禁用系统代理（``trust_env=False`` / ``proxy=None``）；
     - 切为「外部独立 Chrome 窗口」（``launch_managed_browser_window``）前自动停掉本守护进程释放
       ``SingletonLock``；守护进程存活期间若导入 Cookie，直接走 CDP ``Network.setCookies`` 热注入。
"""

from __future__ import annotations

import asyncio
import json
import socket
import subprocess
import threading
import time
import urllib.parse
from contextlib import suppress
from typing import Any, Awaitable, Callable, Optional, TypeVar

import httpx
from loguru import logger

from src.connectors.chrome_import import (
    _domain_matches_filters,
    _find_chrome_executable,
    _normalize_domain_filter,
)
from src.connectors.local_installer import LocalInstallerError, runtime_dir_for

_T = TypeVar("_T")

#: 无前端查看器且无活动调用时的空闲回收超时（秒），对齐 ``LONG_SESSION_STDIO_CONNECTORS``。
MANAGED_BROWSER_IDLE_TTL_SECONDS = 600.0
_STARTUP_POLL_TIMEOUT_SEC = 12.0
_STARTUP_POLL_INTERVAL_SEC = 0.15
_TARGET_SYNC_INTERVAL_SEC = 1.2
_MAX_WS_FRAME_BYTES = 16 * 1024 * 1024


def normalize_navigate_url(raw: str) -> str:
    """校验并规范化地址栏跳转 URL；仅允许 ``http://`` / ``https://`` / ``about:blank``。"""
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty URL")
    if text == "about:blank":
        return text
    lowered = text.lower()
    for blocked in ("javascript:", "data:", "file:", "chrome:", "chrome-extension:", "vbscript:"):
        if lowered.startswith(blocked):
            raise ValueError(f"unsupported URL scheme: {blocked}")
    candidate = text if "://" in text else f"https://{text}"
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"invalid http/https URL: {raw!r}")
    return candidate


def _pick_free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def _terminate_proc_sync(proc: Optional[subprocess.Popen[bytes]]) -> None:
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            with suppress(Exception):
                proc.wait(timeout=2.0)
    except Exception:  # noqa: BLE001 — 进程清理失败不应阻断上层控制流
        pass


class _CdpConnection:
    """单 Target 的 CDP WebSocket 薄客户端（含串行 ID 分配与事件分发）。"""

    def __init__(self, target_id: str, ws: Any) -> None:
        self.target_id = target_id
        self._ws = ws
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._send_lock = asyncio.Lock()

    async def send(self, method: str, params: Optional[dict[str, Any]] = None) -> int:
        async with self._send_lock:
            msg_id = self._next_id
            self._next_id += 1
            payload: dict[str, Any] = {"id": msg_id, "method": method}
            if params is not None:
                payload["params"] = params
            await self._ws.send(json.dumps(payload))
            return msg_id

    async def call(
        self, method: str, params: Optional[dict[str, Any]] = None, *, timeout: float = 5.0
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        async with self._send_lock:
            msg_id = self._next_id
            self._next_id += 1
            self._pending[msg_id] = fut
            payload: dict[str, Any] = {"id": msg_id, "method": method}
            if params is not None:
                payload["params"] = params
            try:
                await self._ws.send(json.dumps(payload))
            except Exception:
                self._pending.pop(msg_id, None)
                raise
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(msg_id, None)

    def resolve_if_reply(self, msg: dict[str, Any]) -> bool:
        msg_id = msg.get("id")
        if not isinstance(msg_id, int):
            return False
        fut = self._pending.pop(msg_id, None)
        if fut is not None and not fut.done():
            if "error" in msg:
                fut.set_exception(RuntimeError(str(msg["error"])))
            else:
                fut.set_result(msg.get("result") or {})
        return True

    async def close(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()
        with suppress(Exception):
            await self._ws.close()


async def _graceful_cdp_close(cdp_url: str, timeout: float = 1.5) -> None:
    """在强杀进程前发送 ``Browser.close`` 让 Chromium 把 Cookie / Storage 完整落盘。"""
    try:
        from websockets.asyncio.client import connect as ws_connect

        async with httpx.AsyncClient(trust_env=False, timeout=1.0) as client:
            resp = await client.get(f"{cdp_url}/json/version")
            if resp.status_code != 200:
                return
            info = resp.json()
        ws_url = info.get("webSocketDebuggerUrl") if isinstance(info, dict) else None
        if not isinstance(ws_url, str) or not ws_url:
            return
        async with ws_connect(ws_url, proxy=None, open_timeout=timeout) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
            with suppress(Exception):
                await asyncio.wait_for(ws.recv(), timeout=timeout)
    except Exception:  # noqa: BLE001 — 优雅关停尽力而为，兜底仍走 _terminate_proc_sync
        pass


class ManagedBrowserManager:
    """单例管理内置无头/可视 Chrome 进程、CDP 列表、热 Cookie 注入与 WebSocket Screencast。"""

    def __init__(self, *, idle_ttl_seconds: float = MANAGED_BROWSER_IDLE_TTL_SECONDS) -> None:
        self._idle_ttl = float(idle_ttl_seconds)
        self._proc_lock = threading.Lock()
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._port: Optional[int] = None
        self._cdp_url: Optional[str] = None
        self._headless: bool = True
        self._active_viewers: int = 0
        self._last_activity: float = 0.0
        self._async_lock: Optional[asyncio.Lock] = None
        self._async_lock_loop: Optional[asyncio.AbstractEventLoop] = None
        self._reaper_task: Optional[asyncio.Task[None]] = None

    def _get_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._async_lock is None or self._async_lock_loop is not loop:
            self._async_lock = asyncio.Lock()
            self._async_lock_loop = loop
        return self._async_lock

    def touch(self) -> None:
        self._last_activity = time.monotonic()

    def is_running(self) -> bool:
        with self._proc_lock:
            return self._proc is not None and self._proc.poll() is None and self._cdp_url is not None

    @property
    def cdp_url(self) -> Optional[str]:
        with self._proc_lock:
            if self._proc is not None and self._proc.poll() is None:
                return self._cdp_url
            return None

    async def _probe_version(self, cdp_url: str) -> Optional[dict[str, Any]]:
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=2.0) as client:
                resp = await client.get(f"{cdp_url}/json/version")
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict):
                        return data
        except Exception:  # noqa: BLE001
            return None
        return None

    def _ensure_reaper(self) -> None:
        if self._idle_ttl <= 0:
            return
        loop = asyncio.get_running_loop()
        if self._reaper_task is not None and not self._reaper_task.done():
            return
        self._reaper_task = loop.create_task(self._reap_loop(), name="managed-browser-reaper")

    async def _reap_loop(self) -> None:
        while True:
            await asyncio.sleep(30.0)
            if not self.is_running():
                return
            if self._active_viewers > 0:
                self.touch()
                continue
            if (time.monotonic() - self._last_activity) >= self._idle_ttl:
                logger.info(
                    "[managed_browser] idle TTL ({}s) elapsed with 0 viewers; stopping Chrome",
                    self._idle_ttl,
                )
                await self.stop()
                return

    async def ensure_running(
        self,
        *,
        headless: bool = True,
        profile_dir: Optional[Any] = None,
    ) -> str:
        """按需拉起或复用内置受管 Chrome（绑定 loopback 随机端口，使用持久 Profile）。"""
        target_profile_dir = (
            profile_dir if profile_dir is not None else runtime_dir_for("browser_use") / "profile"
        )
        rt_dir = target_profile_dir.parent
        async with self._get_lock():
            existing_url = self.cdp_url
            if (
                existing_url is not None
                and self._headless == headless
                and getattr(self, "_profile_dir", target_profile_dir) == target_profile_dir
            ):
                if await self._probe_version(existing_url) is not None:
                    self.touch()
                    self._ensure_reaper()
                    return existing_url

            if self.is_running() or self._proc is not None:
                await self._stop_unlocked()

            chrome_exe = _find_chrome_executable()
            if not chrome_exe:
                raise LocalInstallerError(
                    "E_CHROME_NOT_FOUND",
                    "未在本机检测到 Google Chrome 可执行文件，无法启动内置受管浏览器。",
                    status_code=404,
                )

            target_profile_dir.mkdir(parents=True, exist_ok=True)
            port = _pick_free_loopback_port()
            cdp_url = f"http://127.0.0.1:{port}"

            cmd = [
                chrome_exe,
                f"--user-data-dir={target_profile_dir}",
                f"--remote-debugging-port={port}",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--window-size=1280,800",
            ]
            if headless:
                cmd.append("--headless=new")
            cmd.append("about:blank")

            proc = subprocess.Popen(
                cmd,
                cwd=str(rt_dir),
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            deadline = time.monotonic() + _STARTUP_POLL_TIMEOUT_SEC
            ready_info: Optional[dict[str, Any]] = None
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    break
                ready_info = await self._probe_version(cdp_url)
                if ready_info is not None:
                    break
                await asyncio.sleep(_STARTUP_POLL_INTERVAL_SEC)

            if ready_info is None:
                _terminate_proc_sync(proc)
                raise LocalInstallerError(
                    "E_BROWSER_LAUNCH_FAILED",
                    "启动内置受管 Chromium 超时或进程异常退出；若此前打开了「受管浏览器外部窗口」，请先关闭该窗口后再试。",
                    status_code=500,
                )

            with self._proc_lock:
                self._proc = proc
                self._port = port
                self._cdp_url = cdp_url
                self._headless = headless
                self._profile_dir = target_profile_dir
                self._last_activity = time.monotonic()

            self._ensure_reaper()
            logger.info(
                "[managed_browser] started Chromium (pid={}, headless={}, cdp={})",
                proc.pid,
                headless,
                cdp_url,
            )
            return cdp_url

    async def _stop_unlocked(self) -> None:
        if self._reaper_task is not None and not self._reaper_task.done():
            self._reaper_task.cancel()
        self._reaper_task = None
        with self._proc_lock:
            proc = self._proc
            cdp_url = self._cdp_url
            self._proc = None
            self._port = None
            self._cdp_url = None
        if proc is not None:
            if cdp_url and proc.poll() is None:
                await _graceful_cdp_close(cdp_url)
            await asyncio.to_thread(_terminate_proc_sync, proc)
            logger.info("[managed_browser] stopped Chromium")

    async def stop(self) -> None:
        async with self._get_lock():
            await self._stop_unlocked()

    def stop_sync(self) -> None:
        """同步停止受管 Chrome（供独立线程切为外部窗口前释放 SingletonLock）。"""
        with self._proc_lock:
            proc = self._proc
            self._proc = None
            self._port = None
            self._cdp_url = None
        _terminate_proc_sync(proc)

    async def list_targets(self) -> list[dict[str, Any]]:
        url = self.cdp_url
        if not url:
            return []
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=2.0) as client:
                resp = await client.get(f"{url}/json/list")
                if resp.status_code != 200:
                    return []
                raw = resp.json()
        except Exception:  # noqa: BLE001
            return []
        if not isinstance(raw, list):
            return []
        pages: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict) or item.get("type") != "page":
                continue
            tid = item.get("id")
            ws_url = item.get("webSocketDebuggerUrl")
            if not isinstance(tid, str) or not tid or not isinstance(ws_url, str) or not ws_url:
                continue
            pages.append(
                {
                    "id": tid,
                    "title": str(item.get("title") or ""),
                    "url": str(item.get("url") or "about:blank"),
                    "ws_url": ws_url,
                }
            )
        return pages

    async def get_status(self) -> dict[str, Any]:
        running = self.is_running()
        url = self.cdp_url
        tabs: list[dict[str, Any]] = []
        if running and url:
            raw_tabs = await self.list_targets()
            tabs = [
                {"id": t["id"], "title": t["title"], "url": t["url"]}
                for t in raw_tabs
            ]
        return {
            "ok": True,
            "running": running and url is not None,
            "headless": self._headless,
            "cdp_url": url,
            "active_viewers": self._active_viewers,
            "tabs": tabs,
        }

    async def new_tab(self, target_url: str = "about:blank") -> Optional[dict[str, Any]]:
        url = self.cdp_url
        if not url:
            return None
        clean = normalize_navigate_url(target_url) if target_url else "about:blank"
        encoded = urllib.parse.quote(clean, safe=":/?&=#%+-._~")
        endpoint = f"{url}/json/new?{encoded}" if clean != "about:blank" else f"{url}/json/new"
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=3.0) as client:
                resp = await client.put(endpoint)
                if resp.status_code == 405:
                    resp = await client.get(endpoint)
                if resp.status_code != 200:
                    return None
                item = resp.json()
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(item, dict) or not item.get("id"):
            return None
        return {
            "id": str(item["id"]),
            "title": str(item.get("title") or ""),
            "url": str(item.get("url") or clean),
            "ws_url": str(item.get("webSocketDebuggerUrl") or ""),
        }

    async def activate_tab(self, target_id: str) -> bool:
        url = self.cdp_url
        if not url or not target_id:
            return False
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=2.0) as client:
                resp = await client.get(f"{url}/json/activate/{target_id}")
                return resp.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def close_tab(self, target_id: str) -> bool:
        url = self.cdp_url
        if not url or not target_id:
            return False
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=2.0) as client:
                resp = await client.get(f"{url}/json/close/{target_id}")
                return resp.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def _with_live_cdp(
        self,
        action: Callable[[_CdpConnection], Awaitable[_T]],
        *,
        error_code: str = "E_COOKIE_OP_FAILED",
        error_prefix: str = "受管浏览器 CDP 操作失败",
    ) -> _T:
        targets = await self.list_targets()
        if not targets:
            created = await self.new_tab("about:blank")
            if created and created.get("ws_url"):
                targets = [created]
        if not targets:
            raise LocalInstallerError(
                error_code,
                "未找到可用的受管浏览器页面 Target。",
                status_code=500,
            )

        from websockets.asyncio.client import connect as ws_connect

        ws_url = targets[0]["ws_url"]
        try:
            async with ws_connect(ws_url, proxy=None, open_timeout=5.0) as ws:
                cdp = _CdpConnection(targets[0]["id"], ws)

                async def _read_cdp_replies() -> None:
                    async for raw_msg in ws:
                        try:
                            data = json.loads(raw_msg)
                        except (ValueError, TypeError):
                            continue
                        if isinstance(data, dict):
                            cdp.resolve_if_reply(data)

                reader_task = asyncio.create_task(_read_cdp_replies())
                try:
                    await cdp.call("Network.enable", timeout=3.0)
                    result = await action(cdp)
                    return result
                finally:
                    reader_task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await reader_task
                    await cdp.close()
        except LocalInstallerError:
            raise
        except (TimeoutError, asyncio.TimeoutError, OSError, RuntimeError) as exc:
            raise LocalInstallerError(
                error_code,
                f"{error_prefix}：{exc}",
                status_code=500,
            ) from exc

    async def inject_cookies_live(self, cookies: list[dict[str, Any]]) -> dict[str, int]:
        """当受管 Chrome 已在后台运行时，直接通过 CDP ``Network.setCookies`` 热注入 Cookie。"""
        if not cookies:
            return {"imported": 0, "skipped": 0}

        sanitized: list[dict[str, Any]] = []
        for c in cookies:
            item = {
                k: v
                for k, v in c.items()
                if k in ("name", "value", "url", "domain", "path", "secure", "httpOnly", "sameSite", "expires")
            }
            if item:
                sanitized.append(item)

        if not sanitized:
            return {"imported": 0, "skipped": len(cookies)}

        skipped_invalid = len(cookies) - len(sanitized)

        async def _inject(cdp: _CdpConnection) -> dict[str, int]:
            imported = 0
            skipped = skipped_invalid
            chunk_size = 100
            for idx in range(0, len(sanitized), chunk_size):
                chunk = sanitized[idx : idx + chunk_size]
                try:
                    await cdp.call("Network.setCookies", {"cookies": chunk}, timeout=10.0)
                    imported += len(chunk)
                except (TimeoutError, asyncio.TimeoutError):
                    raise
                except RuntimeError:
                    for single in chunk:
                        try:
                            await cdp.call("Network.setCookies", {"cookies": [single]}, timeout=5.0)
                            imported += 1
                        except Exception:  # noqa: BLE001 — 单条损坏 Cookie 跳过，不阻断整批导入
                            skipped += 1
            await asyncio.sleep(0.2)
            return {"imported": imported, "skipped": skipped}

        counts = await self._with_live_cdp(
            _inject,
            error_code="E_COOKIE_INJECT_FAILED",
            error_prefix="向受管浏览器注入 Cookie 失败",
        )
        self.touch()
        return counts

    async def list_cookie_domains_live(self) -> dict[str, Any]:
        """读取运行中受管浏览器的已保存 Cookie 域名统计（绝不返回明文值）。"""
        async def _list(cdp: _CdpConnection) -> dict[str, Any]:
            resp = await cdp.call("Network.getAllCookies", timeout=5.0)
            raw_cookies = resp.get("cookies") if isinstance(resp, dict) else []
            counts: dict[str, int] = {}
            for c in raw_cookies or []:
                if not isinstance(c, dict):
                    continue
                domain = str(c.get("domain") or "").lstrip(".").lower()
                if not domain:
                    continue
                counts[domain] = counts.get(domain, 0) + 1
            sorted_items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            return {
                "domains": [{"domain": d, "count": n} for d, n in sorted_items],
                "total_cookies": sum(counts.values()),
            }

        res = await self._with_live_cdp(
            _list,
            error_code="E_COOKIE_QUERY_FAILED",
            error_prefix="读取受管浏览器登录态域名失败",
        )
        self.touch()
        return res

    def list_cookie_domains_live_sync(self) -> dict[str, Any]:
        """在 threadpool 线程中同步查询运行中受管浏览器的 Cookie 域名统计。"""
        return asyncio.run(self.list_cookie_domains_live())

    async def clear_cookies_live(self, domain: Optional[str] = None) -> dict[str, Any]:
        """清空运行中受管浏览器的指定域名或全部 Cookie。"""
        clean_domain = domain.strip() if isinstance(domain, str) and domain.strip() else None

        async def _clear(cdp: _CdpConnection) -> dict[str, Any]:
            resp = await cdp.call("Network.getAllCookies", timeout=5.0)
            raw_cookies = resp.get("cookies") if isinstance(resp, dict) else []
            cookies_list = [c for c in (raw_cookies or []) if isinstance(c, dict)]
            if clean_domain is None:
                await cdp.call("Network.clearBrowserCookies", timeout=5.0)
                return {"cleared": len(cookies_list), "domain": None}
            norm = _normalize_domain_filter(clean_domain)
            if not norm:
                return {"cleared": 0, "domain": clean_domain}
            cleared = 0
            for c in cookies_list:
                c_domain = str(c.get("domain") or "")
                c_name = str(c.get("name") or "")
                if not c_name or not c_domain or not _domain_matches_filters(c_domain, [norm]):
                    continue
                await cdp.call(
                    "Network.deleteCookies",
                    {
                        "name": c_name,
                        "domain": c_domain,
                        "path": str(c.get("path") or "/"),
                    },
                    timeout=5.0,
                )
                cleared += 1
            return {"cleared": cleared, "domain": clean_domain}

        res = await self._with_live_cdp(
            _clear,
            error_code="E_COOKIE_CLEAR_FAILED",
            error_prefix="清理受管浏览器登录态失败",
        )
        self.touch()
        return res

    def clear_cookies_live_sync(self, domain: Optional[str] = None) -> dict[str, Any]:
        """在 threadpool 线程中同步清理运行中受管浏览器的 Cookie。"""
        return asyncio.run(self.clear_cookies_live(domain))

    def inject_cookies_live_sync(self, cookies: list[dict[str, Any]]) -> dict[str, int]:
        """在 threadpool 线程中同步调用热 Cookie 注入。"""
        return asyncio.run(self.inject_cookies_live(cookies))

    async def inject_cookies_cold(
        self,
        cookies: list[dict[str, Any]],
        *,
        profile_dir: Optional[Any] = None,
    ) -> dict[str, int]:
        """未运行受管浏览器时，临时以无头模式拉起真实 Chrome、通过 CDP 注入并优雅落盘退出。"""
        if not cookies:
            return {"imported": 0, "skipped": 0}
        was_running = self.is_running()
        await self.ensure_running(headless=True, profile_dir=profile_dir)
        try:
            return await self.inject_cookies_live(cookies)
        finally:
            if not was_running:
                await self.stop()

    def inject_cookies_cold_sync(
        self,
        cookies: list[dict[str, Any]],
        *,
        profile_dir: Optional[Any] = None,
    ) -> dict[str, int]:
        """在 threadpool 线程中同步调用冷启动 Cookie 注入。"""
        return asyncio.run(self.inject_cookies_cold(cookies, profile_dir=profile_dir))

    async def stream_live_session(self, websocket: Any, *, headless: bool = True) -> None:
        """把前端 WebSocket 桥接到运行中的受管 Chrome Target（双向 Screencast + 键鼠操控）。"""
        from websockets.asyncio.client import connect as ws_connect

        await self.ensure_running(headless=headless)
        self._active_viewers += 1
        self.touch()

        cdp_conn: Optional[_CdpConnection] = None
        cdp_reader_task: Optional[asyncio.Task[None]] = None
        last_tabs_snapshot: str = ""
        known_target_ids: set[str] = set()

        async def _send_state(targets: list[dict[str, Any]]) -> None:
            nonlocal last_tabs_snapshot
            active_id = cdp_conn.target_id if cdp_conn else (targets[0]["id"] if targets else None)
            active_tab = next((t for t in targets if t["id"] == active_id), targets[0] if targets else None)
            pub_tabs = [{"id": t["id"], "title": t["title"], "url": t["url"]} for t in targets]
            snap = json.dumps(
                {"tabs": pub_tabs, "activeTargetId": active_id},
                ensure_ascii=False,
                sort_keys=True,
            )
            if snap == last_tabs_snapshot:
                return
            last_tabs_snapshot = snap
            await websocket.send_json(
                {
                    "type": "state",
                    "tabs": pub_tabs,
                    "activeTargetId": active_id,
                    "url": active_tab["url"] if active_tab else "about:blank",
                    "title": active_tab["title"] if active_tab else "",
                    "headless": self._headless,
                }
            )

        async def _pump_cdp_events(conn: _CdpConnection) -> None:
            try:
                async for raw_msg in conn._ws:
                    data = json.loads(raw_msg)
                    if conn.resolve_if_reply(data):
                        continue
                    method = data.get("method")
                    if method == "Page.screencastFrame":
                        params = data.get("params") or {}
                        frame_id = params.get("sessionId")
                        if frame_id is not None:
                            with suppress(Exception):
                                await conn.send("Page.screencastFrameAck", {"sessionId": frame_id})
                        frame_b64 = params.get("data")
                        if isinstance(frame_b64, str) and frame_b64:
                            self.touch()
                            await websocket.send_json(
                                {
                                    "type": "frame",
                                    "targetId": conn.target_id,
                                    "data": frame_b64,
                                    "metadata": params.get("metadata") or {},
                                }
                            )
                    elif method == "Page.frameNavigated":
                        targets_now = await self.list_targets()
                        if targets_now:
                            await _send_state(targets_now)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.debug("[managed_browser] CDP reader ended for {}: {}", conn.target_id, exc)

        async def _attach_target(target_id: Optional[str] = None) -> None:
            nonlocal cdp_conn, cdp_reader_task, known_target_ids, last_tabs_snapshot
            targets = await self.list_targets()
            if not targets:
                created = await self.new_tab("about:blank")
                if created:
                    targets = [created]
            if not targets:
                raise LocalInstallerError(
                    "E_BROWSER_NO_TARGET",
                    "受管 Chromium 没有可用页面标签。",
                    status_code=500,
                )
            chosen = next((t for t in targets if t["id"] == target_id), None) if target_id else None
            if chosen is None:
                # 优先附着到一个非 about:blank 的页面（例如 Playwright MCP 正在操作的页）
                chosen = next((t for t in targets if t["url"] != "about:blank"), targets[0])
            known_target_ids = {t["id"] for t in targets}

            if cdp_conn is not None and cdp_conn.target_id == chosen["id"]:
                await self.activate_tab(chosen["id"])
                last_tabs_snapshot = ""
                await _send_state(targets)
                return

            if cdp_reader_task is not None:
                cdp_reader_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await cdp_reader_task
                cdp_reader_task = None
            if cdp_conn is not None:
                await cdp_conn.close()
                cdp_conn = None

            ws = await ws_connect(
                chosen["ws_url"],
                max_size=_MAX_WS_FRAME_BYTES,
                proxy=None,
                open_timeout=5.0,
            )
            conn = _CdpConnection(chosen["id"], ws)
            cdp_conn = conn
            await self.activate_tab(chosen["id"])
            cdp_reader_task = asyncio.create_task(_pump_cdp_events(conn))
            await conn.call("Page.enable", timeout=3.0)
            await conn.call(
                "Page.startScreencast",
                {
                    "format": "jpeg",
                    "quality": 75,
                    "maxWidth": 1280,
                    "maxHeight": 900,
                    "everyNthFrame": 1,
                },
                timeout=3.0,
            )
            last_tabs_snapshot = ""
            await _send_state(targets)

        async def _sync_targets_loop() -> None:
            nonlocal known_target_ids
            while True:
                await asyncio.sleep(_TARGET_SYNC_INTERVAL_SEC)
                targets = await self.list_targets()
                if not targets:
                    continue
                cur_ids = {t["id"] for t in targets}
                active_id = cdp_conn.target_id if cdp_conn else None
                active_tab = next((t for t in targets if t["id"] == active_id), None)

                # 当前附着 Tab 被关闭 → 自动切到剩余第一个
                if active_id not in cur_ids:
                    await _attach_target(targets[0]["id"])
                    known_target_ids = cur_ids
                    continue

                # 若用户/初始仅停在 about:blank，且 Agent 新开了一个实际页面 → 自动跟随切过去
                new_ids = cur_ids - known_target_ids
                if new_ids and active_tab and active_tab["url"] == "about:blank":
                    follow = next(
                        (t for t in targets if t["id"] in new_ids and t["url"] != "about:blank"),
                        None,
                    )
                    if follow is not None:
                        await _attach_target(follow["id"])
                        known_target_ids = cur_ids
                        continue

                known_target_ids = cur_ids
                await _send_state(targets)

        sync_task: Optional[asyncio.Task[None]] = None
        try:
            await _attach_target(None)
            sync_task = asyncio.create_task(_sync_targets_loop())

            while True:
                raw_msg = await websocket.receive_text()
                self.touch()
                try:
                    cmd = json.loads(raw_msg)
                except (ValueError, TypeError):
                    continue
                if not isinstance(cmd, dict):
                    continue
                kind = cmd.get("type")
                conn = cdp_conn
                if kind == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if conn is None:
                    continue

                if kind == "mouse":
                    action = cmd.get("action")
                    x = float(cmd.get("x") or 0)
                    y = float(cmd.get("y") or 0)
                    if action == "wheel":
                        await conn.send(
                            "Input.dispatchMouseEvent",
                            {
                                "type": "mouseWheel",
                                "x": x,
                                "y": y,
                                "deltaX": float(cmd.get("deltaX") or 0),
                                "deltaY": float(cmd.get("deltaY") or 0),
                            },
                        )
                    elif action in ("mousePressed", "mouseReleased", "mouseMoved"):
                        button = str(cmd.get("button") or ("none" if action == "mouseMoved" else "left"))
                        buttons = int(cmd.get("buttons") or (0 if action == "mouseReleased" else 1))
                        await conn.send(
                            "Input.dispatchMouseEvent",
                            {
                                "type": action,
                                "x": x,
                                "y": y,
                                "button": button,
                                "buttons": buttons,
                                "clickCount": int(cmd.get("clickCount") or (0 if action == "mouseMoved" else 1)),
                                "modifiers": int(cmd.get("modifiers") or 0),
                            },
                        )
                elif kind == "key":
                    action = cmd.get("action")
                    if action in ("keyDown", "keyUp", "rawKeyDown"):
                        key_params: dict[str, Any] = {
                            "type": action,
                            "modifiers": int(cmd.get("modifiers") or 0),
                        }
                        for field in ("key", "code", "text"):
                            val = cmd.get(field)
                            if isinstance(val, str) and val:
                                key_params[field] = val
                        vk = cmd.get("windowsVirtualKeyCode")
                        if isinstance(vk, int):
                            key_params["windowsVirtualKeyCode"] = vk
                            key_params["nativeVirtualKeyCode"] = vk
                        await conn.send("Input.dispatchKeyEvent", key_params)
                elif kind == "insert_text":
                    txt = cmd.get("text")
                    if isinstance(txt, str) and txt:
                        await conn.send("Input.insertText", {"text": txt})
                elif kind == "navigate":
                    try:
                        target_url = normalize_navigate_url(str(cmd.get("url") or ""))
                    except ValueError as err:
                        await websocket.send_json({"type": "error", "message": str(err)})
                        continue
                    await conn.call("Page.navigate", {"url": target_url}, timeout=8.0)
                    targets_now = await self.list_targets()
                    if targets_now:
                        await _send_state(targets_now)
                elif kind == "back":
                    hist = await conn.call("Page.getNavigationHistory", timeout=3.0)
                    idx = int(hist.get("currentIndex") or 0)
                    entries = hist.get("entries") or []
                    if idx > 0 and isinstance(entries, list):
                        await conn.call(
                            "Page.navigateToHistoryEntry",
                            {"entryId": entries[idx - 1]["id"]},
                            timeout=5.0,
                        )
                elif kind == "forward":
                    hist = await conn.call("Page.getNavigationHistory", timeout=3.0)
                    idx = int(hist.get("currentIndex") or 0)
                    entries = hist.get("entries") or []
                    if isinstance(entries, list) and idx + 1 < len(entries):
                        await conn.call(
                            "Page.navigateToHistoryEntry",
                            {"entryId": entries[idx + 1]["id"]},
                            timeout=5.0,
                        )
                elif kind == "reload":
                    await conn.send("Page.reload", {"ignoreCache": bool(cmd.get("ignoreCache"))})
                elif kind == "switch_tab":
                    tid = str(cmd.get("targetId") or "")
                    if tid:
                        await _attach_target(tid)
                elif kind == "new_tab":
                    raw_url = str(cmd.get("url") or "about:blank")
                    try:
                        created = await self.new_tab(raw_url)
                    except ValueError as err:
                        await websocket.send_json({"type": "error", "message": str(err)})
                        continue
                    if created:
                        await _attach_target(created["id"])
                elif kind == "close_tab":
                    tid = str(cmd.get("targetId") or "")
                    if tid:
                        await self.close_tab(tid)
                        targets_now = await self.list_targets()
                        if not targets_now:
                            await _attach_target(None)
                        elif tid == conn.target_id:
                            await _attach_target(targets_now[0]["id"])
                        else:
                            await _send_state(targets_now)
                elif kind == "resize":
                    w = max(480, min(1920, int(cmd.get("width") or 1280)))
                    h = max(360, min(1200, int(cmd.get("height") or 800)))
                    await conn.send(
                        "Emulation.setDeviceMetricsOverride",
                        {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False},
                    )
        finally:
            self._active_viewers = max(0, self._active_viewers - 1)
            self.touch()
            if sync_task is not None:
                sync_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await sync_task
            if cdp_reader_task is not None:
                cdp_reader_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await cdp_reader_task
            if cdp_conn is not None:
                await cdp_conn.close()


#: 进程级受管浏览器守护单例。
managed_browser = ManagedBrowserManager()
