from __future__ import annotations

import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.matters import get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    settings = SimpleNamespace(matters_enabled=True, sync_store_db_path=str(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    with TestClient(app) as test_client:
        yield test_client, settings
    app.dependency_overrides.clear()


def _mutation(key: str, version: int | None = None):
    payload = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def test_matter_rest_smoke(client):
    http, _ = client
    created = http.post(
        "/api/matters",
        json={"title": "API Matter", "mutation": _mutation("create")},
    )
    assert created.status_code == 201
    matter = created.json()["data"]["matter"]

    listed = http.get("/api/matters")
    assert listed.status_code == 200
    assert listed.json()["data"]["items"][0]["public_id"] == matter["public_id"]

    detail = http.get(
        f"/api/matters/{matter['public_id']}?include=items,timeline,updates"
    )
    assert detail.status_code == 200

    patched = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"status": "active", "mutation": _mutation("patch", matter["version"])},
    )
    assert patched.status_code == 200
    version = patched.json()["data"]["version"]

    trashed = http.post(
        f"/api/matters/{matter['public_id']}/trash",
        json={"mutation": _mutation("trash", version)},
    )
    assert trashed.status_code == 200
    version = trashed.json()["data"]["version"]

    restored = http.post(
        f"/api/matters/{matter['public_id']}/restore",
        json={"mutation": _mutation("restore", version)},
    )
    assert restored.status_code == 200
    assert restored.json()["data"]["matter"]["deleted_at"] is None


def test_flag_off_returns_disabled_envelope_for_all_methods(client):
    http, settings = client
    settings.matters_enabled = False
    for method, path, kwargs in (
        ("get", "/api/matters", {}),
        ("post", "/api/matters", {"json": {"title": "x", "mutation": _mutation("x")}}),
        ("get", "/api/matters/MAT-0001", {}),
    ):
        response = getattr(http, method)(path, **kwargs)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DISABLED"


def test_version_conflict_error_shape(client):
    http, _ = client
    matter = http.post(
        "/api/matters", json={"title": "Conflict", "mutation": _mutation("c")}
    ).json()["data"]["matter"]
    http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"title": "first", "mutation": _mutation("p1", 1)},
    )
    response = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"title": "second", "mutation": _mutation("p2", 1)},
    )
    payload = response.json()
    assert response.status_code == 409
    assert payload["status"] == "error"
    assert payload["data"] is None
    assert payload["error"]["code"] == "E_VERSION_CONFLICT"
    assert payload["error"]["hint"]
