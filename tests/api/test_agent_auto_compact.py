"""Owner automatic Compact setting endpoints."""

from __future__ import annotations

import src.api.auth as auth_mod
from src.agent_config.store import AgentConfigStore


def test_get_missing_defaults_on(client, fresh_agent_cfg):
    response = client.get("/api/agent/auto-compact")
    assert response.status_code == 200
    assert response.json()["data"]["mode"] == "on"


def test_put_persists_and_get_reflects(client, fresh_agent_cfg):
    response = client.put("/api/agent/auto-compact", json={"mode": "off"})
    assert response.status_code == 200
    assert client.get("/api/agent/auto-compact").json()["data"]["mode"] == "off"
    restarted = AgentConfigStore(fresh_agent_cfg.db_path)
    assert restarted.get_owner_setting("chat_auto_compact") == "off"

    response = client.put("/api/agent/auto-compact", json={"mode": "on"})
    assert response.status_code == 200
    assert response.json()["data"]["mode"] == "on"


def test_invalid_or_missing_mode_400(client, fresh_agent_cfg):
    for bad in ("auto", "ON", "", 1, None):
        response = client.put("/api/agent/auto-compact", json={"mode": bad})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_ARG"
    response = client.put("/api/agent/auto-compact", json={})
    assert response.status_code == 400
    assert fresh_agent_cfg.get_owner_setting("chat_auto_compact") is None


def test_dirty_stored_value_reads_as_on(client, fresh_agent_cfg):
    fresh_agent_cfg.set_owner_setting("chat_auto_compact", "unexpected")
    assert client.get("/api/agent/auto-compact").json()["data"]["mode"] == "on"


def test_unauthenticated_401(client, fresh_agent_cfg, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert client.get("/api/agent/auto-compact").status_code == 401
    assert client.put("/api/agent/auto-compact", json={"mode": "off"}).status_code == 401
    assert fresh_agent_cfg.get_owner_setting("chat_auto_compact") is None
