from __future__ import annotations

import os

from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.agent_config.store import (
    AgentConfigStore,
    CONTACT_AGENT_DOC_NAME,
    CONTACT_ORG_FRAME_DOC_NAME,
)
from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.routers import agent as agent_router
from src.contacts import governance


def test_prompt_default_override_and_empty_restore(tmp_path, monkeypatch):
    store = AgentConfigStore(tmp_path / "agent.db")
    monkeypatch.setattr(agent_router, "get_agent_config_store", lambda: store)
    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", lambda: store)
    app.dependency_overrides[verify_cf_access] = lambda: None
    with TestClient(app) as client:
        initial = client.get(f"/api/agent/profile/docs/{CONTACT_AGENT_DOC_NAME}")
        assert initial.status_code == 200
        assert initial.json()["data"]["defaultContent"] == governance.default_governance_prompt()
        custom = client.post(
            f"/api/agent/profile/docs/{CONTACT_AGENT_DOC_NAME}",
            json={"content": "CUSTOM GOVERNANCE"},
        )
        assert custom.status_code == 200
        assert custom.json()["data"]["defaultContent"] == governance.default_governance_prompt()
        assert governance._effective_prompt() == (
            governance.default_governance_prompt() + "\n\nCUSTOM GOVERNANCE"
        )
        restored = client.post(
            f"/api/agent/profile/docs/{CONTACT_AGENT_DOC_NAME}",
            json={"content": ""},
        )
        assert restored.status_code == 200
        assert restored.json()["data"]["defaultContent"] == governance.default_governance_prompt()
        assert governance._effective_prompt() == governance.default_governance_prompt()
    app.dependency_overrides.clear()


def test_governance_prompt_org_frame_injection_is_conditional(tmp_path, monkeypatch):
    store = AgentConfigStore(tmp_path / "agent.db")
    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", lambda: store)
    assert "ORG FRAME" not in governance._effective_prompt()
    store.set_profile_doc(
        CONTACT_ORG_FRAME_DOC_NAME,
        "# 公司\nAcme | acme.example\n# 部门框架\nA / B\n",
    )
    prompt = governance._effective_prompt()
    assert "ORG FRAME" in prompt
    assert "Acme | acme.example" in prompt
    assert "A / B" in prompt
    assert "organization 必须" in prompt
    assert "框架不是证据" in prompt
