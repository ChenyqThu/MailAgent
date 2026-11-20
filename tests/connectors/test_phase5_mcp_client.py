"""Phase 5 WP-5B — MCP Client 细粒度控制 & 自定义 HTTP/stdio 连接器测试。

覆盖：
  1. WP-5B.1：write / update / destructive(read) 默认 effective_mode 收紧为 'ask'，
     仅非破坏性 read 默认 'auto'；显式覆写 'auto' 后恢复。
  2. WP-5B.2：per-agent ``grant_connector_tools`` 白名单在注册面（``build_connector_llm_tools``）
     与执行面（``resolve_caller_allowed_tools`` + ``invoke_connector_tool`` -> 403 E_CONNECTOR_TOOL_NOT_GRANTED）
     双层收敛；显式 ``[]`` 禁止该连接器全部工具。
  3. WP-5B.4：``POST/PATCH/DELETE /api/connector/custom`` ``verify_local_token`` 鉴权、
     自定义 HTTP 静态 header 掩码投影、以及真实本地 ``stdio`` MCP 子进程：
     懒启动（创建时不派生）→ ``sync`` 首次拉起 → ``invoke`` 复用并透传解密 env →
     ``DELETE /custom/{id}`` 回收子进程并清理库行。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterator

# Ensure standalone pytest execution under tests/connectors/ satisfies src.api.auth import guards.
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")
os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(tempfile.mkdtemp(prefix="mailagent-p5-conntest-"), "agent_config.db"),
)

import pytest
from fastapi.testclient import TestClient

import src.api.auth as auth_mod
from src.agent_config import secrets
from src.agent_config import store as acstore
from src.agent_config.store import (
    AgentConfigStore,
    connector_tool_effective_mode,
)
from src.agents.trigger import parse_tool_policy, validate_agent_config_patch
from src.api.app import app
from src.api.deps import get_settings
from src.connectors import llm_tools as lt
from src.connectors import service as conn_service
from src.connectors.stdio_pool import stdio_pool

LOCAL_TOK = "ephemeral-secret-phase5-mcp-client"
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}


class _Cfg:
    mcp_connectors_enabled = True
    connector_timeout_seconds = 5.0


def _force_keyfile(monkeypatch: pytest.MonkeyPatch) -> None:
    def _unavailable(*_a: Any, **_k: Any) -> None:
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)


@pytest.fixture()
def conn_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, AgentConfigStore, Path]]:
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    _force_keyfile(monkeypatch)
    secrets.reset_master_key_cache()
    acstore.reset_agent_config_store_cache()
    app.dependency_overrides[get_settings] = lambda: _Cfg()
    try:
        store = acstore.get_agent_config_store()
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client, store, tmp_path
    finally:
        app.dependency_overrides.pop(get_settings, None)
        secrets.reset_master_key_cache()
        acstore.reset_agent_config_store_cache()


def _arm_cf_jwt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


# ── WP-5B.1 ───────────────────────────────────────────────────────────────────────────


def test_wp5b1_tightens_write_update_and_destructive_defaults(
    conn_env: tuple[TestClient, AgentConfigStore, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, store, _ = conn_env
    assert connector_tool_effective_mode(None, crud_type="read", destructive=False) == "auto"
    assert connector_tool_effective_mode(None, crud_type="read", destructive=True) == "ask"
    assert connector_tool_effective_mode(None, crud_type="write", destructive=False) == "ask"
    assert connector_tool_effective_mode(None, crud_type="update", destructive=False) == "ask"
    assert connector_tool_effective_mode("auto", crud_type="write", destructive=True) == "auto"

    store.upsert_connector("notion", server_url="https://mcp.notion.com/mcp", display_name="Notion")
    store.update_connector_state("notion", status="connected")
    store.sync_connector_tools(
        "notion",
        [
            {"name": "fetch_page", "description": "Read", "crud_type": "read", "destructive": False},
            {"name": "risky_read", "description": "Destructive read", "crud_type": "read", "destructive": True},
            {"name": "create_page", "description": "Write", "crud_type": "write", "destructive": False},
            {"name": "update_page", "description": "Update", "crud_type": "update", "destructive": False},
        ],
    )

    resp = client.get("/api/connector/notion/tools")
    assert resp.status_code == 200, resp.text
    modes = {t["name"]: t["effective_mode"] for t in resp.json()["data"]["tools"]}
    assert modes == {
        "fetch_page": "auto",
        "risky_read": "ask",
        "create_page": "ask",
        "update_page": "ask",
    }

    monkeypatch.setattr(lt, "_connectors_enabled", lambda: True)
    _, handlers = lt.build_connector_llm_tools(
        [("notion", None)], caller="email_preprocess", only_auto_tools=True
    )
    assert sorted(handlers) == ["mcp__notion__fetch_page"]

    # Explicit opt-in on write exposes it to only_auto_tools when explicitly set to 'auto'.
    store.set_connector_tool_mode("notion", "create_page", "auto")
    _, handlers_after = lt.build_connector_llm_tools(
        [("notion", None)], caller="email_preprocess", only_auto_tools=True
    )
    assert sorted(handlers_after) == ["mcp__notion__create_page", "mcp__notion__fetch_page"]


# ── WP-5B.2 ───────────────────────────────────────────────────────────────────────────


def test_wp5b2_grant_connector_tools_allowlist_registration_and_invoke(
    conn_env: tuple[TestClient, AgentConfigStore, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, store, _ = conn_env
    store.upsert_connector("notion", server_url="https://mcp.notion.com/mcp", display_name="Notion")
    store.update_connector_state("notion", status="connected")
    store.sync_connector_tools(
        "notion",
        [
            {"name": "search", "description": "Search", "crud_type": "read"},
            {"name": "fetch", "description": "Fetch", "crud_type": "read"},
            {"name": "create_page", "description": "Create", "crud_type": "write"},
        ],
    )

    # Trigger validation preserves valid grant_connector_tools (including explicit []) and rejects junk.
    parsed = parse_tool_policy(
        json.dumps(
            {
                "grant_connectors": {"notion": "write"},
                "grant_connector_tools": {"notion": ["search"]},
            }
        )
    )
    assert dict(parsed.grant_connector_tools) == {"notion": ("search",)}
    validate_agent_config_patch(
        {"tool_policy": {"grant_connectors": {"notion": "write"}, "grant_connector_tools": {"notion": []}}}
    )
    with pytest.raises(ValueError):
        validate_agent_config_patch({"tool_policy": {"grant_connector_tools": {"notion": "search"}}})

    agent_policy = {
        "grant_connectors": {"notion": "write"},
        "grant_connector_tools": {"notion": ["search"]},
    }
    monkeypatch.setattr(
        conn_service,
        "_load_agent_row",
        lambda aid: {"id": aid, "tool_policy_json": json.dumps(agent_policy)},
    )
    monkeypatch.setattr(lt, "_connectors_enabled", lambda: True)

    # Registration narrows to allowlist ONLY; explicit [] yields zero tools.
    _, narrowed = lt.build_connector_llm_tools(
        [("notion", "write")],
        caller="headless",
        connector_tool_allowlist={"notion": ["search"]},
    )
    assert sorted(narrowed) == ["mcp__notion__search"]

    _, empty_list = lt.build_connector_llm_tools(
        [("notion", "write")],
        caller="headless",
        connector_tool_allowlist={"notion": []},
    )
    assert empty_list == {}

    # Execution authority check: headless caller enforces grant_connector_tools; manual ignores it.
    assert (
        conn_service.resolve_caller_allowed_tools(
            {"context_mode": "cron_headless", "agent_id": "agent-1"}, "notion"
        )
        == frozenset({"search"})
    )
    assert (
        conn_service.resolve_caller_allowed_tools(
            {"context_mode": "manual_chat", "agent_id": None}, "notion"
        )
        is None
    )

    async def _fake_call_tool(self, tool_name: str, arguments: Any = None, **_kw: Any) -> dict[str, Any]:
        return {"content": json.dumps({"tool": tool_name, "args": arguments}), "is_error": False, "truncated": False, "elapsed_ms": 1}

    monkeypatch.setattr("src.connectors.client.ConnectorClient.call_tool", _fake_call_tool)

    denied = client.post(
        "/api/connector/notion/tools/create_page/invoke",
        json={
            "arguments": {"title": "t"},
            "caller": {"context_mode": "cron_headless", "agent_id": "agent-1"},
        },
    )
    assert denied.status_code == 403, denied.text
    assert denied.json()["error"]["code"] == "E_CONNECTOR_TOOL_NOT_GRANTED"

    allowed = client.post(
        "/api/connector/notion/tools/search/invoke",
        json={
            "arguments": {"q": "hello"},
            "caller": {"context_mode": "untrusted_trigger", "agent_id": "agent-1"},
        },
    )
    assert allowed.status_code == 200, allowed.text
    assert json.loads(allowed.json()["data"]["content"])["tool"] == "search"

    # Explicit [] allows no tools at all even with write ceiling.
    agent_policy["grant_connector_tools"] = {"notion": []}
    denied_all = client.post(
        "/api/connector/notion/tools/search/invoke",
        json={
            "arguments": {"q": "hello"},
            "caller": {"context_mode": "cron_headless", "agent_id": "agent-1"},
        },
    )
    assert denied_all.status_code == 403
    assert denied_all.json()["error"]["code"] == "E_CONNECTOR_TOOL_NOT_GRANTED"


# ── WP-5B.4 ───────────────────────────────────────────────────────────────────────────


_MOCK_STDIO_SERVER = '''import json
import os
import sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    text = line.strip()
    if not text:
        continue
    req = json.loads(text)
    method = req.get("method")
    req_id = req.get("id")
    if method == "initialize":
        proto = (req.get("params") or {}).get("protocolVersion", "2024-11-05")
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": proto,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mock-stdio-mcp", "version": "1.0.0"},
            },
        })
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "echo_env",
                        "description": "Echo secret env var from stdio server",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"msg": {"type": "string"}},
                        },
                        "annotations": {"readOnlyHint": True},
                    },
                    {
                        "name": "mutate_item",
                        "description": "Write tool",
                        "inputSchema": {"type": "object", "properties": {}},
                        "annotations": {"readOnlyHint": False},
                    },
                ]
            },
        })
    elif method == "tools/call":
        params = req.get("params") or {}
        payload = {
            "secret": os.environ.get("MCP_SECRET_ENV"),
            "pid": os.getpid(),
            "tool": params.get("name"),
            "args": params.get("arguments") or {},
        }
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(payload)}],
            },
        })
    elif req_id is not None:
        send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "not found"}})
'''


def test_wp5b4_custom_connector_endpoints_enforce_local_token(
    conn_env: tuple[TestClient, AgentConfigStore, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _, _ = conn_env
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)

    create_payload = {
        "connector_id": "custom_http_srv",
        "display_name": "Local HTTP MCP",
        "transport": "streamable_http",
        "server_url": "http://127.0.0.1:19999/mcp",
        "headers": {"Authorization": "Bearer super-secret-token"},
    }
    for headers in (CF_HEADERS, {}):
        assert client.post("/api/connector/custom", json=create_payload, headers=headers).status_code == 403
        assert (
            client.patch(
                "/api/connector/custom/custom_http_srv",
                json={"display_name": "Updated"},
                headers=headers,
            ).status_code
            == 403
        )
        assert client.delete("/api/connector/custom/custom_http_srv", headers=headers).status_code == 403

    created = client.post("/api/connector/custom", json=create_payload, headers=LOCAL_HEADERS)
    assert created.status_code == 200, created.text
    summary = created.json()["data"]
    assert summary["is_custom"] is True
    assert summary["custom_header_names"] == ["Authorization"]
    assert "super-secret-token" not in created.text

    listed = client.get("/api/connector", headers=CF_HEADERS)
    assert listed.status_code == 200
    assert "super-secret-token" not in listed.text

    updated = client.patch(
        "/api/connector/custom/custom_http_srv",
        json={"display_name": "Local HTTP Renamed"},
        headers=LOCAL_HEADERS,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["data"]["display_name"] == "Local HTTP Renamed"

    deleted = client.delete("/api/connector/custom/custom_http_srv", headers=LOCAL_HEADERS)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["data"] == {"connector_id": "custom_http_srv", "deleted": True}


def test_wp5b4_lazy_stdio_mcp_subprocess_lifecycle(
    conn_env: tuple[TestClient, AgentConfigStore, Path],
) -> None:
    client, store, tmp_path = conn_env
    script_path = tmp_path / "mock_mcp_stdio.py"
    script_path.write_text(_MOCK_STDIO_SERVER, encoding="utf-8")

    cid = "local_stdio_demo"
    created = client.post(
        "/api/connector/custom",
        json={
            "connector_id": cid,
            "display_name": "Mock Stdio MCP",
            "transport": "stdio",
            "command": sys.executable,
            "args": ["-u", str(script_path)],
            "cwd": str(tmp_path),
            "env": {"MCP_SECRET_ENV": "top-secret-42"},
        },
    )
    assert created.status_code == 200, created.text
    cdata = created.json()["data"]
    assert cdata["is_custom"] is True
    assert cdata["transport"] == "stdio"
    assert cdata["stdio_env_keys"] == ["MCP_SECRET_ENV"]
    assert "top-secret-42" not in created.text

    # Lazy spawn: creating the custom stdio connector does NOT spawn its subprocess yet.
    assert cid not in stdio_pool.active_connector_ids()

    # Sync lazily spawns the child process and fetches tool definitions.
    sync_resp = client.post(f"/api/connector/{cid}/sync")
    assert sync_resp.status_code == 200, sync_resp.text
    assert cid in stdio_pool.active_connector_ids()

    tools_resp = client.get(f"/api/connector/{cid}/tools")
    assert tools_resp.status_code == 200
    modes = {t["name"]: t["effective_mode"] for t in tools_resp.json()["data"]["tools"]}
    assert modes == {"echo_env": "auto", "mutate_item": "ask"}

    # Two calls reuse the same pooled child process and receive decrypted env vars.
    r1 = client.post(f"/api/connector/{cid}/tools/echo_env/invoke", json={"arguments": {"msg": "hi"}})
    assert r1.status_code == 200, r1.text
    p1 = json.loads(r1.json()["data"]["content"])
    assert p1["secret"] == "top-secret-42"
    assert p1["args"] == {"msg": "hi"}

    r2 = client.post(f"/api/connector/{cid}/tools/echo_env/invoke", json={"arguments": {"msg": "again"}})
    assert r2.status_code == 200, r2.text
    p2 = json.loads(r2.json()["data"]["content"])
    assert p2["pid"] == p1["pid"]

    # Deleting reaps the worker & purges connector row.
    del_resp = client.delete(f"/api/connector/custom/{cid}")
    assert del_resp.status_code == 200, del_resp.text
    assert cid not in stdio_pool.active_connector_ids()
    assert store.get_connector(cid) is None


# ── WS-2 Plane 2: Runtime Dormancy & StdioSessionPool TTL / Invalidation ─────────────


def test_ws2_sqlite_only_discovery_spawns_zero_workers_or_clients(
    conn_env: tuple[TestClient, AgentConfigStore, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GET /api/connector, /catalog, /{id}/tools, /{id}/status only read SQLite."""
    client, store, tmp_path = conn_env
    script_path = tmp_path / "dormant_stdio.py"
    script_path.write_text(_MOCK_STDIO_SERVER, encoding="utf-8")

    # Seed a stdio custom connector and pre-synced SQLite tool rows + a remote SSE connector.
    store.upsert_custom_connector(
        "dormant_stdio",
        display_name="Dormant Stdio",
        transport="stdio",
        stdio_command={"command": sys.executable, "args": ["-u", str(script_path)], "cwd": str(tmp_path)},
    )
    store.sync_connector_tools(
        "dormant_stdio",
        [{"name": "echo_env", "description": "Read", "crud_type": "read"}],
    )
    store.upsert_custom_connector(
        "dormant_sse",
        display_name="Dormant SSE",
        transport="sse",
        server_url="https://mcp.dormant.test/sse",
    )
    store.sync_connector_tools(
        "dormant_sse",
        [{"name": "ping", "description": "Read", "crud_type": "read"}],
    )

    class _ExplodingClient:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            raise AssertionError("listing/catalog endpoints must never construct ConnectorClient")

    monkeypatch.setattr("src.connectors.client.ConnectorClient", _ExplodingClient)
    before_ids = list(stdio_pool.active_connector_ids())
    assert stdio_pool.active_count() == len(before_ids)

    assert client.get("/api/connector").status_code == 200
    assert client.get("/api/connector/catalog").status_code == 200
    assert client.get("/api/connector/dormant_stdio/tools").status_code == 200
    assert client.get("/api/connector/dormant_sse/tools").status_code == 200
    assert client.get("/api/connector/dormant_stdio/status").status_code == 200
    assert client.get("/api/connector/dormant_sse/status").status_code == 200

    assert "dormant_stdio" not in stdio_pool.active_connector_ids()
    assert stdio_pool.active_count() == len(before_ids)


def test_ws2_stdio_pool_lazy_acquire_ttl_reap_and_invalidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """0 workers at boot -> lazy spawn on call_tool -> idle TTL reap -> targeted invalidate."""
    import asyncio

    from src.connectors.stdio_pool import StdioSessionPool

    script_path = tmp_path / "mock_mcp_stdio.py"
    script_path.write_text(_MOCK_STDIO_SERVER, encoding="utf-8")
    cmd = {"command": sys.executable, "args": ["-u", str(script_path)], "cwd": str(tmp_path)}

    pool = StdioSessionPool()

    # Default TTL resolution: normal 300s, browser_use/desktop_use 600s, explicit override respected.
    assert pool._effective_idle_ttl("other_stdio") == 300.0
    assert pool._effective_idle_ttl("browser_use") == 600.0
    assert pool._effective_idle_ttl("desktop_use") == 600.0
    assert pool._effective_idle_ttl("browser_use", 42.0) == 42.0
    assert StdioSessionPool(idle_ttl_seconds=120.0)._effective_idle_ttl("browser_use") == 120.0

    async def _exercise() -> None:
        try:
            assert pool.active_count() == 0
            assert pool.active_connector_ids() == []

            # Lazy spawn on call_tool with short per-connector idle TTL.
            res = await pool.call_tool(
                "short_ttl_srv",
                "echo_env",
                {"msg": "ping"},
                cmd=cmd,
                env={"MCP_SECRET_ENV": "val-1"},
                timeout_seconds=5.0,
                idle_ttl_seconds=0.15,
            )
            assert json.loads(res.content[0].text)["args"] == {"msg": "ping"}
            assert pool.active_count() == 1
            assert pool.active_connector_ids() == ["short_ttl_srv"]

            # Wait past idle TTL -> worker automatically reaped back to 0.
            for _ in range(30):
                if pool.active_count() == 0:
                    break
                await asyncio.sleep(0.05)
            assert pool.active_count() == 0
            assert pool.active_connector_ids() == []

            # Acquire two workers and invalidate only one.
            await pool.acquire("srv_a", cmd=cmd, env={}, timeout_seconds=5.0, idle_ttl_seconds=30.0)
            await pool.acquire("srv_b", cmd=cmd, env={}, timeout_seconds=5.0, idle_ttl_seconds=30.0)
            assert pool.active_count() == 2
            assert set(pool.active_connector_ids()) == {"srv_a", "srv_b"}

            await pool.invalidate("srv_a")
            assert pool.active_count() == 1
            assert pool.active_connector_ids() == ["srv_b"]
        finally:
            await pool.close_all()
            assert pool.active_count() == 0

    asyncio.run(_exercise())
