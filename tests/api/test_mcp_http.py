"""MCP HTTP/SSE endpoints (`/mcp`, `/mcp/sse`, `/mcp/messages`).

鉴权与 /api/skills 同一个 authenticate_principal；bearer 腿要求 AUTH_DISABLED=False。
JSON-RPC 分派复用 mailagent_mcp.handle_request，测试覆盖无状态向后兼容、有状态
Streamable HTTP (`Mcp-Session-Id` + `GET`/`DELETE /mcp`)、Legacy HTTP+SSE
(`/mcp/sse` + `/mcp/messages`) 以及跨 key / 吊销 key / TTL / 队列保护。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest

import src.api.auth as auth_mod
from src.api.agent_auth import Principal
from src.api.app import app
from src.mcp.http_sessions import (
    TRANSPORT_LEGACY_SSE,
    TRANSPORT_STREAMABLE_HTTP,
    McpSessionManager,
    get_mcp_session_manager,
    reset_mcp_session_manager,
)
from src.security.api_keys import DRAFTER_SCOPES, HANDOFF_SCOPES, READ_ONLY_SCOPES
from tests.api.conftest import EMAIL_ID


@pytest.fixture(autouse=True)
def _reset_sessions():
    reset_mcp_session_manager(app)
    yield
    reset_mcp_session_manager(app)


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
    sid = r.headers.get("mcp-session-id")
    assert sid and len(sid) >= 24
    result = r.json()["result"]
    assert result["protocolVersion"] == "2025-03-26"
    assert result["serverInfo"]["name"] == "mailagent"

    r2 = skill_client.post(
        "/mcp", json=_rpc("initialize", {"protocolVersion": "2099-01-01"}), headers=headers
    )
    assert r2.json()["result"]["protocolVersion"] == "2025-06-18"
    assert r2.headers.get("mcp-session-id")


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
    # 发信要 email:write，起草 key 看不到
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


def test_get_and_delete_require_session_header(skill_client):
    """Stateful Streamable HTTP GET / DELETE require Mcp-Session-Id (400 when missing)."""
    for method in ("GET", "DELETE"):
        r = skill_client.request(method, "/mcp")
        assert r.status_code == 400


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


# ── WS-1B: Stateful Streamable HTTP (/mcp) & Legacy HTTP+SSE (/mcp/sse) ─────


def _parse_sse_events(lines: list[str]) -> list[tuple[str, str]]:
    events: list[tuple[str, str]] = []
    cur_event = ""
    cur_data: list[str] = []
    for line in lines:
        if line == "":
            if cur_event or cur_data:
                events.append((cur_event, "\n".join(cur_data)))
                cur_event = ""
                cur_data = []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            cur_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            cur_data.append(line[len("data:") :].strip())
    if cur_event or cur_data:
        events.append((cur_event, "\n".join(cur_data)))
    return events


def test_streamable_http_stateful_post_accept_sse_and_delete(
    skill_client, api_key_store, monkeypatch
):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)

    # 1. initialize with Accept: text/event-stream returns single-response SSE + Mcp-Session-Id.
    init_resp = skill_client.post(
        "/mcp",
        json=_rpc("initialize", {"protocolVersion": "2025-06-18"}),
        headers={**headers, "Accept": "text/event-stream"},
    )
    assert init_resp.status_code == 200, init_resp.text
    assert init_resp.headers["content-type"].startswith("text/event-stream")
    sid = init_resp.headers["mcp-session-id"]
    init_events = _parse_sse_events(init_resp.text.splitlines())
    assert len(init_events) == 1 and init_events[0][0] == "message"
    assert json.loads(init_events[0][1])["result"]["protocolVersion"] == "2025-06-18"

    # 2. notifications/initialized with Mcp-Session-Id -> 202 empty.
    notif_resp = skill_client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers={**headers, "Mcp-Session-Id": sid},
    )
    assert notif_resp.status_code == 202 and notif_resp.content == b""

    # 3. tools/list with Accept: application/json, text/event-stream -> JSON (prefers application/json).
    list_json = skill_client.post(
        "/mcp",
        json=_rpc("tools/list", req_id=2),
        headers={**headers, "Mcp-Session-Id": sid, "Accept": "application/json, text/event-stream"},
    )
    assert list_json.status_code == 200
    assert list_json.headers["content-type"].startswith("application/json")
    assert any(t["name"] == "mailagent_email_search" for t in list_json.json()["result"]["tools"])

    # 4. tools/call with Accept: text/event-stream -> single-response SSE framing.
    call_sse = skill_client.post(
        "/mcp",
        json=_rpc(
            "tools/call",
            {"name": "mailagent_email_search", "arguments": {"q": "redis"}},
            req_id=3,
        ),
        headers={**headers, "Mcp-Session-Id": sid, "Accept": "text/event-stream"},
    )
    assert call_sse.status_code == 200
    assert call_sse.headers["content-type"].startswith("text/event-stream")
    call_events = _parse_sse_events(call_sse.text.splitlines())
    assert len(call_events) == 1 and call_events[0][0] == "message"
    call_payload = json.loads(call_events[0][1])["result"]
    assert EMAIL_ID in [it["internal_id"] for it in json.loads(call_payload["content"][0]["text"])["items"]]

    # 5. DELETE /mcp terminates session -> 204, subsequent requests return 404.
    del_resp = skill_client.delete("/mcp", headers={**headers, "Mcp-Session-Id": sid})
    assert del_resp.status_code == 204
    assert (
        skill_client.post(
            "/mcp",
            json=_rpc("ping", req_id=4),
            headers={**headers, "Mcp-Session-Id": sid},
        ).status_code
        == 404
    )
    assert skill_client.get("/mcp", headers={**headers, "Mcp-Session-Id": sid}).status_code == 404
    assert skill_client.delete("/mcp", headers={**headers, "Mcp-Session-Id": sid}).status_code == 404


def test_streamable_http_get_stream_receives_messages_keepalive_and_closes_on_delete(
    skill_client, api_key_store, monkeypatch
):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    mgr = reset_mcp_session_manager(app, manager=McpSessionManager(keepalive_interval_seconds=0.05))
    headers, rec = _bearer(api_key_store, READ_ONLY_SCOPES)

    # Unauthenticated GET/DELETE fail with 401 when stateful=True.
    assert skill_client.get("/mcp").status_code == 401
    assert skill_client.delete("/mcp").status_code == 401

    init_resp = skill_client.post("/mcp", json=_rpc("initialize"), headers=headers)
    sid = init_resp.headers["mcp-session-id"]
    session = mgr.get_owned(
        sid, Principal(kind="agent", auth_method="bearer", key_id=rec.id), touch=False
    )
    assert session is not None

    def _drive_stream() -> None:
        time.sleep(0.12)  # allow at least one ': keepalive\n\n' frame
        assert session.loop is not None
        session.loop.call_soon_threadsafe(
            session.queue.put_nowait,
            {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"},
        )
        time.sleep(0.05)
        skill_client.delete("/mcp", headers={**headers, "Mcp-Session-Id": sid})

    driver = threading.Thread(target=_drive_stream)
    driver.start()
    with skill_client.stream("GET", "/mcp", headers={**headers, "Mcp-Session-Id": sid}) as stream:
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        assert stream.headers["cache-control"] == "no-cache"
        assert stream.headers["x-accel-buffering"] == "no"
        raw_text = stream.read().decode("utf-8")
    driver.join()

    assert ": keepalive" in raw_text
    events = _parse_sse_events(raw_text.splitlines())
    assert any(
        ev == "message" and json.loads(data)["method"] == "notifications/tools/list_changed"
        for ev, data in events
    )


def test_cross_principal_and_revoked_key_session_isolation(
    skill_client, api_key_store, monkeypatch
):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers_a, rec_a = _bearer(api_key_store, READ_ONLY_SCOPES)
    headers_b, _rec_b = _bearer(api_key_store, READ_ONLY_SCOPES)

    # Key A creates a streamable_http session.
    sid_a = skill_client.post("/mcp", json=_rpc("initialize"), headers=headers_a).headers[
        "mcp-session-id"
    ]

    # Key B cannot touch Key A's session on any verb — uniform 404 (matches unknown ID).
    unknown = "nonexistent-session-id"
    for candidate in (sid_a, unknown):
        r_post = skill_client.post(
            "/mcp",
            json=_rpc("tools/list"),
            headers={**headers_b, "Mcp-Session-Id": candidate},
        )
        r_get = skill_client.get("/mcp", headers={**headers_b, "Mcp-Session-Id": candidate})
        r_del = skill_client.delete("/mcp", headers={**headers_b, "Mcp-Session-Id": candidate})
        assert r_post.status_code == 404
        assert r_get.status_code == 404
        assert r_del.status_code == 404

    # Cross-transport isolation: streamable_http session rejected on /mcp/messages with 404.
    assert (
        skill_client.post(
            f"/mcp/messages?session_id={sid_a}",
            json=_rpc("ping"),
            headers=headers_a,
        ).status_code
        == 404
    )

    # Revoking Key A immediately fails closed with 403 on all endpoints.
    api_key_store.revoke(rec_a.id)
    assert (
        skill_client.post(
            "/mcp", json=_rpc("tools/list"), headers={**headers_a, "Mcp-Session-Id": sid_a}
        ).status_code
        == 403
    )
    assert (
        skill_client.get("/mcp", headers={**headers_a, "Mcp-Session-Id": sid_a}).status_code == 403
    )
    assert (
        skill_client.delete("/mcp", headers={**headers_a, "Mcp-Session-Id": sid_a}).status_code
        == 403
    )
    assert skill_client.get("/mcp/sse", headers=headers_a).status_code == 403
    assert (
        skill_client.post(
            f"/mcp/messages?session_id={sid_a}", json=_rpc("ping"), headers=headers_a
        ).status_code
        == 403
    )


def test_human_vs_agent_session_isolation(skill_client, api_key_store, monkeypatch):
    # Human owner (dev mode) creates a session; Bearer agent cannot reuse it.
    sid_human = skill_client.post("/mcp", json=_rpc("initialize")).headers["mcp-session-id"]

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    agent_headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    assert (
        skill_client.post(
            "/mcp",
            json=_rpc("ping"),
            headers={**agent_headers, "Mcp-Session-Id": sid_human},
        ).status_code
        == 404
    )


def test_session_manager_ttl_eviction_and_queue_bounds():
    now = 100.0
    mgr = McpSessionManager(
        max_sessions_per_principal=8,
        idle_ttl_seconds=10.0,
        queue_max_size=2,
        now_fn=lambda: now,
    )
    p1 = Principal(kind="agent", auth_method="bearer", key_id="k1")
    p2 = Principal(kind="agent", auth_method="bearer", key_id="k2")

    sessions = []
    for i in range(8):
        now = 100.0 + i
        sessions.append(mgr.create_session(p1, transport_kind=TRANSPORT_STREAMABLE_HTTP))

    # Touch s0 so s1 is the oldest idle session.
    now = 108.5
    assert mgr.get_owned(sessions[0].session_id, p1) is not None

    # Creating a 9th session for p1 evicts s1 (oldest idle) and sends None sentinel.
    s9 = mgr.create_session(p1, transport_kind=TRANSPORT_STREAMABLE_HTTP)
    assert mgr.count_for_principal(p1) == 8
    assert mgr.get_owned(sessions[1].session_id, p1) is None
    assert sessions[1].closed is True
    assert sessions[1].queue.get_nowait() is None
    assert mgr.get_owned(sessions[0].session_id, p1) is not None
    assert mgr.get_owned(s9.session_id, p1) is not None

    # p2 has an independent quota of 8.
    p2_sess = mgr.create_session(p2, transport_kind=TRANSPORT_LEGACY_SSE)
    assert mgr.count_for_principal(p2) == 1
    assert mgr.get_owned(p2_sess.session_id, p1) is None

    # Queue overflow + signal_close on full queue still lands None sentinel cleanly.
    mgr.enqueue(s9, {"id": 1})
    mgr.enqueue(s9, {"id": 2})
    with pytest.raises(asyncio.QueueFull):
        mgr.enqueue(s9, {"id": 3})
    assert mgr.delete_owned(s9.session_id, p1) is True
    assert s9.closed is True

    # Lazy TTL cleanup expires untouched sessions after idle_ttl_seconds.
    now = 200.0
    assert mgr.get_owned(sessions[0].session_id, p1) is None
    assert mgr.get_owned(p2_sess.session_id, p2) is None
    assert mgr.active_count == 0


def test_legacy_sse_handshake_tool_call_audit_and_cross_key_rejection(
    skill_client, api_key_store, monkeypatch
):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert skill_client.get("/mcp/sse").status_code == 401
    assert skill_client.post("/mcp/messages?session_id=abc", json=_rpc("ping")).status_code == 401

    mgr = get_mcp_session_manager(app)
    headers_a, rec_a = _bearer(api_key_store, DRAFTER_SCOPES)
    headers_b, _rec_b = _bearer(api_key_store, DRAFTER_SCOPES)

    # Restrict email_search on key A via disabled_tools to verify PrincipalSkillClient policy inheritance.
    api_key_store.update_key_policy(rec_a.id, disabled_tools=["email_search"])

    captured: dict[str, str] = {}
    ready = threading.Event()

    def _driver() -> None:
        # Poll until legacy_sse session appears, then exercise /mcp/messages.
        deadline = time.monotonic() + 3.0
        sid = ""
        while time.monotonic() < deadline:
            sessions = list(mgr._sessions.values())  # noqa: SLF001
            if sessions:
                sid = sessions[0].session_id
                break
            time.sleep(0.01)
        assert sid, "legacy_sse session was not created"
        captured["sid"] = sid
        ready.set()

        # Cross-key POST to /mcp/messages must fail closed with 404.
        cross = skill_client.post(
            f"/mcp/messages?session_id={sid}",
            json=_rpc("ping", req_id=99),
            headers=headers_b,
        )
        assert cross.status_code == 404

        # Streamable HTTP endpoints reject legacy_sse session_id with 404.
        assert (
            skill_client.post(
                "/mcp", json=_rpc("ping"), headers={**headers_a, "Mcp-Session-Id": sid}
            ).status_code
            == 404
        )

        # Initialize -> 202 accepted, response pushed to SSE.
        r1 = skill_client.post(
            f"/mcp/messages?session_id={sid}",
            json=_rpc("initialize", {"protocolVersion": "2024-11-05"}, req_id=1),
            headers=headers_a,
        )
        assert r1.status_code == 202 and r1.json() == {"status": "accepted"}

        # tools/list -> 202 accepted, disabled tool is omitted.
        r2 = skill_client.post(
            f"/mcp/messages?session_id={sid}",
            json=_rpc("tools/list", req_id=2),
            headers=headers_a,
        )
        assert r2.status_code == 202

        # tools/call email_draft without strict boolean confirm=true -> isError + audit.
        r3 = skill_client.post(
            f"/mcp/messages?session_id={sid}",
            json=_rpc(
                "tools/call",
                {"name": "mailagent_email_draft", "arguments": {"mode": "new", "confirm": "true"}},
                req_id=3,
            ),
            headers=headers_a,
        )
        assert r3.status_code == 202

        # Close SSE stream gracefully after responses are queued.
        time.sleep(0.05)
        mgr.close_session_by_id(sid)

    t = threading.Thread(target=_driver)
    t.start()
    with skill_client.stream("GET", "/mcp/sse", headers=headers_a) as sse:
        assert sse.status_code == 200
        assert sse.headers["content-type"].startswith("text/event-stream")
        body = sse.read().decode("utf-8")
    t.join()

    events = _parse_sse_events(body.splitlines())
    assert events[0][0] == "endpoint"
    assert events[0][1] == f"/mcp/messages?session_id={captured['sid']}"

    by_id = {
        json.loads(data)["id"]: json.loads(data)
        for ev, data in events
        if ev == "message"
    }
    assert by_id[1]["result"]["protocolVersion"] == "2024-11-05"
    tool_names = {t["name"] for t in by_id[2]["result"]["tools"]}
    assert "mailagent_email_draft" in tool_names
    assert "mailagent_email_search" not in tool_names  # disabled_tools respected
    assert by_id[3]["result"]["isError"] is True
    assert by_id[3]["result"]["content"][0]["text"].startswith("[E_AUTH_FAILED]")

    audit_rows = [r for r in api_key_store.list_audit(key_id=rec_a.id) if r["route"] == "/mcp/messages"]
    assert len(audit_rows) == 1
    assert audit_rows[0]["skill"] == "email" and audit_rows[0]["tool"] == "email_draft"
    assert audit_rows[0]["error_code"] == "E_AUTH_FAILED"


@pytest.mark.parametrize(
    "raw_prefix, expected_prefix",
    [
        (None, ""),
        ("/", ""),
        ("/proxy/v1", "/proxy/v1"),
        ("/proxy/v1/", "/proxy/v1"),
        ("https://evil.com/mcp", ""),
        ("//evil.com/mcp", ""),
        ("/ok\r\nevent: fake\ndata: bad", ""),
        ("/ok\nevent: fake", ""),
        ("/ok/../secret", ""),
        ("/ok?next=https://evil.com", ""),
        ("/ok#frag", ""),
    ],
)
def test_legacy_sse_x_forwarded_prefix_sanitization(
    skill_client, api_key_store, monkeypatch, raw_prefix, expected_prefix
):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    mgr = get_mcp_session_manager(app)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    if raw_prefix is not None and "\r" not in raw_prefix and "\n" not in raw_prefix:
        headers["X-Forwarded-Prefix"] = raw_prefix
    elif raw_prefix is not None:
        # Test normalization helper directly for raw CRLF inputs that httpx rejects on client send.
        from src.api.routers.skills import _normalize_path_prefix

        assert _normalize_path_prefix(raw_prefix) == expected_prefix
        return

    def _close_first() -> None:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if mgr._sessions:  # noqa: SLF001
                sid = next(iter(mgr._sessions))  # noqa: SLF001
                mgr.close_session_by_id(sid)
                return
            time.sleep(0.01)

    t = threading.Thread(target=_close_first)
    t.start()
    with skill_client.stream("GET", "/mcp/sse", headers=headers) as sse:
        assert sse.status_code == 200
        body = sse.read().decode("utf-8")
    t.join()

    events = _parse_sse_events(body.splitlines())
    assert events[0][0] == "endpoint"
    assert events[0][1].startswith(f"{expected_prefix}/mcp/messages?session_id=")
    assert "\r" not in events[0][1] and "evil.com" not in events[0][1]


def test_legacy_sse_messages_returns_429_when_queue_full(skill_client, api_key_store, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    mgr = reset_mcp_session_manager(app, manager=McpSessionManager(queue_max_size=1))
    headers, rec = _bearer(api_key_store, READ_ONLY_SCOPES)
    principal = Principal(kind="agent", auth_method="bearer", key_id=rec.id)
    session = mgr.create_session(principal, transport_kind=TRANSPORT_LEGACY_SSE)

    r1 = skill_client.post(
        f"/mcp/messages?session_id={session.session_id}",
        json=_rpc("ping", req_id=1),
        headers=headers,
    )
    assert r1.status_code == 202

    r2 = skill_client.post(
        f"/mcp/messages?session_id={session.session_id}",
        json=_rpc("ping", req_id=2),
        headers=headers,
    )
    assert r2.status_code == 429


def test_real_mcp_sdk_clients_over_sse_and_streamable_http(
    skill_client, api_key_store, monkeypatch
):
    """End-to-end interoperability check using official mcp Python SDK clients over ASGI."""
    import anyio
    import httpx2
    from mcp import Client
    from mcp.client.sse import sse_client
    from mcp.client.streamable_http import streamable_http_client

    class _StreamingASGITransport(httpx2.AsyncBaseTransport):
        def __init__(self, asgi_app):
            self.app = asgi_app

        async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
            body = await request.aread()
            req_sent = False
            disconnect_ev = anyio.Event()

            async def receive():
                nonlocal req_sent
                if not req_sent:
                    req_sent = True
                    return {"type": "http.request", "body": body, "more_body": False}
                await disconnect_ev.wait()
                return {"type": "http.disconnect"}

            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": request.method,
                "headers": [(k.lower(), v) for k, v in request.headers.raw],
                "scheme": request.url.scheme,
                "path": request.url.path,
                "raw_path": request.url.raw_path.split(b"?")[0],
                "query_string": request.url.query,
                "server": (request.url.host, request.url.port or 80),
                "client": ("127.0.0.1", 0),
            }
            start_ev = anyio.Event()
            status = 500
            resp_headers: list[tuple[bytes, bytes]] = []
            send_ch, recv_ch = anyio.create_memory_object_stream(64)

            async def send(msg):
                nonlocal status, resp_headers
                if msg["type"] == "http.response.start":
                    status = msg["status"]
                    resp_headers = msg.get("headers", [])
                    start_ev.set()
                elif msg["type"] == "http.response.body":
                    chunk = msg.get("body", b"")
                    if chunk:
                        await send_ch.send(chunk)
                    if not msg.get("more_body", False):
                        await send_ch.aclose()

            tg = anyio.create_task_group()
            await tg.__aenter__()
            tg.start_soon(self.app, scope, receive, send)
            await start_ev.wait()

            class _BodyStream(httpx2.AsyncByteStream):
                async def __aiter__(self):
                    async with recv_ch:
                        async for chunk in recv_ch:
                            yield chunk

                async def aclose(self):
                    disconnect_ev.set()
                    await recv_ch.aclose()
                    tg.cancel_scope.cancel()
                    await tg.__aexit__(None, None, None)

            return httpx2.Response(status_code=status, headers=resp_headers, stream=_BodyStream())

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    headers, _ = _bearer(api_key_store, READ_ONLY_SCOPES)
    asgi_transport = _StreamingASGITransport(app)

    async def _exercise() -> None:
        # 1. Legacy HTTP+SSE client against /mcp/sse + /mcp/messages
        def _sse_factory(**kwargs):
            kwargs.pop("follow_redirects", None)
            return httpx2.AsyncClient(transport=asgi_transport, **kwargs)

        async with Client(
            sse_client("http://testserver/mcp/sse", headers=headers, httpx_client_factory=_sse_factory)
        ) as client:
            listed = await client.list_tools()
            assert any(t.name == "mailagent_email_search" for t in listed.tools)
            called = await client.call_tool("mailagent_email_search", {"q": "redis"})
            assert not called.is_error
            payload = json.loads(called.content[0].text)
            assert EMAIL_ID in [it["internal_id"] for it in payload["items"]]

        # 2. Streamable HTTP client against /mcp
        async with httpx2.AsyncClient(transport=asgi_transport, headers=headers) as http_client:
            async with Client(
                streamable_http_client("http://testserver/mcp", http_client=http_client)
            ) as client:
                listed = await client.list_tools()
                assert any(t.name == "mailagent_email_search" for t in listed.tools)
                called = await client.call_tool("mailagent_email_search", {"q": "redis"})
                assert not called.is_error
                payload = json.loads(called.content[0].text)
                assert EMAIL_ID in [it["internal_id"] for it in payload["items"]]

    asyncio.run(_exercise())
