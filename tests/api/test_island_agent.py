"""serve-api harness agent 上岛端点（Part B）.

覆盖：
- ``POST /api/island/agent/announce`` kind=approval → 登记 agent ack pending（kind="agent"，
  metadata 带 resume 字段）+ 发 AgentApproval envelope。
- island_agent_enabled=False → 静默 no-op（字节级 flag-off）。
- ``POST /api/island/ack`` kind=agent → resolve pending → 后台 POST gateway /decide（mock）→
  追发 AgentCompleted/AgentError 清卡。
- 生命周期 announce（running/completed）。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Iterator, List, Tuple

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_settings
from src.notify import island_ack, island_agent, ping_island
from src.notify.ping_island import SendResult


def _make_client(tmp_path: Path, monkeypatch, *, agent_enabled: bool = True):
    db = str(tmp_path / "sync_store.db")

    class _Cfg:
        sync_store_db_path = db
        island_agent_enabled = agent_enabled
        ping_island_enabled = True
        island_socket_path = "/tmp/nonexistent-island-test.sock"
        island_accent = "coral"
        island_theme = "dark"

    app.dependency_overrides[get_settings] = lambda: _Cfg()

    sent: List[object] = []

    async def fake_send(env, *, sock_path=None, timeout=None):
        sent.append(env)
        return SendResult(ok=True, response=None)

    monkeypatch.setattr(ping_island, "send_async", fake_send)
    client = TestClient(app, raise_server_exceptions=False)
    return client, db, sent


@pytest.fixture()
def agent_client(tmp_path: Path, monkeypatch) -> Iterator[Tuple[TestClient, str, list]]:
    client, db, sent = _make_client(tmp_path, monkeypatch, agent_enabled=True)
    with client:
        yield client, db, sent
    app.dependency_overrides.pop(get_settings, None)


def test_announce_approval_registers_pending(agent_client):
    client, db, sent = agent_client
    r = client.post("/api/island/agent/announce", json={
        "kind": "approval", "sessionId": 42, "toolName": "email_draft_reply",
        "inputPreview": "回复 Alice: 好的，明天见", "risk": "edit",
        "toolCallId": "call_1", "resumeToken": "rt_1", "gatewayPort": 8300,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["kind"] == "approval"
    ack = body["ackToken"]
    assert ack

    # pending 可 resolve（kind=agent，metadata 带 resume 字段）
    pending = island_ack.resolve(db, ack, "approve")
    assert pending is not None
    assert pending.kind == "agent"
    assert pending.metadata["mailagent.agentToolCallId"] == "call_1"
    assert pending.metadata["mailagent.agentResumeToken"] == "rt_1"
    assert pending.metadata["mailagent.agentGatewayPort"] == "8300"
    assert pending.metadata["mailagent.agentSessionId"] == "42"

    # 发了一条 AgentApproval envelope
    assert len(sent) == 1
    d = sent[0].to_wire_dict()
    assert d["metadata"]["mailagent.scenario"] == "AgentApproval"
    assert d["sessionKey"] == "mailagent:agent:42"
    assert [o["id"] for o in d["intervention"]["options"]] == ["approve", "reject"]
    assert d["metadata"]["ack_token"] == ack


def test_announce_disabled_noop(tmp_path, monkeypatch):
    client, db, sent = _make_client(tmp_path, monkeypatch, agent_enabled=False)
    with client:
        r = client.post("/api/island/agent/announce", json={
            "kind": "approval", "sessionId": 1, "toolName": "email_flag",
            "toolCallId": "c", "resumeToken": "r", "gatewayPort": 8300,
        })
    app.dependency_overrides.pop(get_settings, None)
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    assert sent == []  # 未发任何 envelope


def test_announce_approval_missing_fields_422(agent_client):
    client, _db, _sent = agent_client
    # 缺 gatewayPort / resumeToken → 422
    r = client.post("/api/island/agent/announce", json={
        "kind": "approval", "sessionId": 1, "toolName": "email_flag", "toolCallId": "c",
    })
    assert r.status_code == 422


def test_announce_status_completed(agent_client):
    client, _db, sent = agent_client
    r = client.post("/api/island/agent/announce", json={
        "kind": "completed", "sessionId": 42, "summary": "已执行 email_draft_reply",
    })
    assert r.status_code == 200 and r.json()["ok"] is True
    assert len(sent) == 1
    d = sent[0].to_wire_dict()
    assert d["metadata"]["mailagent.scenario"] == "AgentCompleted"
    assert d["status"]["kind"] == "completed"


def test_ack_agent_routes_to_gateway_decide(agent_client, monkeypatch):
    client, db, _sent = agent_client
    token = island_ack.register(
        db, kind="agent", session_key="mailagent:agent:42",
        event_type="AgentApproval",
        metadata={
            "mailagent.agentToolCallId": "call_1",
            "mailagent.agentResumeToken": "rt_1",
            "mailagent.agentGatewayPort": "8300",
            "mailagent.agentSessionId": "42",
        },
        choices={"approve", "reject"}, internal_id=None,
    )
    calls = []

    async def fake_decide(port, tcid, decision, rt):
        calls.append((port, tcid, decision, rt))
        return {"ok": True, "status": "completed", "summary": "email_draft_reply executed"}

    monkeypatch.setattr("src.api.routers.island._post_gateway_decide", fake_decide)

    statuses = []

    async def fake_status(**kw):
        statuses.append(kw)

    monkeypatch.setattr(island_agent, "announce_status", fake_status)

    r = client.post("/api/island/ack", json={"ack_token": token, "choice": "approve"})
    assert r.status_code == 200 and r.json()["kind"] == "agent"

    for _ in range(100):
        if calls and statuses:
            break
        time.sleep(0.02)
    assert calls == [(8300, "call_1", "approve", "rt_1")]
    assert statuses and statuses[0]["status_kind"] == "completed"


def test_ack_agent_reject_maps_decision(agent_client, monkeypatch):
    client, db, _sent = agent_client
    token = island_ack.register(
        db, kind="agent", session_key="mailagent:agent:7",
        event_type="AgentApproval",
        metadata={
            "mailagent.agentToolCallId": "call_x",
            "mailagent.agentResumeToken": "rt_x",
            "mailagent.agentGatewayPort": "8300",
            "mailagent.agentSessionId": "7",
        },
        choices={"approve", "reject"}, internal_id=None,
    )
    calls = []

    async def fake_decide(port, tcid, decision, rt):
        calls.append(decision)
        return {"ok": True, "status": "rejected", "summary": ""}

    monkeypatch.setattr("src.api.routers.island._post_gateway_decide", fake_decide)
    monkeypatch.setattr(island_agent, "announce_status", _noop_async)

    r = client.post("/api/island/ack", json={"ack_token": token, "choice": "reject"})
    assert r.status_code == 200
    for _ in range(100):
        if calls:
            break
        time.sleep(0.02)
    assert calls == ["reject"]


def test_ack_agent_gateway_error_sends_error_card(agent_client, monkeypatch):
    client, db, _sent = agent_client
    token = island_ack.register(
        db, kind="agent", session_key="mailagent:agent:9",
        event_type="AgentApproval",
        metadata={
            "mailagent.agentToolCallId": "call_e",
            "mailagent.agentResumeToken": "rt_e",
            "mailagent.agentGatewayPort": "8300",
            "mailagent.agentSessionId": "9",
        },
        choices={"approve", "reject"}, internal_id=None,
    )

    async def fake_decide(port, tcid, decision, rt):
        raise RuntimeError("gateway unreachable")

    monkeypatch.setattr("src.api.routers.island._post_gateway_decide", fake_decide)
    statuses = []

    async def fake_status(**kw):
        statuses.append(kw)

    monkeypatch.setattr(island_agent, "announce_status", fake_status)

    r = client.post("/api/island/ack", json={"ack_token": token, "choice": "approve"})
    assert r.status_code == 200
    for _ in range(100):
        if statuses:
            break
        time.sleep(0.02)
    assert statuses and statuses[0]["status_kind"] == "error"


async def _noop_async(**kw):
    return None
