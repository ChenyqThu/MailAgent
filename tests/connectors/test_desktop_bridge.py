"""Desktop Electron 原生浏览器桥接（desktop_bridge.py / client.py / chrome_import.py）单测。"""

from __future__ import annotations

import asyncio
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading

import pytest

from src.connectors.client import ConnectorClient
from src.connectors.desktop_bridge import DesktopBrowserBridge, _validate_loopback_url
from src.connectors.registry import ConnectorDef
from src.connectors import chrome_import, desktop_bridge as db_mod, managed_browser as mb_mod


def test_validate_loopback_url_rejects_non_loopback_and_bad_schemes() -> None:
    assert (
        _validate_loopback_url(
            "ws://127.0.0.1:41234/cdp/abc123",
            expected_scheme="ws",
            require_cdp_path=True,
        )
        == "ws://127.0.0.1:41234/cdp/abc123"
    )
    assert (
        _validate_loopback_url("http://127.0.0.1:41234/", expected_scheme="http")
        == "http://127.0.0.1:41234"
    )

    for bad in (
        "",
        "ws://0.0.0.0:9000/cdp/tok",
        "ws://evil.com:9000/cdp/tok",
        "http://127.0.0.1:9000/cdp/tok",
        "ws://127.0.0.1:9000/wrong/tok",
        "ws://user:pass@127.0.0.1:9000/cdp/tok",
    ):
        with pytest.raises(ValueError):
            _validate_loopback_url(bad, expected_scheme="ws", require_cdp_path=True)


def test_desktop_bridge_health_cookies_and_client_routing(monkeypatch) -> None:
    received_tokens: list[str | None] = []
    stored_cookies: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002
            return

        def do_GET(self):  # noqa: N802
            received_tokens.append(self.headers.get("X-MailAgent-Local-Token"))
            if self.headers.get("X-MailAgent-Local-Token") != "tok-xyz":
                self.send_response(401)
                self.end_headers()
                return
            if self.path == "/health":
                self._json(200, {"ok": True, "engine": "electron_webcontents_view", "tabCount": 1})
                return
            if self.path == "/internal/cookies/domains":
                domains = (
                    [{"domain": "oa.corp", "count": len(stored_cookies)}]
                    if stored_cookies
                    else []
                )
                self._json(200, {"domains": domains, "total_cookies": len(stored_cookies)})
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):  # noqa: N802
            received_tokens.append(self.headers.get("X-MailAgent-Local-Token"))
            if self.headers.get("X-MailAgent-Local-Token") != "tok-xyz":
                self.send_response(401)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
            if self.path == "/internal/cookies/set":
                items = body.get("cookies") or []
                stored_cookies.extend(items)
                self._json(200, {"imported": len(items), "skipped": 0})
                return
            if self.path == "/internal/cookies/clear":
                cleared = len(stored_cookies)
                stored_cookies.clear()
                self._json(200, {"cleared": cleared, "domain": body.get("domain")})
                return
            self.send_response(404)
            self.end_headers()

        def _json(self, code: int, payload: dict) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        bridge = DesktopBrowserBridge()
        cdp_ws = f"ws://127.0.0.1:{port}/cdp/secret-ws"
        bridge.register(cdp_ws, f"http://127.0.0.1:{port}", control_token="tok-xyz")

        assert bridge.probe_cdp_ws_url() == cdp_ws
        assert bridge.is_alive() is True
        assert bridge.set_cookies([{"name": "sid", "value": "123", "domain": "oa.corp"}]) == {
            "imported": 1,
            "skipped": 0,
        }
        assert bridge.list_cookie_domains() == {
            "domains": [{"domain": "oa.corp", "count": 1}],
            "total_cookies": 1,
        }
        assert bridge.clear_cookies("oa.corp") == {"cleared": 1, "domain": "oa.corp"}
        assert "tok-xyz" in received_tokens

        # Client stdio routing uses PLAYWRIGHT_MCP_CDP_ENDPOINT in env (NOT CLI argv!)
        monkeypatch.setattr(db_mod, "desktop_browser_bridge", bridge)

        def _forbid_headless(**kwargs):
            raise AssertionError("Headless Chrome must not be launched when desktop bridge is alive")

        monkeypatch.setattr(mb_mod.managed_browser, "ensure_running", _forbid_headless)

        class _FakeConfigStore:
            def get_connector_custom_secrets(self, connector_id: str):
                return {}, {"EXISTING": "1"}

        import src.agent_config.store as store_mod

        monkeypatch.setattr(store_mod, "get_agent_config_store", lambda: _FakeConfigStore())

        defn = ConnectorDef(
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
        client = ConnectorClient("browser_use", interactive=True, definition=defn)
        cmd, env = asyncio.run(client._stdio_runtime_args())
        assert cmd["args"] == ["/rt/cli.js"]
        assert env["PLAYWRIGHT_MCP_CDP_ENDPOINT"] == cdp_ws
        assert env["EXISTING"] == "1"

        # chrome_import routes cookie inspection/clearing through desktop bridge
        assert chrome_import.list_managed_cookie_domains() == {"domains": [], "total_cookies": 0}
    finally:
        server.shutdown()
        server.server_close()
