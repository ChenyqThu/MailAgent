"""Composio 单轨（08-05 WP-12）：目录数据自检 · session 五件套 · 静态 header 装配 ·
meta 工具过滤 · BYOK 凭证 · 连接流。

🔴 **零真实网络、零真实 key**：REST 面全用 `httpx.MockTransport`，MCP 面用
`httpx2.MockTransport`，key 一律是 `"test-key-not-real"` 这类合成串。
"""

from __future__ import annotations

import asyncio

import pytest

from src.connectors import composio
from src.connectors.composio_catalog import (
    COMPOSIO_CATALOG,
    MAX_PRELOAD_TOOLS,
    is_meta_tool,
    validate_catalog,
)

_FAKE_KEY = "test-key-not-real"


# ── 目录数据 ─────────────────────────────────────────────────────────────────────


def test_catalog_self_check_passes():
    """import 期已跑过一次；显式再跑一次，让「加错数据」在这条用例上有名字。"""
    validate_catalog()


def test_catalog_covers_the_planned_services():
    """E §7.6 的 managed 家全铺（Vercel/PostHog 是 API_KEY scheme，本批有意不做）。"""
    assert set(COMPOSIO_CATALOG) == {
        "gmail",
        "googlecalendar",
        "googledrive",
        "slack",
        "twitter",
        "github",
        "notion",
        "atlassian",
        "linear",
        "outlook",
        "figma",
        "stripe",
        "asana",
        "intercom",
        "sentry",
        "paypal",
    }


def test_every_entry_has_a_bounded_curated_whitelist():
    """白名单是必选项：非空、≤ preload 上限、无重复 —— 不裁剪 = 工具面爆炸（GitHub 947）。"""
    for cid, entry in COMPOSIO_CATALOG.items():
        tools = entry.all_tools
        assert tools, cid
        assert len(tools) <= MAX_PRELOAD_TOOLS, (cid, len(tools))
        assert len(set(tools)) == len(tools), cid


def test_outlook_whitelist_has_no_mail_write_path():
    """🔴 Exchange 邮件读写是本机 davmail 主链路 —— 不给模型第二条写邮件通道。"""
    slugs = COMPOSIO_CATALOG["outlook"].all_tools
    for slug in slugs:
        assert "SEND" not in slug and "DRAFT" not in slug and "REPLY" not in slug, slug
        assert "MESSAGE" not in slug, slug
    # 反面：日历这条正事要在（否则「剔除写邮件」被实现成了「整家不上目录」）。
    assert "OUTLOOK_LIST_EVENTS" in slugs


def test_atlassian_is_one_connector_with_two_toolkits():
    entry = COMPOSIO_CATALOG["atlassian"]
    assert entry.toolkits == ("JIRA", "CONFLUENCE")


def test_meta_tool_predicate():
    assert is_meta_tool("COMPOSIO_SEARCH_TOOLS")
    assert is_meta_tool("COMPOSIO_MULTI_EXECUTE_TOOL")
    assert not is_meta_tool("GMAIL_FETCH_EMAILS")
    assert not is_meta_tool("")


# ── session 创建请求体（五件套） ─────────────────────────────────────────────────


def test_session_create_body_carries_all_five_switches():
    """🔴 spike 结论逐条钉死。少任何一条都会静默出事：

      - 缺 `preload` → 只有 meta 工具出面（绕开 per-tool 档位）；
      - 缺 `workbench.enable=false` → **白送一个云端代码执行沙箱**（默认是开的）；
      - 缺 `manage_connections.enable=false` → 模型能自己去连别的账号。
    """
    entry = COMPOSIO_CATALOG["atlassian"]
    body = composio.session_create_body(entry, "user-x")
    assert body["user_id"] == "user-x"
    assert body["toolkits"] == {"enable": ["jira", "confluence"]}
    assert set(body["tools"]) == {"jira", "confluence"}
    assert body["tools"]["jira"]["enable"] == list(entry.tools["JIRA"])
    assert body["preload"]["tools"] == list(entry.all_tools)
    assert body["manage_connections"] == {"enable": False}
    assert body["workbench"] == {"enable": False}


def test_session_create_body_preload_never_exceeds_limit():
    for cid, entry in COMPOSIO_CATALOG.items():
        body = composio.session_create_body(entry, "u")
        assert len(body["preload"]["tools"]) <= MAX_PRELOAD_TOOLS, cid


# ── 裸 REST（MockTransport，绝不出网）─────────────────────────────────────────────


def _transport(handler):
    import httpx

    return httpx.MockTransport(handler)


def test_create_session_sends_api_key_header_and_extracts_endpoint():
    import httpx

    seen: dict[str, object] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["key"] = request.headers.get("x-api-key")
        return httpx.Response(
            200, json={"session_id": "trs_1", "mcp": {"type": "http", "url": "https://mcp/x"}}
        )

    out = asyncio.run(
        composio.create_session(
            COMPOSIO_CATALOG["gmail"], "u", _FAKE_KEY, http_transport=_transport(_handler)
        )
    )
    assert out == {"session_id": "trs_1", "mcp_url": "https://mcp/x"}
    assert seen["path"] == "/api/v3/tool_router/session"
    assert seen["key"] == _FAKE_KEY


def test_session_without_mcp_url_is_a_protocol_error():
    """没有托管 endpoint 的 session 对我们毫无用处 —— 显式炸，不静默留个空 server_url。"""
    import httpx

    with pytest.raises(composio.ComposioError) as ei:
        asyncio.run(
            composio.create_session(
                COMPOSIO_CATALOG["gmail"],
                "u",
                _FAKE_KEY,
                http_transport=_transport(
                    lambda _r: httpx.Response(200, json={"session_id": "trs_1"})
                ),
            )
        )
    assert ei.value.code == "E_COMPOSIO_PROTOCOL"


def test_bad_key_maps_to_auth_code_and_never_echoes_the_key():
    import httpx

    with pytest.raises(composio.ComposioError) as ei:
        asyncio.run(
            composio.create_session(
                COMPOSIO_CATALOG["gmail"],
                "u",
                _FAKE_KEY,
                http_transport=_transport(lambda _r: httpx.Response(401, json={"code": 906})),
            )
        )
    assert ei.value.code == "E_COMPOSIO_AUTH"
    assert _FAKE_KEY not in str(ei.value)


def test_create_link_returns_redirect_url():
    import httpx

    seen: dict[str, object] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen["body"] = _json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={"redirect_url": "https://connect.composio.dev/link/abc", "id": "ca_1"},
        )

    out = asyncio.run(
        composio.create_link("trs_1", "JIRA", _FAKE_KEY, http_transport=_transport(_handler))
    )
    assert out["redirect_url"].startswith("https://connect.composio.dev/")
    assert seen["body"] == {"toolkit": "jira"}  # toolkit slug 请求里恒小写


def test_connected_account_status_tri_state():
    accounts = [
        {"toolkit": "jira", "status": "ACTIVE"},
        {"toolkit": "confluence", "status": "INITIALIZING"},
        {"toolkit": "gmail", "status": "FAILED"},
    ]
    assert composio.toolkit_connected(accounts, "JIRA") is True
    assert composio.toolkit_connected(accounts, "CONFLUENCE") is None
    assert composio.toolkit_connected(accounts, "GMAIL") is False
    assert composio.toolkit_connected(accounts, "SLACK") is None


def test_list_connected_accounts_normalises_shapes():
    import httpx

    payload = {
        "items": [
            {"toolkit": {"slug": "GMAIL"}, "status": "active"},
            {"toolkit_slug": "slack", "status": "ACTIVE"},
            "garbage",
        ]
    }
    out = asyncio.run(
        composio.list_connected_accounts(
            "u", _FAKE_KEY, http_transport=_transport(lambda _r: httpx.Response(200, json=payload))
        )
    )
    assert out == [
        {"toolkit": "gmail", "status": "ACTIVE"},
        {"toolkit": "slack", "status": "ACTIVE"},
    ]


# ── BYOK 凭证 + user_id ──────────────────────────────────────────────────────────


def test_api_key_roundtrip_and_masked_status(fresh_agent_cfg, monkeypatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    from src.agent_config import secrets

    secrets.reset_master_key_cache()
    assert composio.get_api_key() is None
    assert composio.api_key_status()["configured"] is False

    composio.set_api_key(f"  {_FAKE_KEY}  ")
    assert composio.get_api_key() == _FAKE_KEY  # 两端空白被剪掉
    status = composio.api_key_status()
    assert status["configured"] is True and isinstance(status["updated_at"], int)
    # 🔴 状态视图**不回显任何 key 字符**（脱敏纪律）。
    assert _FAKE_KEY not in str(status)

    assert composio.clear_api_key() is True
    assert composio.get_api_key() is None
    secrets.reset_master_key_cache()


def test_empty_api_key_is_rejected_at_write(fresh_agent_cfg):
    with pytest.raises(ValueError):
        composio.set_api_key("   ")


def test_user_id_is_stable_and_not_an_email(fresh_agent_cfg):
    first = composio.resolve_user_id()
    assert first == composio.resolve_user_id()
    assert "@" not in first and first != "default"


def test_require_api_key_gate_code(fresh_agent_cfg, monkeypatch):
    monkeypatch.setattr(composio, "get_api_key", lambda: None)
    with pytest.raises(composio.ComposioError) as ei:
        composio.require_api_key()
    assert ei.value.code == "E_COMPOSIO_NO_KEY"


# ── 装配模式二：静态 header + meta 工具过滤 ──────────────────────────────────────


def test_composio_row_assembles_with_static_header(fresh_agent_cfg, monkeypatch):
    """composio 行的会话走 `x-api-key` 静态 header，**不**建 OAuthClientProvider。

    握手之后立刻 500 —— 本例要证的是「请求带着哪个头出去」，不是 MCP 协议本身。
    """
    import httpx2

    from src.connectors.client import ConnectorClient, ConnectorError

    fresh_agent_cfg.upsert_connector(
        "gmail", server_url="https://mcp.composio.test/x", display_name="Gmail", source="composio"
    )
    monkeypatch.setattr(composio, "get_api_key", lambda: _FAKE_KEY)
    seen: list[dict[str, str]] = []

    def _handler(request: "httpx2.Request") -> "httpx2.Response":
        seen.append(dict(request.headers))
        return httpx2.Response(500, json={"error": "stop here"})

    cc = ConnectorClient("gmail", interactive=False, timeout_seconds=5.0)
    assert cc.is_composio

    async def _run():
        async with cc.session(http_transport=httpx2.MockTransport(_handler)):
            pass  # pragma: no cover

    with pytest.raises(ConnectorError):
        asyncio.run(_run())
    assert seen, "no request reached the transport"
    assert seen[0].get("x-api-key") == _FAKE_KEY
    assert "authorization" not in seen[0]


def test_composio_row_without_key_reports_not_connected(fresh_agent_cfg, monkeypatch):
    import httpx2

    from src.connectors.client import ConnectorClient, ConnectorError

    fresh_agent_cfg.upsert_connector(
        "gmail", server_url="https://mcp.composio.test/x", source="composio"
    )
    monkeypatch.setattr(composio, "get_api_key", lambda: None)
    cc = ConnectorClient("gmail", interactive=False, timeout_seconds=5.0)

    async def _run():
        async with cc.session(http_transport=httpx2.MockTransport(lambda _r: None)):
            pass  # pragma: no cover

    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_run())
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"


def test_catalog_entry_without_endpoint_refuses_to_open_a_session(fresh_agent_cfg):
    """行还没建（只在目录里）→ server_url 空 → 显式 not-connected，不拿空 URL 发请求。"""
    import httpx2

    from src.connectors.client import ConnectorClient, ConnectorError

    cc = ConnectorClient("slack", interactive=False, timeout_seconds=5.0)

    async def _run():
        async with cc.session(http_transport=httpx2.MockTransport(lambda _r: None)):
            pass  # pragma: no cover

    with pytest.raises(ConnectorError) as ei:
        asyncio.run(_run())
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"


class _FakeTool:
    def __init__(self, name):
        self.name = name
        self.description = ""
        self.input_schema = {"type": "object"}
        self.output_schema = None
        self.annotations = None


class _FakeResult:
    def __init__(self, tools):
        self.tools = tools
        self.next_cursor = None


def _patch_session(monkeypatch, tools):
    """把 `ConnectorClient.session` 换成产出假 MCP client 的 CM（不发任何网络）。"""
    from contextlib import asynccontextmanager

    from src.connectors.client import ConnectorClient

    class _FakeClient:
        async def list_tools(self, cursor=None):
            return _FakeResult(tools)

    @asynccontextmanager
    async def _session(self, **_kwargs):
        yield _FakeClient()

    monkeypatch.setattr(ConnectorClient, "session", _session)


def test_composio_meta_tools_never_enter_the_manifest(fresh_agent_cfg, monkeypatch):
    """🔴 spike 发现 1：meta 工具**删不掉**（preload + 白名单 + manage_connections=false 都
    挡不住），而它们的「搜索→执行」会绕开 per-tool 档位与审批卡 ⇒ 同步入口恒过滤。"""
    from src.connectors.client import ConnectorClient

    fresh_agent_cfg.upsert_connector(
        "gmail", server_url="https://mcp.composio.test/x", source="composio"
    )
    _patch_session(
        monkeypatch,
        [
            _FakeTool("GMAIL_FETCH_EMAILS"),
            _FakeTool("COMPOSIO_SEARCH_TOOLS"),
            _FakeTool("COMPOSIO_MULTI_EXECUTE_TOOL"),
            _FakeTool("COMPOSIO_GET_TOOL_SCHEMAS"),
        ],
    )
    manifest = asyncio.run(ConnectorClient("gmail").list_tools_manifest())
    assert [t["name"] for t in manifest] == ["GMAIL_FETCH_EMAILS"]


def test_custom_mcp_row_does_not_filter_by_prefix(fresh_agent_cfg, monkeypatch):
    """直连轨不滤：一个恰好叫 COMPOSIO_ 开头的远端工具在那边就是个普通工具。"""
    from src.connectors.client import ConnectorClient

    fresh_agent_cfg.upsert_connector(
        "custom", server_url="https://example.test/mcp", source="custom_mcp"
    )
    _patch_session(monkeypatch, [_FakeTool("COMPOSIO_SEARCH_TOOLS"), _FakeTool("other")])
    manifest = asyncio.run(ConnectorClient("custom").list_tools_manifest())
    assert [t["name"] for t in manifest] == ["COMPOSIO_SEARCH_TOOLS", "other"]


# ── 连接流 ───────────────────────────────────────────────────────────────────────


def test_connect_flow_creates_session_links_each_toolkit_then_syncs(
    fresh_agent_cfg, monkeypatch
):
    """多 toolkit 顺序授权 + link_seq 递增 + 落库 connected。"""
    from src.connectors.composio_flow import run_composio_connect_flow
    from src.connectors.oauth_flow import ConnectorFlowState

    monkeypatch.setattr(composio, "require_api_key", lambda: _FAKE_KEY)
    monkeypatch.setattr(composio, "resolve_user_id", lambda: "u-1")

    async def _create_session(entry, user_id, api_key, **_k):
        return {"session_id": "trs_1", "mcp_url": "https://mcp.composio.test/trs_1"}

    links: list[str] = []

    async def _create_link(session_id, toolkit, api_key, **_k):
        links.append(toolkit)
        return {"redirect_url": f"https://connect.composio.dev/{toolkit}"}

    async def _accounts(user_id, api_key, **_k):
        # 已经起过 link 的 toolkit 直接算连上（授权页那一步在测试里不存在）。
        return [{"toolkit": tk.lower(), "status": "ACTIVE"} for tk in links]

    monkeypatch.setattr(composio, "create_session", _create_session)
    monkeypatch.setattr(composio, "create_link", _create_link)
    monkeypatch.setattr(composio, "list_connected_accounts", _accounts)

    class _StubClient:
        def __init__(self, *_a, **_k):
            pass

        async def list_tools_manifest(self, **_k):
            return [
                {"name": "JIRA_GET_ISSUE", "description": "", "crud_type": "read"},
                {"name": "CONFLUENCE_CREATE_PAGE", "description": "", "crud_type": "write"},
            ]

    flow = ConnectorFlowState(connector_id="atlassian", started_at=0.0)
    asyncio.run(
        run_composio_connect_flow(
            flow, COMPOSIO_CATALOG["atlassian"], client_factory=_StubClient
        )
    )

    assert flow.status == "connected" and flow.error is None
    assert links == ["JIRA", "CONFLUENCE"]
    assert flow.link_seq == 2  # 两条链接顺序给出，前端据此再开一次浏览器
    row = fresh_agent_cfg.get_connector("atlassian")
    assert row.status == "connected" and row.source == "composio"
    assert row.composio_session_id == "trs_1"
    assert row.server_url == "https://mcp.composio.test/trs_1"
    names = {t.tool_name for t in fresh_agent_cfg.list_connector_tools("atlassian")}
    assert names == {"JIRA_GET_ISSUE", "CONFLUENCE_CREATE_PAGE"}


def test_connect_flow_without_key_lands_error_not_hang(fresh_agent_cfg, monkeypatch):
    from src.connectors.composio_flow import run_composio_connect_flow
    from src.connectors.oauth_flow import ConnectorFlowState

    monkeypatch.setattr(composio, "get_api_key", lambda: None)
    flow = ConnectorFlowState(connector_id="gmail", started_at=0.0)
    asyncio.run(run_composio_connect_flow(flow, COMPOSIO_CATALOG["gmail"]))
    assert flow.status == "error" and "API key is not configured" in (flow.error or "")
    # 🔴 auth_url_ready 必须被 set —— 否则 start 端点会一直等到 30s 超时才报一个错误的原因。
    assert flow.auth_url_ready.is_set()


def test_connect_flow_reuses_an_existing_session(fresh_agent_cfg, monkeypatch):
    """已有 session id → 走 get_session 复用，不再建新的（Composio 没有 DELETE 端点，
    每次重建都留一个僵尸 session）。"""
    from src.connectors.composio_flow import run_composio_connect_flow
    from src.connectors.oauth_flow import ConnectorFlowState

    fresh_agent_cfg.upsert_connector(
        "gmail",
        server_url="https://mcp.composio.test/old",
        source="composio",
        composio_session_id="trs_old",
    )
    monkeypatch.setattr(composio, "require_api_key", lambda: _FAKE_KEY)
    monkeypatch.setattr(composio, "resolve_user_id", lambda: "u-1")
    created = []

    async def _create_session(*_a, **_k):
        created.append(1)
        return {"session_id": "trs_new", "mcp_url": "https://x"}

    async def _get_session(session_id, api_key, **_k):
        return {"session_id": session_id, "mcp_url": f"https://mcp.composio.test/{session_id}"}

    monkeypatch.setattr(composio, "create_session", _create_session)
    monkeypatch.setattr(composio, "get_session", _get_session)
    monkeypatch.setattr(
        composio,
        "list_connected_accounts",
        lambda *_a, **_k: _resolved([{"toolkit": "gmail", "status": "ACTIVE"}]),
    )

    class _StubClient:
        def __init__(self, *_a, **_k):
            pass

        async def list_tools_manifest(self, **_k):
            return []

    flow = ConnectorFlowState(connector_id="gmail", started_at=0.0)
    asyncio.run(
        run_composio_connect_flow(flow, COMPOSIO_CATALOG["gmail"], client_factory=_StubClient)
    )
    assert created == []
    assert fresh_agent_cfg.get_connector("gmail").composio_session_id == "trs_old"


def test_connect_flow_releases_the_start_endpoint_when_no_link_is_needed(
    fresh_agent_cfg, monkeypatch
):
    """🔴 全部 toolkit 在 Composio 侧之前就 ACTIVE（清行重装 / 上次拉清单失败后重试）→
    一条 Connect Link 都不起。

    此时 `auth_url_ready` 必须**在拉清单之前**就 set：`POST /oauth/start` 只等这个事件，
    不放行的话它会挂到整条流跑完，大概率先撞 30s 超时报一个假失败（而响应里的
    `authorize_url` 还是 None，前端会去 open(null)）。
    """
    from src.connectors.composio_flow import run_composio_connect_flow
    from src.connectors.oauth_flow import ConnectorFlowState

    monkeypatch.setattr(composio, "require_api_key", lambda: _FAKE_KEY)
    monkeypatch.setattr(composio, "resolve_user_id", lambda: "u-1")

    async def _create_session(*_a, **_k):
        return {"session_id": "trs_1", "mcp_url": "https://mcp.composio.test/trs_1"}

    async def _no_link(*_a, **_k):  # pragma: no cover — 断言它不该被调用
        raise AssertionError("must not create a link for an already-connected toolkit")

    monkeypatch.setattr(composio, "create_session", _create_session)
    monkeypatch.setattr(composio, "create_link", _no_link)
    monkeypatch.setattr(
        composio,
        "list_connected_accounts",
        lambda *_a, **_k: _resolved([{"toolkit": "gmail", "status": "ACTIVE"}]),
    )

    flow = ConnectorFlowState(connector_id="gmail", started_at=0.0)
    seen_ready: list[bool] = []

    class _StubClient:
        def __init__(self, *_a, **_k):
            pass

        async def list_tools_manifest(self, **_k):
            seen_ready.append(flow.auth_url_ready.is_set())  # 拉清单时端点已被放行？
            return []

    asyncio.run(
        run_composio_connect_flow(flow, COMPOSIO_CATALOG["gmail"], client_factory=_StubClient)
    )
    assert seen_ready == [True]
    assert flow.auth_url is None  # 没有链接就是没有 —— 不编一个出来
    assert flow.status == "connected" and flow.error is None


def _resolved(value):
    """同步 lambda 里返回一个已完成的 awaitable（monkeypatch 异步函数用）。"""

    async def _coro():
        return value

    return _coro()
