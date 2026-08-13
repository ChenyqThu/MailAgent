"""P9 Custom Agent compatibility API and feature-flag tests."""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.agent_config import store as acstore
from src.agent_config.llm_providers import LlmProviderStore
from src.api.app import app
from src.mail.sync_store import SyncStore
from src.reports import wire
from src.reports.store import ReportStore
from src.skills.plugin_import import MAX_PLUGIN_ZIP_BYTES


@pytest.fixture
def plugin_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db = tmp_path / "report.db"; SyncStore(str(db)); report_store = ReportStore(str(db))
    monkeypatch.setattr("src.api.routers.reports.get_report_store", lambda: report_store)
    monkeypatch.setattr("src.api.routers.reports._custom_agents_enabled", lambda: True)
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent.db"))
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(tmp_path / "skills"))
    env_file = tmp_path / ".env"
    env_file.write_text("", encoding="utf-8")
    monkeypatch.setattr("src.api.deps.get_env_file_path", lambda: str(env_file))
    acstore.reset_agent_config_store_cache()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, report_store, acstore.get_agent_config_store(), tmp_path, env_file
    acstore.reset_agent_config_store_cache()


def _payload(**agent):
    return {"schema_version": 1, "kind": "mailagent.custom_agent", "agent": {"title": "Imported", "description": "desc", "prompt": "prompt", "model": None, "enabled": True, "trigger": None, "tool_policy": {"v": 1}, "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800}, "avatar": None, **agent}}


def test_export_whitelist_and_avatar_shapes(plugin_client):
    client, store, _, _, _ = plugin_client
    row = store.create_agent("custom-image", type="custom", title="Image", enabled=True, prompt="P")
    store.update_agent("custom-image", wire.config_patch_to_db({"avatar": {"type": "image", "data": "data:image/png;base64,YQ=="}}))
    data = client.get("/api/report-agents/custom-image/export").json()["data"]
    assert set(data) == {"schema_version", "kind", "agent"}
    assert "id" not in data["agent"] and "updated_at" not in data["agent"]
    assert data["agent"]["avatar"] is None and "/Users/" not in json.dumps(data)
    store.create_agent("custom-shape", type="custom", title="Shape")
    store.update_agent("custom-shape", wire.config_patch_to_db({"avatar": {"shape": "bloom", "palette": "rose", "variant_id": "v1"}}))
    assert client.get("/api/report-agents/custom-shape/export").json()["data"]["agent"]["avatar"] == {"shape": "bloom", "palette": "rose", "variant_id": "v1"}
    # type='bot'（08-12 第三种 kind）对齐生成式规则**原样导出** —— 只是词表引用，无体积/隐私
    # 负担；这里钉住 plugin_compat 的判别只收窄 image 一侧，防未来有人把收窄写成白名单。
    store.create_agent("custom-bot", type="custom", title="Bot")
    store.update_agent("custom-bot", wire.config_patch_to_db({"avatar": {"type": "bot", "shape": "kirby", "color": "teal"}}))
    assert client.get("/api/report-agents/custom-bot/export").json()["data"]["agent"]["avatar"] == {"type": "bot", "shape": "kirby", "color": "teal"}
    store.create_agent("report-only", type="report", title="Report")
    assert client.get("/api/report-agents/report-only/export").status_code == 404


def test_import_forces_disabled_validation_and_round_trip(plugin_client):
    client, store, _, _, _ = plugin_client
    source = store.create_agent("round-source", type="custom", title="Round", enabled=True, prompt="Do it", description="D", model="missing:model")
    store.update_agent("round-source", wire.config_patch_to_db({"tool_policy": {"v": 1, "skills": ["email"]}, "budget": {"max_runs_per_day": 3, "max_run_seconds": 60}, "avatar": {"shape": "jade", "palette": "green"}}))
    exported = client.get("/api/report-agents/round-source/export").json()["data"]
    response = client.post("/api/report-agents/import", json={"payload": exported})
    assert response.status_code == 200
    result = response.json()["data"]
    assert result["enabled_forced_off"] is True and result["agent"]["enabled"] is False
    assert {k: result["agent"][k] for k in ("title", "description", "prompt", "model", "tool_policy", "budget", "avatar")} == {k: wire.resolve_agent(store.get_agent("round-source"))[k] for k in ("title", "description", "prompt", "model", "tool_policy", "budget", "avatar")}
    bad = [
        {"payload": {**_payload(), "schema_version": 2}},
        {"payload": {**_payload(), "kind": "bad"}},
        {"payload": []},
        {"payload": _payload(title="")},
    ]
    for body in bad: assert client.post("/api/report-agents/import", json=body).status_code == 400


def test_unmet_dependencies_and_existing_dependencies(plugin_client, monkeypatch):
    client, _, agent_store, tmp, _ = plugin_client
    missing = _payload(model="missing:model", tool_policy={"v": 1, "skills": ["missing-skill"], "grant_connectors": {"missing-connector": "read"}})
    deps = client.post("/api/report-agents/import", json={"payload": missing}).json()["data"]["unmet_dependencies"]
    assert {(item["type"], item["ref"]) for item in deps} == {("skill", "missing-skill"), ("connector", "missing-connector"), ("model", "missing:model")}
    agent_store.upsert_connector("known", server_url="https://example.test")
    providers = LlmProviderStore(str(tmp / "agent.db")); providers.create_provider("known-provider", protocol="openai-compatible")
    monkeypatch.setattr("src.agents.plugin_compat.get_llm_provider_store", lambda: providers)
    existing = _payload(model="known-provider:model", tool_policy={"v": 1, "skills": ["email"], "grant_connectors": {"known": "read"}})
    assert client.post("/api/report-agents/import", json={"payload": existing}).json()["data"]["unmet_dependencies"] == []


def test_template_has_v2_trigger_id_and_valid_skills(plugin_client, monkeypatch):
    client, store, _, _, _ = plugin_client
    monkeypatch.setattr("src.agents.trigger.calendar_trigger_enabled", lambda: True)
    response = client.post("/api/report-agents/import", json={"template": "meeting_prep"})
    assert response.status_code == 200
    agent = response.json()["data"]["agent"]
    trigger = agent["trigger"]
    assert trigger["v"] == 2 and trigger["triggers"][0]["id"].startswith("trg_")
    assert agent["tool_policy"]["skills"] == ["email", "search", "calendar"]
    assert store.get_agent(agent["id"])["enabled"] == 0
    # model=None 必须落 NULL 而非字面 'None'（config_patch_to_db 旧的无条件 str() 之坑）：
    # 否则导出吐 'None' 字符串、再导入报虚假的 model unmet。
    assert store.get_agent(agent["id"])["model"] in (None, "")
    assert response.json()["data"]["unmet_dependencies"] == []
    exported = client.get(f"/api/report-agents/{agent['id']}/export")
    assert exported.json()["data"]["agent"]["model"] is None
    assert client.post("/api/report-agents/import", json={"template": "unknown"}).status_code == 404


def test_trigger_v2_flag_off_matches_put_path(plugin_client, monkeypatch):
    client, store, _, _, _ = plugin_client
    monkeypatch.setattr("src.agents.trigger.trigger_v2_enabled", lambda: False)
    trigger = {"v": 1, "kind": "email_filter", "subject_pattern": "Invoice"}
    store.create_agent("put-target", type="custom", title="Put")
    put = client.put("/api/report-agents/put-target", json={"trigger": trigger})
    imported = client.post("/api/report-agents/import", json={"payload": _payload(trigger=trigger)})
    assert put.status_code == imported.status_code == 200
    assert put.json()["data"]["trigger"] == trigger
    assert imported.json()["data"]["agent"]["trigger"] == trigger


def test_flag_off_hides_all_new_faces(plugin_client):
    client, store, _, _, env_file = plugin_client
    store.create_agent("custom", type="custom", title="C")
    env_file.write_text("MAILAGENT_AGENT_PLUGINS=false\n", encoding="utf-8")
    calls = [
        client.get("/api/report-agents/custom/export"),
        client.post("/api/report-agents/import", json={"payload": _payload()}),
        client.post("/api/agent/skills/plugin/import", json={"zipBase64": ""}),
        client.get("/api/agent/skills/none/export?format=skill"),
        client.get("/api/agent/skills/none/export?format=plugin"),
    ]
    assert [response.status_code for response in calls] == [404] * 5
    env_file.write_text("", encoding="utf-8")
    assert client.get("/api/report-agents/custom/export").status_code == 200


def test_plugin_import_base64_decoded_size_cap_is_413(plugin_client):
    client, _, _, _, _ = plugin_client
    encoded = base64.b64encode(b"x" * (MAX_PLUGIN_ZIP_BYTES + 1)).decode("ascii")
    response = client.post("/api/agent/skills/plugin/import", json={"zipBase64": encoded})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "E_PACK_BOMB"
