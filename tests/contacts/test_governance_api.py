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
        contacts_enabled=True,
        contact_agent_enabled=True,
        contact_profile_enabled=False,
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


def test_manual_run_idempotent_and_status(api):
    client, _, _ = api
    first = client.post("/api/contacts/agent/run", headers={"Idempotency-Key": "run-1"})
    second = client.post("/api/contacts/agent/run", headers={"Idempotency-Key": "run-1"})
    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["job_id"] == second.json()["data"]["job_id"]
    status = client.get("/api/contacts/agent/status")
    assert status.status_code == 200
    assert status.json()["data"]["enabled"] is True


def test_contact_agent_flag_is_second_gate(api):
    client, settings, _ = api
    settings.contact_agent_enabled = False
    for method, url in (
        ("GET", "/api/contacts/suggestions"),
        ("POST", "/api/contacts/agent/run"),
        ("GET", "/api/contacts/agent/status"),
        ("POST", "/api/contacts/agent/proposals"),
    ):
        response = client.request(method, url, json={} if method == "POST" else None)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DISABLED"
