from __future__ import annotations

import sqlite3
import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings
from src.api.routers.contacts import get_contact_repository
from src.contacts.repository import ContactRepository
from src.mail.sync_store import SyncStore


@pytest.fixture
def api(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, created_at, updated_at) "
            "VALUES (1,'Alice','person',1,1)"
        )
        conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, is_primary, created_at) "
            "VALUES (1,'alice@example.com',1,1)"
        )
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, date_received) "
            "VALUES (10,'m-1','2026-08-19T08:00:00-07:00')"
        )
        conn.commit()
    settings = SimpleNamespace(
        sync_store_db_path=str(path),
        user_email="",
        self_emails="",
    )
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[verify_local_token] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_contact_repository] = lambda: ContactRepository(path)
    with TestClient(app) as client:
        yield client, settings, str(path)
    app.dependency_overrides.clear()


def _proposal_payload(suggestion_type="identity", payload=None):
    return {
        "type": suggestion_type,
        "contact_ids": [1],
        "payload": payload or {"field": "organization", "value": "ACME"},
        "evidence": [{"message_id": "m-1", "quote": "ACME"}],
        "confidence": 0.8,
    }


def test_agent_leg_create_owner_list_and_ignore(api):
    client, _, _ = api
    created = client.post("/api/contacts/agent/proposals", json=_proposal_payload())
    assert created.status_code == 200, created.text
    suggestion_id = created.json()["data"]["id"]
    listed = client.get("/api/contacts/suggestions")
    assert listed.status_code == 200
    assert listed.json()["data"]["items"][0]["id"] == suggestion_id
    ignored = client.post(f"/api/contacts/suggestions/{suggestion_id}/ignore")
    assert ignored.status_code == 200
    assert ignored.json()["data"]["status"] == "ignored"


def test_agent_leg_create_publishes_pending_notification_after_commit(api):
    """通知中心接线 (task 08-20-notification-center 返工): propose_contact_governance
    在 `with repo.transaction()` 块 commit 之后才调用 notify_pending_suggestion——
    端点走真实 TestClient + 真实 ContactRepository, 覆盖了返工要修的那条调用链。"""
    client, _, path = api
    created = client.post("/api/contacts/agent/proposals", json=_proposal_payload())
    assert created.status_code == 200, created.text

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM notification ORDER BY id").fetchall()
    assert len(rows) == 1
    row = dict(rows[0])
    assert row["category"] == "reviews"
    assert row["dedupe_key"] == "contact_suggestion:pending"
    assert row["recurrence_no"] == 1


def test_agent_leg_duplicate_proposal_does_not_bump_notification(api):
    client, _, path = api
    first = client.post("/api/contacts/agent/proposals", json=_proposal_payload())
    second = client.post("/api/contacts/agent/proposals", json=_proposal_payload())
    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["created"] is True
    assert second.json()["data"]["created"] is False

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM notification ORDER BY id").fetchall()
    assert len(rows) == 1
    assert dict(rows[0])["recurrence_no"] == 1


def test_blocked_adopt_commits_before_4xx(api):
    client, _, path = api
    created = client.post(
        "/api/contacts/agent/proposals",
        json=_proposal_payload("former_email", {"email": "alice@example.com"}),
    )
    suggestion_id = created.json()["data"]["id"]
    response = client.post(f"/api/contacts/suggestions/{suggestion_id}/adopt")
    assert 400 <= response.status_code < 500
    assert response.json()["error"]["code"] == "E_PRIMARY_EMAIL_CANNOT_BE_FORMER"
    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT status, block_reason, decided_at FROM contact_suggestion WHERE id=?",
            (suggestion_id,),
        ).fetchone()
    assert row[0] == "blocked" and "E_PRIMARY_EMAIL_CANNOT_BE_FORMER" in row[1]
    assert row[2] is not None


def test_bulk_adopt_returns_200_with_classified_summary(api):
    """整批口恒 200：merge 进 skipped、被守卫拦下的进 blocked，其余照常采纳
    （逐条 adopt 的 4xx 语义在这里不适用 —— 一条被拦不该把整批结果打回去）。"""
    client, _, path = api
    identity = client.post("/api/contacts/agent/proposals", json=_proposal_payload())
    merge = client.post(
        "/api/contacts/agent/proposals",
        json={**_proposal_payload("merge"), "contact_ids": [1, 1], "payload": {}},
    )
    former = client.post(
        "/api/contacts/agent/proposals",
        json=_proposal_payload("former_email", {"email": "alice@example.com"}),
    )
    assert identity.status_code == merge.status_code == former.status_code == 200

    response = client.post("/api/contacts/suggestions/bulk", json={"action": "adopt"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["action"] == "adopt"
    assert data["adopted"] == 1
    assert data["ignored"] == 0
    assert data["skipped"] == [
        {"id": merge.json()["data"]["id"], "reason": "merge_requires_manual_confirmation"}
    ]
    assert [item["id"] for item in data["blocked"]] == [former.json()["data"]["id"]]
    assert data["remaining"] == 1  # merge 那条仍待人工确认
    assert data["contact_ids"] == [1]

    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT organization FROM contact WHERE id=1").fetchone()[0] == "ACME"


def test_bulk_ignore_on_empty_queue_is_200_with_zero_summary(api):
    client, _, _ = api
    response = client.post("/api/contacts/suggestions/bulk", json={"action": "ignore"})
    assert response.status_code == 200
    data = response.json()["data"]
    assert (data["adopted"], data["ignored"], data["remaining"]) == (0, 0, 0)
    assert data["blocked"] == [] and data["skipped"] == []


def test_bulk_rejects_unknown_action(api):
    client, _, _ = api
    response = client.post("/api/contacts/suggestions/bulk", json={"action": "delete"})
    assert 400 <= response.status_code < 500
    assert response.json()["error"]["code"] == "E_INVALID_ARG"


def test_manual_run_idempotent_and_status(api):
    client, _, _ = api
    first = client.post("/api/contacts/agent/run", headers={"Idempotency-Key": "run-1"})
    second = client.post("/api/contacts/agent/run", headers={"Idempotency-Key": "run-1"})
    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["job_id"] == second.json()["data"]["job_id"]
    status = client.get("/api/contacts/agent/status")
    assert status.status_code == 200
    assert status.json()["data"]["enabled"] is True


def test_agent_status_exposes_latest_scan_result(api):
    client, _, path = api
    empty = client.get("/api/contacts/agent/status")
    assert empty.status_code == 200
    assert empty.json()["data"]["last_scan_status"] is None
    assert empty.json()["data"]["last_scan_error"] is None

    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO async_jobs "
            "(job_type, status, last_error, created_at, updated_at) "
            "VALUES (?, 'failed', 'E_DISABLED', 123.0, 123.0)",
            ("contact_governance",),
        )
        conn.commit()

    failed = client.get("/api/contacts/agent/status")
    assert failed.status_code == 200
    assert failed.json()["data"]["last_scan_status"] == "failed"
    assert failed.json()["data"]["last_scan_error"] == "E_DISABLED"


def test_agent_history_contract_order_limit_and_suggestion_count(api):
    client, _, path = api
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO async_jobs "
            "(job_type, status, result_json, last_error, created_at, updated_at, started_at, finished_at) "
            "VALUES ('contact_governance', 'succeeded', ?, NULL, 10, 12, 11, 12)",
            ('{"suggestions_created":2}',),
        )
        conn.execute(
            "INSERT INTO async_jobs "
            "(job_type, status, result_json, last_error, created_at, updated_at) "
            "VALUES ('contact_governance', 'failed', NULL, 'E_DISABLED', 20, 20)"
        )
        conn.commit()
    response = client.get("/api/contacts/agent/history", params={"limit": 2})
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["status"] for item in items] == ["failed", "succeeded"]
    assert set(items[0]) == {
        "job_id", "status", "created_at", "started_at", "finished_at",
        "last_error", "suggestions_created", "trigger_kind",
    }
    assert items[0]["suggestions_created"] is None
    assert items[1]["suggestions_created"] == 2
    # async_jobs 存 epoch 秒，对外契约统一毫秒（daily-summary 同款）。
    assert items[1]["created_at"] == 10_000
    assert items[1]["started_at"] == 11_000
    assert items[0]["trigger_kind"] is None
    assert client.get("/api/contacts/agent/history", params={"limit": 51}).status_code == 422
