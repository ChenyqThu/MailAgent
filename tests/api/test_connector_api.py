"""/api/connector/*（08-01 PR1）：flag off 全 409（callback 例外）、callback state 能力令牌
（错 state 404 不泄因 + 单次消费）、sync 落库、disconnect 逐条删凭证。

外部网络一律不发：ConnectorClient 用 stub 替（monkeypatch 到 src.connectors.client ——
router 是 handler 内 lazy import，call-time 解析故 patch 生效）。master key 通道 mock
（keyfile fallback 落 tmp），凭证走 fresh_agent_cfg 的干净 agent_config.db。
"""

from __future__ import annotations

import pytest

from src.agent_config import secrets


class _Cfg:
    """settings stub：只带 connector 端点读的字段。"""

    def __init__(self, enabled: bool):
        self.mcp_connectors_enabled = enabled
        self.connector_timeout_seconds = 5.0


@pytest.fixture(autouse=True)
def _clear_flows():
    """in-process 流表跨测试清空（begin_flow 是模块级单例状态）。"""
    yield
    from src.connectors import oauth_flow

    oauth_flow._ACTIVE_FLOWS.clear()


@pytest.fixture(autouse=True)
def _isolate_master_key(monkeypatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


@pytest.fixture()
def flag_off_client(client):
    from src.api.app import app
    from src.api.deps import get_settings

    app.dependency_overrides[get_settings] = lambda: _Cfg(enabled=False)
    yield client
    app.dependency_overrides.pop(get_settings, None)


@pytest.fixture()
def flag_on_client(client, fresh_agent_cfg):
    from src.api.app import app
    from src.api.deps import get_settings

    app.dependency_overrides[get_settings] = lambda: _Cfg(enabled=True)
    yield client
    app.dependency_overrides.pop(get_settings, None)


# ── flag off（默认）：除 callback 外全部 409 ─────────────────────────────────────


def test_flag_off_all_non_callback_endpoints_409(flag_off_client):
    cases = [
        ("GET", "/api/connector"),
        ("POST", "/api/connector/notion/oauth/start"),
        ("GET", "/api/connector/notion/status"),
        ("POST", "/api/connector/notion/sync"),
        ("GET", "/api/connector/notion/tools"),
        ("POST", "/api/connector/notion/disconnect"),
    ]
    for method, url in cases:
        r = flag_off_client.request(method, url)
        assert r.status_code == 409, f"{method} {url} -> {r.status_code}"
        assert r.json()["error"]["code"] == "E_CONNECTOR_DISABLED"


def test_flag_off_callback_still_state_gated_404(flag_off_client):
    """callback 不挂 flag 门 —— off 时无活 rendezvous，state 对不上天然 404。"""
    r = flag_off_client.get("/api/connector/oauth/callback?state=whatever&code=c")
    assert r.status_code == 404


# ── callback：state 即能力令牌 ───────────────────────────────────────────────────


def test_callback_no_state_404(client):
    assert client.get("/api/connector/oauth/callback").status_code == 404


def test_callback_wrong_state_404_and_single_consumption(client):
    from src.connectors.oauth_flow import oauth_rendezvous

    oauth_rendezvous.register("live-state")
    try:
        assert (
            client.get("/api/connector/oauth/callback?state=guessed&code=c").status_code == 404
        )
        ok = client.get("/api/connector/oauth/callback?state=live-state&code=the-code")
        assert ok.status_code == 200
        # 单次消费：同 state 重放 → 404（与「未知 state」不可区分）。
        replay = client.get("/api/connector/oauth/callback?state=live-state&code=the-code")
        assert replay.status_code == 404
    finally:
        oauth_rendezvous.discard("live-state")


def test_callback_error_param_delivers_denied_page(client):
    from src.connectors.oauth_flow import oauth_rendezvous

    oauth_rendezvous.register("deny-state")
    r = client.get("/api/connector/oauth/callback?state=deny-state&error=access_denied")
    assert r.status_code == 200
    assert "授权未完成" in r.text


# ── 未知 connector id ───────────────────────────────────────────────────────────


def test_unknown_connector_404(flag_on_client):
    r = flag_on_client.post("/api/connector/github/sync")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ── sync：stub client → 双表落库 → tools 端点可读 ───────────────────────────────


class _StubConnectorClient:
    manifest = [
        {
            "name": "search",
            "description": "Search pages",
            "input_schema": {"type": "object"},
            "output_schema": None,
            "crud_type": "read",
        },
        {
            "name": "create_page",
            "description": "Create a page",
            "input_schema": {"type": "object"},
            "output_schema": None,
            "crud_type": "write",
        },
        {
            "name": "delete_page",
            "description": "Delete a page",
            "input_schema": {"type": "object"},
            "output_schema": None,
            "crud_type": "delete",
        },
    ]

    def __init__(self, connector_id, **_kwargs):
        self.connector_id = connector_id

    async def list_tools_manifest(self, **_kwargs):
        return list(self.manifest)


def test_sync_persists_tools_and_status(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    monkeypatch.setattr(client_mod, "ConnectorClient", _StubConnectorClient)
    r = flag_on_client.post("/api/connector/notion/sync")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["total"] == 3 and data["inserted"] == 3

    row = fresh_agent_cfg.get_connector("notion")
    assert row is not None and row.status == "connected"
    assert row.last_synced_at is not None

    t = flag_on_client.get("/api/connector/notion/tools")
    assert t.status_code == 200
    tools = {x["name"]: x for x in t.json()["data"]["tools"]}
    assert set(tools) == {"search", "create_page", "delete_page"}
    # 折算：read 默认开 / write 默认关 / 🔴 delete 恒关（且照常在清单里 —— Q16=A）。
    assert tools["search"]["effective_enabled"] is True
    assert tools["create_page"]["effective_enabled"] is False
    assert tools["delete_page"]["effective_enabled"] is False
    assert tools["delete_page"]["crud_type"] == "delete"


def test_sync_not_connected_maps_409_and_error_state(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    class _Unauthorized(_StubConnectorClient):
        async def list_tools_manifest(self, **_kwargs):
            raise client_mod.ConnectorError(
                "not authorized", code="E_CONNECTOR_NOT_CONNECTED"
            )

    monkeypatch.setattr(client_mod, "ConnectorClient", _Unauthorized)
    r = flag_on_client.post("/api/connector/notion/sync")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_CONNECTOR_NOT_CONNECTED"
    # 连接转 error 态并如实告知（PRD：不静默）。
    row = fresh_agent_cfg.get_connector("notion")
    assert row is not None and row.status == "error"
    assert "not authorized" in (row.last_error or "")


# ── oauth/start：后台流交接（fake flow-runner，不发网络）────────────────────────


def test_oauth_start_returns_authorize_url(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    async def fake_flow(flow, **_kwargs):
        flow.auth_url = "https://mcp.notion.com/authorize?state=abc"
        flow.status = "authorizing"
        flow.auth_url_ready.set()

    monkeypatch.setattr(client_mod, "run_connect_flow", fake_flow)
    r = flag_on_client.post("/api/connector/notion/oauth/start")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["authorize_url"] == "https://mcp.notion.com/authorize?state=abc"
    assert data["status"] == "authorizing"

    s = flag_on_client.get("/api/connector/notion/status")
    assert s.status_code == 200
    assert s.json()["data"]["flow"]["status"] == "authorizing"


def test_oauth_start_flow_error_maps_502(flag_on_client, monkeypatch):
    import src.connectors.client as client_mod

    async def failing_flow(flow, **_kwargs):
        flow.status = "error"
        flow.error = "registration rejected"
        flow.auth_url_ready.set()

    monkeypatch.setattr(client_mod, "run_connect_flow", failing_flow)
    r = flag_on_client.post("/api/connector/notion/oauth/start")
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "E_CONNECTOR_OAUTH"


# ── disconnect：逐条删凭证 + 状态复位（工具清单/用户配置保留）───────────────────


def test_disconnect_deletes_credentials_keeps_tool_config(
    flag_on_client, fresh_agent_cfg, monkeypatch
):
    from src.agent_config import credentials

    fresh_agent_cfg.upsert_connector("notion", server_url="https://mcp.notion.com/mcp")
    fresh_agent_cfg.sync_connector_tools(
        "notion",
        [{"name": "search", "description": "", "input_schema": None,
          "output_schema": None, "crud_type": "read"}],
    )
    fresh_agent_cfg.set_connector_tool_enabled("notion", "search", False)
    fresh_agent_cfg.update_connector_state(
        "notion", status="connected", scopes=["default"]
    )
    credentials.set_credential(
        "connector:notion", "tokens", {"token": {"access_token": "x"}},
        store=fresh_agent_cfg,
    )
    credentials.set_credential(
        "connector:notion", "client_info", {"client_id": "c"}, store=fresh_agent_cfg
    )
    # router 走 env 单例 store —— fresh_agent_cfg fixture 已把 env 指到同一 tmp 库。

    r = flag_on_client.post("/api/connector/notion/disconnect")
    assert r.status_code == 200
    assert r.json()["data"]["deleted_credentials"] == 2

    assert credentials.list_credentials("connector:notion", store=fresh_agent_cfg) == []
    row = fresh_agent_cfg.get_connector("notion")
    assert row.status == "disconnected"
    assert row.scopes is None
    # 工具行 + 用户 per-tool 配置保留（重连后偏好还在）。
    rows = fresh_agent_cfg.list_connector_tools("notion")
    assert len(rows) == 1 and rows[0].enabled is False
