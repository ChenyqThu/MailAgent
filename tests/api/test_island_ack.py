"""serve-api ``POST /api/island/ack`` 端点（契约 §6/§9-4）.

验证解耦 ack 通道：ping-island 按钮点击 → POST {ack_token, choice} → resolve pending →
路由 island_response.handle_response（合成 BridgeResponse shape + 存储 metadata）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, Tuple

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_settings
from src.notify import island_ack


@pytest.fixture()
def ack_client(tmp_path: Path) -> Iterator[Tuple[TestClient, str]]:
    db = str(tmp_path / "sync_store.db")

    class _Cfg:
        sync_store_db_path = db

    app.dependency_overrides[get_settings] = lambda: _Cfg()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c, db
    app.dependency_overrides.pop(get_settings, None)


def test_ack_routes_mail_choice_to_handle_response(ack_client, monkeypatch):
    client, db = ack_client
    token = island_ack.register(
        db, kind="mail", session_key="mailagent:email:53675",
        event_type="LLMReviewedUrgent",
        metadata={"mailagent.internalId": "53675"},
        choices={"mark_done", "skip"}, internal_id=53675,
    )
    calls = []

    async def fake_handle(response, meta):
        calls.append((response, meta))

    monkeypatch.setattr("src.notify.island_response.handle_response", fake_handle)

    r = client.post("/api/island/ack",
                    json={"ack_token": token, "choice": "mark_done"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["kind"] == "mail"
    # handle_response 现在是 fire-and-forget 后台 task (不阻塞响应), 轮询等它跑完
    import time
    for _ in range(100):
        if calls:
            break
        time.sleep(0.02)
    assert len(calls) == 1
    assert calls[0][0] == {"decision": {"answer": {"choice": "mark_done"}}}
    assert calls[0][1]["mailagent.internalId"] == "53675"


def test_ack_invalid_token_404(ack_client, monkeypatch):
    client, _ = ack_client
    called = []
    monkeypatch.setattr("src.notify.island_response.handle_response",
                        lambda *a, **k: called.append(1))
    r = client.post("/api/island/ack",
                    json={"ack_token": "bogus", "choice": "mark_done"})
    assert r.status_code == 404
    assert called == []  # 未路由任何 handler


def test_ack_single_use_second_call_404(ack_client, monkeypatch):
    client, db = ack_client
    token = island_ack.register(
        db, kind="mail", session_key="mailagent:email:1",
        event_type="LLMReviewedUrgent", metadata={"mailagent.internalId": "1"},
        choices={"mark_done"}, internal_id=1,
    )

    async def fake_handle(response, meta):
        return None

    monkeypatch.setattr("src.notify.island_response.handle_response", fake_handle)
    r1 = client.post("/api/island/ack", json={"ack_token": token, "choice": "mark_done"})
    assert r1.status_code == 200
    # 第二次同 token → 已消费 → 404
    r2 = client.post("/api/island/ack", json={"ack_token": token, "choice": "mark_done"})
    assert r2.status_code == 404


def test_ack_choice_mismatch_404(ack_client, monkeypatch):
    client, db = ack_client
    token = island_ack.register(
        db, kind="mail", session_key="mailagent:email:2",
        event_type="LLMReviewedUrgent", metadata={"mailagent.internalId": "2"},
        choices={"mark_done"}, internal_id=2,
    )
    called = []
    monkeypatch.setattr("src.notify.island_response.handle_response",
                        lambda *a, **k: called.append(1))
    r = client.post("/api/island/ack",
                    json={"ack_token": token, "choice": "create_draft"})
    assert r.status_code == 404
    assert called == []
