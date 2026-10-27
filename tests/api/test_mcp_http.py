"""POST /mcp —— MCP Streamable HTTP 端点（无状态，Notion Custom Agent 等远程 MCP 客户端用）。

鉴权与 /api/skills 同一个 authenticate_principal；bearer 腿要求 AUTH_DISABLED=False。
JSON-RPC 分派复用 mailagent_mcp.handle_request，这里只测 HTTP 传输与 principal 绑定。
"""

from __future__ import annotations

import json

import src.api.auth as auth_mod
from src.security.api_keys import DRAFTER_SCOPES, HANDOFF_SCOPES, READ_ONLY_SCOPES
from tests.api.conftest import EMAIL_ID


def _bearer(store, scopes):
    rec, plaintext = store.create_key("notion", scopes=list(scopes))
    return {"Authorization": f"Bearer {plaintext}"}, rec


def _rpc(method, params=None, req_id=1):
    msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def _tool_names(resp):
    return {t["name"] for t in resp.json()["result"]["tools"]}


def test_initialize_negotiates_version(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)

    r = skill_client.post(
        "/mcp", json=_rpc("initialize", {"protocolVersion": "2025-03-26"}), headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/json")
    assert "mcp-session-id" not in r.headers
    result = r.json()["result"]
    assert result["protocolVersion"] == "2025-03-26"
    assert result["serverInfo"]["name"] == "mailagent"

    r2 = skill_client.post(
        "/mcp", json=_rpc("initialize", {"protocolVersion": "2099-01-01"}), headers=headers
    )
    assert r2.json()["result"]["protocolVersion"] == "2025-06-18"


def test_tools_list_filtered_by_key_scope(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    ro_headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    ro = _tool_names(skill_client.post("/mcp", json=_rpc("tools/list"), headers=ro_headers))
    assert "mailagent_email_search" in ro
    assert "mailagent_email_draft" not in ro
    assert "mailagent_report_run" not in ro

    dr_headers, _ = _bearer(api_key_store, DRAFTER_SCOPES)
    dr = _tool_names(skill_client.post("/mcp", json=_rpc("tools/list"), headers=dr_headers))
    assert "mailagent_email_draft" in dr
    # mcp_exposed=False 的发信工具对任何 key 都不投影
    assert "mailagent_email_send" not in dr


def test_tools_call_success_and_audit(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, rec = _bearer(api_key_store, READ_ONLY_SCOPES)
    r = skill_client.post(
        "/mcp",
        json=_rpc(
            "tools/call",
            {"name": "mailagent_email_search", "arguments": {"q": "redis"}},
        ),
        headers=headers,
    )
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    assert not result.get("isError"), result
    data = json.loads(result["content"][0]["text"])
    assert EMAIL_ID in [it["internal_id"] for it in data["items"]]

    rows = api_key_store.list_audit(key_id=rec.id)
    assert len(rows) == 1
    assert rows[0]["route"] == "/mcp"
    assert rows[0]["status"] == "ok"
    assert rows[0]["skill"] == "search" and rows[0]["tool"] == "email_search"


def test_out_of_scope_tool_is_not_callable(skill_client, api_key_store, monkeypatch):
    """readonly key 调 email_draft：工具对它不可见 → unknown tool，invoke 永不被调。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, rec = _bearer(api_key_store, READ_ONLY_SCOPES)
    r = skill_client.post(
        "/mcp",
        json=_rpc(
            "tools/call",
            {"name": "mailagent_email_draft", "arguments": {"mode": "new", "confirm": True}},
        ),
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["error"]["code"] == -32602
    assert api_key_store.list_audit(key_id=rec.id) == []


def test_invoke_gate_denial_surfaces_as_iserror(skill_client, api_key_store, monkeypatch):
    """drafter key 不带 confirm 调 email_draft → confirm 闸拒 → isError 文本 + 审计 error 行。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, rec = _bearer(api_key_store, DRAFTER_SCOPES)
    r = skill_client.post(
        "/mcp",
        json=_rpc("tools/call", {"name": "mailagent_email_draft", "arguments": {"mode": "new"}}),
        headers=headers,
    )
    assert r.status_code == 200
    result = r.json()["result"]
    assert result["isError"] is True
    assert result["content"][0]["text"].startswith("[E_AUTH_FAILED]")

    rows = api_key_store.list_audit(key_id=rec.id)
    assert len(rows) == 1
    assert rows[0]["route"] == "/mcp"
    assert rows[0]["status"] == "error" and rows[0]["error_code"] == "E_AUTH_FAILED"


def test_no_credentials_401(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = skill_client.post("/mcp", json=_rpc("tools/list"))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_bad_or_revoked_key_403(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = skill_client.post(
        "/mcp", json=_rpc("tools/list"), headers={"Authorization": "Bearer mak_bogus"}
    )
    assert r.status_code == 403

    headers, rec = _bearer(api_key_store, READ_ONLY_SCOPES)
    api_key_store.revoke(rec.id)
    assert skill_client.post("/mcp", json=_rpc("tools/list"), headers=headers).status_code == 403


def test_notification_only_returns_202(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    r = skill_client.post(
        "/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=headers
    )
    assert r.status_code == 202
    assert r.content == b""


def test_batch_returns_only_request_responses(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    r = skill_client.post(
        "/mcp",
        json=[
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            _rpc("tools/list", req_id=7),
        ],
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list) and len(body) == 1
    assert body[0]["id"] == 7 and "tools" in body[0]["result"]


def test_get_and_delete_405(skill_client):
    for method in ("GET", "DELETE"):
        r = skill_client.request(method, "/mcp")
        assert r.status_code == 405
        assert r.headers["allow"] == "POST"


def test_invalid_json_parse_error(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    r = skill_client.post(
        "/mcp", content=b"{not json", headers={**headers, "Content-Type": "application/json"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["id"] is None and body["error"]["code"] == -32700


# ── 10-26 四块对外工具：readonly 看得到 11 个读工具、看不到 run_now；handoff 看得到并能调 ──

_NEW_READ_TOOLS = {
    "mailagent_contact_search",
    "mailagent_contact_get",
    "mailagent_contact_list_mails",
    "mailagent_library_list",
    "mailagent_library_search",
    "mailagent_library_read",
    "mailagent_matter_find",
    "mailagent_matter_get",
    "mailagent_matter_attention_list",
    "mailagent_custom_agent_list",
    "mailagent_custom_agent_get",
}
_RUN_NOW = "mailagent_custom_agent_run_now"


def test_new_domain_tools_visibility_by_preset(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    ro_headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    ro = _tool_names(skill_client.post("/mcp", json=_rpc("tools/list"), headers=ro_headers))
    assert _NEW_READ_TOOLS <= ro
    assert _RUN_NOW not in ro

    ho_headers, _ = _bearer(api_key_store, HANDOFF_SCOPES)
    ho = _tool_names(skill_client.post("/mcp", json=_rpc("tools/list"), headers=ho_headers))
    assert _NEW_READ_TOOLS | {_RUN_NOW} <= ho


def test_run_now_over_mcp_refuses_disabled_agent(
    skill_client, api_key_store, skill_report_db, monkeypatch
):
    from types import SimpleNamespace

    from src.api.app import app
    from src.api.deps import get_settings
    from src.reports.store import ReportStore
    from src.sync.async_jobs import AsyncJobRepository

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    ReportStore(db_path=skill_report_db).create_agent("sleeper", type="custom", enabled=False)
    cfg = SimpleNamespace(sync_store_db_path=skill_report_db, custom_agents_enabled=True)
    monkeypatch.setitem(app.dependency_overrides, get_settings, lambda: cfg)

    ro_headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    call = _rpc("tools/call", {"name": _RUN_NOW, "arguments": {"agent_id": "sleeper", "confirm": True}})
    assert skill_client.post("/mcp", json=call, headers=ro_headers).json()["error"]["code"] == -32602

    headers, rec = _bearer(api_key_store, HANDOFF_SCOPES)
    result = skill_client.post("/mcp", json=call, headers=headers).json()["result"]
    assert result["isError"] is True
    assert result["content"][0]["text"].startswith("[E_CONFLICT]")
    assert AsyncJobRepository(db_path=skill_report_db).list_agent_runs(agent_id="sleeper") == []
    assert api_key_store.list_audit(key_id=rec.id)[0]["error_code"] == "E_CONFLICT"


def test_new_read_tool_over_rest_invoke(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "matter_lookup", "tool": "matter_find", "input": {"limit": 5}},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"count": 0, "items": []}

    r = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "matter_lookup", "tool": "matter_find", "input": {"limit": 500}},
        headers=headers,
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "E_INVALID_ARG"
