"""Owner setting: the web tier of Matter follow-up runs (0812 dogfood).

镜像 test_agent_auto_compact.py 的形状。差别只有值域（三档）与缺省（keep）。
"""

from __future__ import annotations

import src.api.auth as auth_mod
from src.agent_config.store import AgentConfigStore


def test_get_missing_defaults_keep(client, fresh_agent_cfg):
    response = client.get("/api/agent/matter-web-face")
    assert response.status_code == 200
    assert response.json()["data"]["mode"] == "keep"


def test_put_persists_every_tier_and_get_reflects(client, fresh_agent_cfg):
    for tier in ("search_only", "off", "keep"):
        response = client.put("/api/agent/matter-web-face", json={"mode": tier})
        assert response.status_code == 200
        assert response.json()["data"]["mode"] == tier
        assert client.get("/api/agent/matter-web-face").json()["data"]["mode"] == tier

    client.put("/api/agent/matter-web-face", json={"mode": "off"})
    restarted = AgentConfigStore(fresh_agent_cfg.db_path)
    assert restarted.get_owner_setting("matter_run_web_face") == "off"


def test_invalid_or_missing_mode_400(client, fresh_agent_cfg):
    # 🔴 越域值一律 400，绝不静默回落成 keep —— UI 显示的档与实际生效的档劈叉，
    # 在这个「无人值守 run 能不能出网」的开关上比报错危险得多。
    for bad in ("on", "KEEP", "search-only", "delete", "", 1, None):
        response = client.put("/api/agent/matter-web-face", json={"mode": bad})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_ARG"
    response = client.put("/api/agent/matter-web-face", json={})
    assert response.status_code == 400
    assert fresh_agent_cfg.get_owner_setting("matter_run_web_face") is None


def test_dirty_stored_value_reads_as_keep(client, fresh_agent_cfg):
    fresh_agent_cfg.set_owner_setting("matter_run_web_face", "unexpected")
    assert client.get("/api/agent/matter-web-face").json()["data"]["mode"] == "keep"


def test_unauthenticated_401(client, fresh_agent_cfg, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    assert client.get("/api/agent/matter-web-face").status_code == 401
    assert client.put("/api/agent/matter-web-face", json={"mode": "off"}).status_code == 401
    assert fresh_agent_cfg.get_owner_setting("matter_run_web_face") is None
