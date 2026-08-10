"""P3 API-face coverage (p3-decisions D5/D8/D9):

- GET  /api/matters/{id}/context-snapshot — 200 bounded shape + flag-off rejection
- POST /api/matters/{id}/chat-scope       — event lands, no version bump, replay,
                                            flag-off rejection
- GET  /api/email/list?matter_id=          — matter-scope filter
- GET  /api/email/search?q=&matter_id=     — matter-scope filter

Idioms follow tests/matters/test_matters_api.py (dependency-override client on the
real FastAPI app). Note: the shipped flag gate maps E_DISABLED -> HTTP 403 (pinned
by the P1 test test_flag_off_returns_disabled_envelope_for_all_methods); D5's
"flag 门 409" wording does not match the implementation — pinned here as 403.
"""

from __future__ import annotations

import os
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_repository, get_settings
from src.api.routers.matters import get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService
from src.repository import EmailRepository

EMAILS = (
    # (internal_id, thread_id, subject, sender, body)
    (201, "TAPI", "Alpha kickoff", "alice@example.test", "needle alpha body"),
    (202, "TAPI", "Alpha follow-up", "alice@example.test", "needle follow body"),
    (203, "TOTHER", "Beta planning", "alice@example.test", "needle beta body"),
    (204, None, "Gamma misc", "bob@example.test", "needle gamma body"),
)


def _seed_emails(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        for iid, thread_id, subject, sender, body in EMAILS:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, message_id, thread_id, "
                "subject, sender, sender_name, to_addr, date_received, mailbox, "
                "sync_status, is_read, is_flagged, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,0,0,1,1)",
                (
                    iid, f"<msg-{iid}@example.test>", thread_id, subject, sender,
                    sender.split("@")[0], "me@example.test",
                    f"2026-05-0{iid - 200} 09:00:00", "收件箱", "synced",
                ),
            )
            conn.execute(
                "INSERT INTO email_body (internal_id, message_id, body_markdown, "
                "body_format, body_size_bytes, has_inline_images, fetched_at, "
                "fetched_source) VALUES (?,?,?,?,?,0,1,'davmail')",
                (iid, f"<msg-{iid}@example.test>", body, "markdown", len(body)),
            )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def matters_client(tmp_path):
    path = tmp_path / "p3-api.db"
    SyncStore(str(path))
    _seed_emails(str(path))
    settings = SimpleNamespace(matters_enabled=True, sync_store_db_path=str(path))
    repo = EmailRepository(db_path=str(path), trigram_enabled=False)
    overrides = {
        verify_cf_access: lambda: None,
        get_settings: lambda: settings,
        get_matter_service: lambda: MatterService(MatterRepository(path)),
        get_repository: lambda: repo,
    }
    app.dependency_overrides.update(overrides)
    with TestClient(app) as test_client:
        yield test_client, settings
    for dep in overrides:
        app.dependency_overrides.pop(dep, None)


def _mutation(key: str, version: int | None = None) -> dict:
    payload = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def _create_matter(http, key: str = "create", title: str = "P3 Matter") -> dict:
    response = http.post(
        "/api/matters", json={"title": title, "mutation": _mutation(key)}
    )
    assert response.status_code == 201
    return response.json()["data"]


def _link_email_resources(http, public_id: str, version: int) -> int:
    """Link email:204 (direct) + thread:TAPI (expands to 201/202); returns version."""
    linked = http.post(
        f"/api/matters/{public_id}/resources",
        json={
            "provider": "mailagent", "external_key": "email:204", "kind": "email",
            "mutation": _mutation("link-email", version),
        },
    )
    assert linked.status_code == 201
    version = linked.json()["data"]["version"]
    linked = http.post(
        f"/api/matters/{public_id}/resources",
        json={
            "provider": "mailagent", "external_key": "thread:TAPI", "kind": "thread",
            "mutation": _mutation("link-thread", version),
        },
    )
    assert linked.status_code == 201
    return linked.json()["data"]["version"]


# ===========================================================================
# GET /api/matters/{id}/context-snapshot
# ===========================================================================


def test_context_snapshot_endpoint_shape(matters_client):
    http, _ = matters_client
    created = _create_matter(http)
    public_id = created["matter"]["public_id"]
    item = http.post(
        f"/api/matters/{public_id}/items",
        json={
            "kind": "action", "title": "Do the thing",
            "mutation": _mutation("item", created["version"]),
        },
    )
    assert item.status_code == 201

    response = http.get(f"/api/matters/{public_id}/context-snapshot")
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) == {"matter", "items", "stakeholders", "resources", "events"}
    assert data["matter"]["public_id"] == public_id
    # matter_type is projected as `type` on the snapshot wire.
    assert "type" in data["matter"]
    assert "matter_type" not in data["matter"]
    assert [entry["title"] for entry in data["items"]] == ["Do the thing"]
    assert data["events"]  # creation + item events inside the window


def test_context_snapshot_unknown_matter_404(matters_client):
    http, _ = matters_client
    response = http.get("/api/matters/MAT-9999/context-snapshot")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "E_MATTER_NOT_FOUND"


def test_context_snapshot_flag_off_rejected(matters_client):
    http, settings = matters_client
    created = _create_matter(http)
    settings.matters_enabled = False
    response = http.get(
        f"/api/matters/{created['matter']['public_id']}/context-snapshot"
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "E_DISABLED"


# ===========================================================================
# POST /api/matters/{id}/chat-scope
# ===========================================================================


def test_chat_scope_endpoint_records_event_without_version_bump(matters_client):
    http, _ = matters_client
    created = _create_matter(http)
    public_id = created["matter"]["public_id"]

    response = http.post(
        f"/api/matters/{public_id}/chat-scope",
        json={"scope": "global", "session_id": 11, "mutation": _mutation("scope-1")},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    # 🔴 D8: no aggregate version bump.
    assert data["version"] == 1
    expanded_event_ids = data["event_ids"]

    timeline = http.get(f"/api/matters/{public_id}/timeline").json()["data"]["items"]
    expanded = [e for e in timeline if e["kind"] == "chat_scope_expanded"]
    assert len(expanded) == 1
    assert expanded[0]["actor_kind"] == "user"
    payload = expanded[0]["payload"]
    assert payload["session_id"] == 11
    assert payload["from"] == "matter"
    assert payload["to"] == "global"

    # Replay with the same idempotency key: same event, no duplicate row.
    replay = http.post(
        f"/api/matters/{public_id}/chat-scope",
        json={"scope": "global", "session_id": 11, "mutation": _mutation("scope-1")},
    )
    assert replay.status_code == 200
    assert replay.json()["data"]["event_ids"] == expanded_event_ids

    # Switching back records the symmetric restore event.
    restored = http.post(
        f"/api/matters/{public_id}/chat-scope",
        json={"scope": "matter", "session_id": 11, "mutation": _mutation("scope-2")},
    )
    assert restored.status_code == 200
    assert restored.json()["data"]["version"] == 1
    timeline = http.get(f"/api/matters/{public_id}/timeline").json()["data"]["items"]
    restore_events = [e for e in timeline if e["kind"] == "chat_scope_restored"]
    assert len(restore_events) == 1
    assert restore_events[0]["payload"]["from"] == "global"
    assert restore_events[0]["payload"]["to"] == "matter"
    assert len([e for e in timeline if e["kind"] == "chat_scope_expanded"]) == 1


def test_chat_scope_rejects_invalid_scope_value(matters_client):
    http, _ = matters_client
    created = _create_matter(http)
    response = http.post(
        f"/api/matters/{created['matter']['public_id']}/chat-scope",
        json={"scope": "everything", "session_id": 1, "mutation": _mutation("bad")},
    )
    assert response.status_code == 422


def test_chat_scope_flag_off_rejected(matters_client):
    http, settings = matters_client
    created = _create_matter(http)
    settings.matters_enabled = False
    response = http.post(
        f"/api/matters/{created['matter']['public_id']}/chat-scope",
        json={"scope": "global", "session_id": 1, "mutation": _mutation("off")},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "E_DISABLED"


# ===========================================================================
# GET /api/email/list + /api/email/search with matter_id
# ===========================================================================


def test_email_list_endpoint_matter_id_filter(matters_client):
    http, _ = matters_client
    created = _create_matter(http)
    public_id = created["matter"]["public_id"]
    matter_id = created["matter"]["id"]
    _link_email_resources(http, public_id, created["version"])

    scoped = http.get(f"/api/email/list?matter_id={matter_id}")
    assert scoped.status_code == 200
    body = scoped.json()
    assert {item["internal_id"] for item in body["data"]} == {201, 202, 204}
    assert body["meta"]["total"] == 3

    unscoped = http.get("/api/email/list")
    assert unscoped.status_code == 200
    assert {item["internal_id"] for item in unscoped.json()["data"]} == {
        201, 202, 203, 204,
    }

    # ge=1 validation boundary.
    assert http.get("/api/email/list?matter_id=0").status_code == 422


def test_email_list_endpoint_matter_without_links_is_empty(matters_client):
    http, _ = matters_client
    created = _create_matter(http, key="create-empty", title="No links")
    response = http.get(f"/api/email/list?matter_id={created['matter']['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0


def test_email_search_endpoint_matter_id_filter(matters_client):
    http, _ = matters_client
    created = _create_matter(http)
    public_id = created["matter"]["public_id"]
    matter_id = created["matter"]["id"]
    _link_email_resources(http, public_id, created["version"])

    scoped = http.get(f"/api/email/search?q=needle&matter_id={matter_id}")
    assert scoped.status_code == 200
    items = scoped.json()["data"]["items"]
    assert {item["internal_id"] for item in items} == {201, 202, 204}

    unscoped = http.get("/api/email/search?q=needle")
    assert unscoped.status_code == 200
    assert {item["internal_id"] for item in unscoped.json()["data"]["items"]} == {
        201, 202, 203, 204,
    }
