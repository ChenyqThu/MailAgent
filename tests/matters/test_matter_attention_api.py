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
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings
from src.api.routers.matters import get_attention_service, get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.attention import AttentionService
from src.matters.repository import MatterRepository
from src.matters.service import MatterService

NOW = 1_786_464_000_000


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "attention-api.db"
    SyncStore(str(path))
    settings = SimpleNamespace(
        matters_enabled=True, matter_agent_enabled=True, sync_store_db_path=str(path)
    )
    repo = MatterRepository(path)
    matter_service = MatterService(repo, clock_ms=lambda: NOW)
    attention = AttentionService(repo, clock_ms=lambda: NOW)
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[verify_local_token] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: matter_service
    app.dependency_overrides[get_attention_service] = lambda: attention
    with TestClient(app) as client:
        yield client, str(path), matter_service, attention
    app.dependency_overrides.clear()


def _mutation(key):
    return {"source": "desktop_ui", "idempotency_key": key}


def test_attention_rest_triage_ack_and_no_version_bump(env):
    client, path, matter_service, attention = env
    created = client.post(
        "/api/matters", json={"title": "Attention API", "mutation": _mutation("create")}
    ).json()["data"]
    matter = created["matter"]
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_update(matter_id,review_status,anchored_matter_version," 
            "original_proposal_json,changes_json,citations_json,created_by_kind,is_stale,created_at) "
            "VALUES (?,'pending',?,'{}','[]','[]','agent',0,?)",
            (matter["id"], matter["version"], NOW),
        )
        conn.commit()
    signal = attention.open_signal(
        matter_id=matter["id"], kind="needs_review", subject_key="update:1",
        severity="info", why="有一条 Agent 提案等待评审", payload={"update_id": 1},
    )
    assert signal is not None

    global_list = client.get("/api/matters/attention")
    assert global_list.status_code == 200
    assert global_list.json()["data"]["items"][0]["matter"]["public_id"] == matter["public_id"]
    detail = client.get(f"/api/matters/{matter['public_id']}/attention")
    assert detail.status_code == 200

    snoozed = client.post(
        f"/api/matters/{matter['public_id']}/attention/{signal['id']}/snooze",
        json={"preset": "3d", "mutation": _mutation("snooze")},
    )
    assert snoozed.status_code == 200
    assert snoozed.json()["data"]["version"] == matter["version"]
    replay = client.post(
        f"/api/matters/{matter['public_id']}/attention/{signal['id']}/snooze",
        json={"preset": "3d", "mutation": _mutation("snooze")},
    )
    assert replay.status_code == 200
    with sqlite3.connect(path) as conn:
        row = conn.execute("SELECT version FROM matter WHERE id=?", (matter["id"],)).fetchone()
        proposal = conn.execute("SELECT is_stale FROM matter_update WHERE id=1").fetchone()
    assert row[0] == matter["version"]
    assert proposal[0] == 0

    resolved = client.post(
        f"/api/matters/{matter['public_id']}/attention/{signal['id']}/resolve",
        json={"mutation": _mutation("resolve")},
    )
    assert resolved.status_code == 200

    reopened = attention.open_signal(
        matter_id=matter["id"], kind="run_failed", subject_key="run:9",
        severity="critical", why="运行失败",
    )
    ack = client.post(
        f"/api/matters/{matter['public_id']}/attention/{reopened['id']}/notified"
    )
    assert ack.status_code == 200
    assert ack.json()["data"]["last_notified_at"] == NOW


def test_notified_endpoint_uses_local_token_without_cf_dependency():
    route = next(
        route
        for route in app.routes
        if getattr(route, "path", "")
        == "/api/matters/{matter_id}/attention/{signal_id}/notified"
    )
    dependency_calls = {dependency.call for dependency in route.dependant.dependencies}
    assert verify_local_token in dependency_calls
    assert verify_cf_access not in dependency_calls


def test_matter_notify_level_default_put_and_validation(env, tmp_path, monkeypatch):
    from src.agent_config.store import reset_agent_config_store_cache

    client, _, _, _ = env
    monkeypatch.setenv(
        "MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db")
    )
    reset_agent_config_store_cache()
    assert client.get("/api/matters/notify-level").json()["data"]["level"] == "high"
    updated = client.put("/api/matters/notify-level", json={"level": "all"})
    assert updated.status_code == 200
    assert client.get("/api/matters/notify-level").json()["data"]["level"] == "all"
    invalid = client.put("/api/matters/notify-level", json={"level": "loud"})
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "E_INVALID_ARG"
    reset_agent_config_store_cache()
