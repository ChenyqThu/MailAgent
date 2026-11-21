"""Wave 7 受管 Chromium CDP 守护、Playwright --cdp-endpoint 重写与热 Cookie 注入单测。"""

from __future__ import annotations

import asyncio
import json

import pytest

from src.connectors import chrome_import, local_installer, managed_browser as mb_mod
from src.connectors.client import ConnectorClient
from src.connectors.registry import ConnectorDef


def test_normalize_navigate_url_rules() -> None:
    assert mb_mod.normalize_navigate_url("dms.company.com/approvals") == "https://dms.company.com/approvals"
    assert mb_mod.normalize_navigate_url("http://localhost:3000/a") == "http://localhost:3000/a"
    assert mb_mod.normalize_navigate_url("about:blank") == "about:blank"

    for bad in ("", "   ", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "chrome://settings"):
        with pytest.raises(ValueError):
            mb_mod.normalize_navigate_url(bad)


def test_managed_browser_ensure_running_reuses_and_stops(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    mgr = mb_mod.ManagedBrowserManager(idle_ttl_seconds=0)

    spawned_cmds: list[list[str]] = []

    class FakeProc:
        def __init__(self, pid: int) -> None:
            self.pid = pid
            self._alive = True

        def poll(self):
            return None if self._alive else 0

        def terminate(self) -> None:
            self._alive = False

        def wait(self, timeout=None) -> int:
            self._alive = False
            return 0

        def kill(self) -> None:
            self._alive = False

    def _fake_popen(cmd, **kwargs):
        spawned_cmds.append(list(cmd))
        return FakeProc(pid=12340 + len(spawned_cmds))

    monkeypatch.setattr(mb_mod, "_find_chrome_executable", lambda: "/mock/Google Chrome")
    monkeypatch.setattr(mb_mod.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(mb_mod, "_pick_free_loopback_port", lambda: 49152 + len(spawned_cmds))

    async def _fake_probe(url: str):
        return {"Browser": "Chrome/132.0", "webSocketDebuggerUrl": f"ws://127.0.0.1:49153/devtools/browser/1"}

    monkeypatch.setattr(mgr, "_probe_version", _fake_probe)

    async def _run() -> None:
        url1 = await mgr.ensure_running(headless=True)
        assert url1 == "http://127.0.0.1:49152"
        assert mgr.is_running()
        assert "--headless=new" in spawned_cmds[0]
        assert any(arg.startswith("--user-data-dir=") for arg in spawned_cmds[0])

        # 同 headless 模式复用现有实例
        url2 = await mgr.ensure_running(headless=True)
        assert url2 == url1
        assert len(spawned_cmds) == 1

        # 切换 headless=False 时停止旧实例并重拉起
        url3 = await mgr.ensure_running(headless=False)
        assert len(spawned_cmds) == 2
        assert "--headless=new" not in spawned_cmds[1]
        assert url3 != url1

        await mgr.stop()
        assert not mgr.is_running()

    asyncio.run(_run())


def test_stdio_runtime_args_rewrites_isolated_profile_to_managed_cdp(tmp_path, monkeypatch) -> None:
    calls: list[bool] = []

    async def _fake_ensure(*, headless: bool = True) -> str:
        calls.append(headless)
        return "http://127.0.0.1:54321"

    monkeypatch.setattr(mb_mod.managed_browser, "ensure_running", _fake_ensure)

    class _FakeConfigStore:
        def get_connector_custom_secrets(self, connector_id: str):
            return {}, {}

    import src.agent_config.store as store_mod

    monkeypatch.setattr(store_mod, "get_agent_config_store", lambda: _FakeConfigStore())

    defn_isolated = ConnectorDef(
        connector_id="browser_use",
        display_name="Browser Use",
        server_url="",
        transport="stdio",
        source="managed_local",
        stdio_command={
            "command": "node",
            "args": ["/rt/cli.js", "--browser=chrome", "--user-data-dir", "/rt/profile", "--headless"],
            "cwd": "/rt",
        },
    )
    client_iso = ConnectorClient("browser_use", interactive=True, definition=defn_isolated)
    cmd_iso, _ = asyncio.run(client_iso._stdio_runtime_args())
    assert calls == [True]
    assert cmd_iso["args"] == ["/rt/cli.js", "--cdp-endpoint=http://127.0.0.1:54321"]

    # cdp_chrome 与 extension 模式保持原 args 不被重写
    defn_ext = ConnectorDef(
        connector_id="browser_use",
        display_name="Browser Use",
        server_url="",
        transport="stdio",
        source="managed_local",
        stdio_command={
            "command": "node",
            "args": ["/rt/cli.js", "--extension"],
            "cwd": "/rt",
        },
    )
    client_ext = ConnectorClient("browser_use", interactive=True, definition=defn_ext)
    cmd_ext, _ = asyncio.run(client_ext._stdio_runtime_args())
    assert cmd_ext["args"] == ["/rt/cli.js", "--extension"]
    assert len(calls) == 1


def test_inject_cookies_uses_live_cdp_when_managed_browser_running(tmp_path, monkeypatch) -> None:
    rt_dir = tmp_path / "runtimes" / "browser_use"
    ep = rt_dir / "pkg" / "cli.js"
    ep.parent.mkdir(parents=True, exist_ok=True)
    ep.write_text("console.log('ok')\n", encoding="utf-8")
    (rt_dir / "manifest.json").write_text(
        json.dumps({"connector_id": "browser_use", "entrypoint": "pkg/cli.js"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    monkeypatch.setattr(mb_mod.managed_browser, "is_running", lambda: True)

    captured: list[list[dict]] = []

    def _fake_live(cookies):
        captured.append(cookies)
        return {"imported": len(cookies), "skipped": 0}

    monkeypatch.setattr(mb_mod.managed_browser, "inject_cookies_live_sync", _fake_live)
    res = chrome_import.inject_cookies_into_managed_profile(
        [{"name": "sid", "value": "abc", "domain": "dms.company.com", "path": "/"}],
        runtime_dir=rt_dir,
    )
    assert res == {"imported": 1, "skipped": 0}
    assert len(captured) == 1


def test_inject_cookies_live_pumps_cdp_replies_and_handles_bad_cookie_fallback(monkeypatch) -> None:
    mgr = mb_mod.ManagedBrowserManager(idle_ttl_seconds=0)
    monkeypatch.setattr(
        mgr,
        "list_targets",
        lambda: asyncio.sleep(0, result=[{"id": "t1", "ws_url": "ws://127.0.0.1:9999/page/1"}]),
    )

    sent_methods: list[str] = []

    class FakeWs:
        def __init__(self) -> None:
            self._queue: asyncio.Queue[Optional[str]] = asyncio.Queue()

        async def __aenter__(self) -> "FakeWs":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            await self.close()

        async def close(self) -> None:
            await self._queue.put(None)

        async def send(self, raw: str) -> None:
            msg = json.loads(raw)
            msg_id = msg["id"]
            method = msg["method"]
            sent_methods.append(method)
            if method == "Network.setCookies":
                cookies = (msg.get("params") or {}).get("cookies") or []
                if any(c.get("name") == "bad" for c in cookies):
                    await self._queue.put(
                        json.dumps({"id": msg_id, "error": {"code": -32602, "message": "Invalid cookie"}})
                    )
                    return
            await self._queue.put(json.dumps({"id": msg_id, "result": {}}))

        def __aiter__(self):
            return self

        async def __anext__(self) -> str:
            item = await self._queue.get()
            if item is None:
                raise StopAsyncIteration
            return item

    import websockets.asyncio.client as ws_client_mod

    monkeypatch.setattr(ws_client_mod, "connect", lambda *args, **kwargs: FakeWs())

    res = asyncio.run(
        mgr.inject_cookies_live(
            [
                {"name": "ok1", "value": "1", "domain": "a.com", "path": "/"},
                {"name": "bad", "value": "x", "domain": "b.com", "path": "/"},
                {"name": "ok2", "value": "2", "domain": "c.com", "path": "/"},
            ]
        )
    )
    assert sent_methods[0] == "Network.enable"
    assert res == {"imported": 2, "skipped": 1}


def test_inject_cookies_cold_launches_injects_and_closes_gracefully(tmp_path, monkeypatch) -> None:
    mgr = mb_mod.ManagedBrowserManager(idle_ttl_seconds=0)
    calls: list[str] = []

    async def _fake_ensure(*, headless: bool = True, profile_dir=None) -> str:
        calls.append(f"ensure:{headless}:{profile_dir}")
        mgr._cdp_url = "http://127.0.0.1:45555"

        class DummyProc:
            def poll(self):
                return None

            def terminate(self):
                calls.append("terminate")

            def wait(self, timeout=None):
                return 0

        mgr._proc = DummyProc()  # type: ignore[assignment]
        return "http://127.0.0.1:45555"

    async def _fake_inject(cookies):
        calls.append(f"inject:{len(cookies)}")
        return {"imported": len(cookies), "skipped": 0}

    async def _fake_graceful(cdp_url: str, timeout: float = 1.5) -> None:
        calls.append(f"graceful_close:{cdp_url}")

    monkeypatch.setattr(mgr, "ensure_running", _fake_ensure)
    monkeypatch.setattr(mgr, "inject_cookies_live", _fake_inject)
    monkeypatch.setattr(mb_mod, "_graceful_cdp_close", _fake_graceful)

    profile = tmp_path / "profile"
    res = asyncio.run(
        mgr.inject_cookies_cold(
            [{"name": "sid", "value": "v", "domain": "oa.corp", "path": "/"}],
            profile_dir=profile,
        )
    )
    assert res == {"imported": 1, "skipped": 0}
    assert calls == [
        f"ensure:True:{profile}",
        "inject:1",
        "graceful_close:http://127.0.0.1:45555",
        "terminate",
    ]
