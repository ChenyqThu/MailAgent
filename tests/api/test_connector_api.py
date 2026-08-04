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
        ("POST", "/api/connector/notion/tools/search/invoke"),
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
            "destructive": True,
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
    # PR2 裁决① — destructive 位随清单返回（审批卡红警告的数据源）。
    assert tools["create_page"]["destructive"] is True
    assert tools["search"]["destructive"] is False


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


# ── invoke：MCP 调用代理（PR2）—— 白名单四道闸 + 截断透传 ───────────────────────


def _seed_tools(store):
    """直接种清单（invoke 闸只看 store 行；不需要走 sync 端点）。"""
    store.upsert_connector("notion", server_url="https://mcp.notion.com/mcp")
    store.sync_connector_tools(
        "notion",
        [
            {"name": "search", "description": "", "input_schema": None,
             "output_schema": None, "crud_type": "read"},
            {"name": "create_page", "description": "", "input_schema": None,
             "output_schema": None, "crud_type": "write", "destructive": True},
            {"name": "delete_page", "description": "", "input_schema": None,
             "output_schema": None, "crud_type": "delete"},
        ],
    )


class _InvokeStubClient:
    """call_tool stub —— 记录入参，返回有界结果形状。"""

    last_call = None

    def __init__(self, connector_id, **_kwargs):
        self.connector_id = connector_id

    async def call_tool(self, tool_name, arguments=None, **_kwargs):
        type(self).last_call = (self.connector_id, tool_name, arguments)
        return {"content": "fenced later", "is_error": False, "truncated": True}


def test_invoke_unknown_tool_404_never_forwarded(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = flag_on_client.post("/api/connector/notion/tools/forged_tool/invoke")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"
    assert _InvokeStubClient.last_call is None  # 伪造名字到不了远端


def test_invoke_delete_class_403(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = flag_on_client.post("/api/connector/notion/tools/delete_page/invoke")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_TOOL_FORBIDDEN"
    assert _InvokeStubClient.last_call is None


def test_invoke_disabled_tool_409_actionable(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    # write 默认关（effective_enabled 折算 False）。
    r = flag_on_client.post("/api/connector/notion/tools/create_page/invoke")
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "E_CONNECTOR_TOOL_DISABLED"
    assert "Settings" in err["message"]  # 可行动解释（AC：告诉用户去设置开）

    # 用户显式打开后可调。
    fresh_agent_cfg.set_connector_tool_enabled("notion", "create_page", True)
    r2 = flag_on_client.post("/api/connector/notion/tools/create_page/invoke")
    assert r2.status_code == 200


def test_invoke_orphan_tool_409(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    # 远端清单里 search 消失 → orphan=1（配置行保留）。
    fresh_agent_cfg.sync_connector_tools(
        "notion",
        [{"name": "create_page", "description": "", "input_schema": None,
          "output_schema": None, "crud_type": "write"}],
    )
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = flag_on_client.post("/api/connector/notion/tools/search/invoke")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_CONNECTOR_TOOL_ORPHAN"


def test_invoke_success_passes_arguments_and_truncation(
    flag_on_client, fresh_agent_cfg, monkeypatch
):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = flag_on_client.post(
        "/api/connector/notion/tools/search/invoke",
        json={"arguments": {"query": "roadmap"}},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["tool_name"] == "search" and data["connector_id"] == "notion"
    # 截断位如实透传（client 层已按 CALL_RESULT_MAX_CHARS 截）+ 耗时可观测（#69 纪律）。
    assert data["truncated"] is True and data["is_error"] is False
    assert isinstance(data["elapsed_ms"], int)
    assert _InvokeStubClient.last_call == ("notion", "search", {"query": "roadmap"})


def test_invoke_bad_arguments_shape_400(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = flag_on_client.post(
        "/api/connector/notion/tools/search/invoke", json={"arguments": ["not", "a", "dict"]}
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_invoke_not_connected_maps_and_marks_error_state(
    flag_on_client, fresh_agent_cfg, monkeypatch
):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)

    class _Unauthorized(_InvokeStubClient):
        async def call_tool(self, tool_name, arguments=None, **_kwargs):
            raise client_mod.ConnectorError(
                "not authorized", code="E_CONNECTOR_NOT_CONNECTED"
            )

    monkeypatch.setattr(client_mod, "ConnectorClient", _Unauthorized)
    r = flag_on_client.post("/api/connector/notion/tools/search/invoke")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_CONNECTOR_NOT_CONNECTED"
    row = fresh_agent_cfg.get_connector("notion")
    assert row is not None and row.status == "error"  # 镜像 sync：授权失效如实转 error 态


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


# ── PR3：caller 二道闸（授权判定与执行同侧）─────────────────────────────────────


def _grant_agent(monkeypatch, grants, *, agent_id="cust_a"):
    """把 report_agent 行的读接缝换成内存行（不碰 sync_store.db）。"""
    import json as _json

    import src.connectors.service as svc

    row = {"id": agent_id, "type": "custom", "enabled": 1}
    if grants is not None:
        row["tool_policy_json"] = _json.dumps({"v": 1, "grant_connectors": grants})
    monkeypatch.setattr(svc, "_load_agent_row", lambda aid: row if aid == agent_id else None)


def _invoke(client, tool, *, caller=None, args=None):
    body = {"arguments": args or {}}
    if caller is not None:
        body["caller"] = caller
    return client.post(f"/api/connector/notion/tools/{tool}/invoke", json=body)


_HEADLESS = {"context_mode": "cron_headless", "agent_id": "cust_a"}


def test_invoke_headless_with_grant_allowed(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    _grant_agent(monkeypatch, {"notion": "read"})
    r = _invoke(flag_on_client, "search", caller=_HEADLESS)
    assert r.status_code == 200
    assert _InvokeStubClient.last_call is not None


def test_invoke_headless_without_grant_403(flag_on_client, fresh_agent_cfg, monkeypatch):
    """去掉 grant → 调不动（服务端二道闸；gateway 注册期过滤是第一道）。"""
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    _grant_agent(monkeypatch, {})  # 有行、无 grant
    r = _invoke(flag_on_client, "search", caller=_HEADLESS)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_GRANT_DENIED"
    assert _InvokeStubClient.last_call is None  # 到不了远端


def test_invoke_headless_unknown_agent_403(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    _grant_agent(monkeypatch, {"notion": "update"})
    r = _invoke(flag_on_client, "search", caller={"context_mode": "cron_headless", "agent_id": "ghost"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_GRANT_DENIED"


def test_invoke_headless_missing_agent_id_403(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = _invoke(flag_on_client, "search", caller={"context_mode": "untrusted_trigger"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_GRANT_DENIED"


def test_invoke_ceiling_blocks_write_tool(flag_on_client, fresh_agent_cfg, monkeypatch):
    """🔴 天花板生效：给 read 的 agent 调不动 write 类工具（且与 per-tool 启用是两道独立闸）。"""
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    fresh_agent_cfg.set_connector_tool_enabled("notion", "create_page", True)  # 工具本身是开的
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    _grant_agent(monkeypatch, {"notion": "read"})
    r = _invoke(flag_on_client, "create_page", caller=_HEADLESS)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_GRANT_DENIED"
    assert _InvokeStubClient.last_call is None
    # 天花板抬到 write → 同一封调用放行（证明拒的是天花板、不是别的闸）。
    _grant_agent(monkeypatch, {"notion": "write"})
    assert _invoke(flag_on_client, "create_page", caller=_HEADLESS).status_code == 200


def test_invoke_delete_class_forbidden_even_with_max_grant(
    flag_on_client, fresh_agent_cfg, monkeypatch
):
    """AC：删除类在任何 grant 下都不可调（headless 面也一样）。"""
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    _grant_agent(monkeypatch, {"notion": "update"})
    r = _invoke(flag_on_client, "delete_page", caller=_HEADLESS)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_TOOL_FORBIDDEN"
    assert _InvokeStubClient.last_call is None


def test_invoke_im_chat_always_denied(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    r = _invoke(flag_on_client, "search", caller={"context_mode": "im_chat", "agent_id": None})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_GRANT_DENIED"
    assert _InvokeStubClient.last_call is None


def test_invoke_manual_chat_caller_behaves_like_no_caller(
    flag_on_client, fresh_agent_cfg, monkeypatch
):
    """owner 面：manual_chat（以及 caller 缺席）不加天花板 —— PR2 行为逐字节保留。"""
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    fresh_agent_cfg.set_connector_tool_enabled("notion", "create_page", True)
    assert _invoke(
        flag_on_client, "create_page", caller={"context_mode": "manual_chat", "agent_id": None}
    ).status_code == 200
    assert _invoke(flag_on_client, "create_page").status_code == 200


def test_invoke_bad_caller_shape_400(flag_on_client, fresh_agent_cfg, monkeypatch):
    """未知 context_mode / 非 object → 400（调用方 bug 早暴露，不静默降级成「无约束」）。"""
    import src.connectors.client as client_mod

    _seed_tools(fresh_agent_cfg)
    _InvokeStubClient.last_call = None
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    for bad in ({"context_mode": "root_mode"}, {"agent_id": "x"}, "manual_chat", 1):
        r = _invoke(flag_on_client, "search", caller=bad)
        assert r.status_code == 400, bad
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert _InvokeStubClient.last_call is None


def test_invoke_headless_bad_tool_policy_is_fail_closed(
    flag_on_client, fresh_agent_cfg, monkeypatch
):
    """坏 tool_policy_json → 读侧宽容退回「未配置」= 无授权（fail-closed 方向）。"""
    import src.connectors.client as client_mod
    import src.connectors.service as svc

    _seed_tools(fresh_agent_cfg)
    monkeypatch.setattr(client_mod, "ConnectorClient", _InvokeStubClient)
    monkeypatch.setattr(
        svc, "_load_agent_row", lambda _aid: {"id": "cust_a", "tool_policy_json": "{not json"}
    )
    r = _invoke(flag_on_client, "search", caller=_HEADLESS)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_CONNECTOR_GRANT_DENIED"


# ── PR3：分类侧独立授权开关 ────────────────────────────────────────────────────


def test_preprocess_toggle_roundtrip_and_projection(flag_on_client, fresh_agent_cfg):
    fresh_agent_cfg.upsert_connector("notion", server_url="https://mcp.notion.com/mcp")
    # 默认关（list / status 都如实投影）。
    listed = {c["connector_id"]: c for c in flag_on_client.get("/api/connector").json()["data"]["connectors"]}
    assert listed["notion"]["preprocess_enabled"] is False
    assert flag_on_client.get("/api/connector/notion/status").json()["data"]["preprocess_enabled"] is False

    r = flag_on_client.post("/api/connector/notion/preprocess", json={"enabled": True})
    assert r.status_code == 200 and r.json()["data"]["preprocess_enabled"] is True
    assert fresh_agent_cfg.get_connector("notion").preprocess_enabled is True
    assert flag_on_client.get("/api/connector/notion/status").json()["data"]["preprocess_enabled"] is True

    assert flag_on_client.post("/api/connector/notion/preprocess", json={"enabled": False}).status_code == 200
    assert fresh_agent_cfg.get_connector("notion").preprocess_enabled is False


def test_preprocess_toggle_validates(flag_on_client, fresh_agent_cfg):
    fresh_agent_cfg.upsert_connector("notion", server_url="https://x")
    for bad in ({"enabled": "yes"}, {"enabled": 1}, {}):
        r = flag_on_client.post("/api/connector/notion/preprocess", json=bad)
        assert r.status_code == 400, bad
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    # 未知 connector → 404（registry 闸）；已知但没行 → 404（先连接再授权）。
    assert flag_on_client.post("/api/connector/ghost/preprocess", json={"enabled": True}).status_code == 404
    assert flag_on_client.post("/api/connector/atlassian/preprocess", json={"enabled": True}).status_code == 404


def test_preprocess_toggle_flag_off_409(flag_off_client):
    r = flag_off_client.post("/api/connector/notion/preprocess", json={"enabled": True})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_CONNECTOR_DISABLED"
