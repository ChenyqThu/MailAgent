"""API endpoint tests for Skill updates & Connector updates (uses tests/api/conftest.py fixtures)."""

from __future__ import annotations

import pytest


class _Cfg:
    def __init__(self, enabled: bool = True):
        self.mcp_connectors_enabled = enabled
        self.connector_timeout_seconds = 5.0


@pytest.fixture()
def flag_on_client(client):
    from src.api.app import app
    from src.api.deps import get_settings

    app.dependency_overrides[get_settings] = lambda: _Cfg(enabled=True)
    yield client
    app.dependency_overrides.pop(get_settings, None)


def test_skill_update_api_prepare_and_preserve_enabled(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    src_dir = tmp_path / "my-pack"
    src_dir.mkdir()
    (src_dir / "SKILL.md").write_text("---\nname: omada-demo\nversion: 0.1.0\n---\n# v1\n", encoding="utf-8")

    p1 = client.post("/api/agent/skills/fetch", json={"localPath": str(src_dir)}).json()["data"]
    c1 = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": p1["quarantineId"],
            "expectedPackageHash": p1["packageHash"],
            "expectedFiles": p1["files"],
        },
    )
    assert c1.status_code == 201
    assert client.post("/api/agent/skills/omada-demo/enabled", json={"enabled": False}).status_code == 200

    (src_dir / "SKILL.md").write_text("---\nname: omada-demo\nversion: 0.2.0\n---\n# v2\n", encoding="utf-8")
    (src_dir / "notes.txt").write_text("new file", encoding="utf-8")

    upd = client.get("/api/agent/skills/updates?force=true")
    assert upd.status_code == 200
    assert upd.json()["data"]["updatesAvailableCount"] == 1

    prep = client.post("/api/agent/skills/omada-demo/update/prepare")
    assert prep.status_code == 200
    pd = prep.json()["data"]
    assert pd["isUpgrade"] is True
    assert pd["previousVersion"] == "0.1.0"
    assert pd["manifest"]["version"] == "0.2.0"
    assert pd["changedFiles"]["added"] == ["notes.txt"]
    assert "SKILL.md" in pd["changedFiles"]["modified"]

    c2 = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": pd["quarantineId"],
            "expectedPackageHash": pd["packageHash"],
            "expectedFiles": pd["files"],
        },
    )
    assert c2.status_code == 201
    row = fresh_agent_cfg.get_skill("omada-demo")
    assert row is not None
    assert row.enabled is False
    assert row.version == "0.2.0"


def test_connector_updates_and_update_endpoints(flag_on_client, fresh_agent_cfg, monkeypatch):
    import src.connectors.client as client_mod
    from src.connectors import local_installer
    from src.connectors import update_check as cu

    cu.invalidate_connector_update_cache()
    fresh_agent_cfg.upsert_connector(
        "browser_use",
        server_url="",
        display_name="Browser",
        transport="stdio",
        source="managed_local",
        runtime_config={"mode": "cdp_chrome", "cdp_url": "http://127.0.0.1:9222", "headless": False},
    )
    fresh_agent_cfg.update_connector_state("browser_use", status="connected")

    versions = {"current": "0.0.10"}
    seen_rc = {}

    async def fake_check(store, *, force=False, include_remote=True):
        return {
            "checkedAt": 123,
            "updatesAvailableCount": 1,
            "connectors": [
                {
                    "connector_id": "browser_use",
                    "source": "managed_local",
                    "updateKind": "runtime_version",
                    "installedVersion": versions["current"],
                    "latestVersion": "0.0.12",
                    "upstreamLatestVersion": "0.0.12",
                    "updateAvailable": True,
                    "canAutoUpdate": True,
                    "addedTools": [],
                    "removedTools": [],
                    "changedTools": [],
                    "error": None,
                }
            ],
        }

    def fake_install_status(cid, rc=None):
        return {
            "installed": True,
            "version": versions["current"],
            "mode": (rc or {}).get("mode", "isolated_profile"),
            "supported_modes": ["isolated_profile", "cdp_chrome", "extension"],
            "runtime_config": rc,
            "requires_permissions": [],
            "platform_supported": True,
            "executable": "/tmp/pw",
            "error": None,
        }

    def fake_install_runtime(cid, rc=None):
        seen_rc["val"] = rc
        versions["current"] = "0.0.12"
        return fake_install_status(cid, rc)

    class _StubClient:
        def __init__(self, *_a, **_kw):
            pass

        async def list_tools_manifest(self):
            return [{"name": "browser_navigate", "description": "nav", "input_schema": {}, "crud_type": "read"}]

    monkeypatch.setattr(cu, "check_connector_updates", fake_check)
    monkeypatch.setattr(local_installer, "get_install_status", fake_install_status)
    monkeypatch.setattr(local_installer, "install_runtime", fake_install_runtime)
    monkeypatch.setattr(client_mod, "ConnectorClient", _StubClient)

    r_list = flag_on_client.get("/api/connector/updates?force=true")
    assert r_list.status_code == 200
    assert r_list.json()["data"]["updatesAvailableCount"] == 1

    r_upd = flag_on_client.post("/api/connector/browser_use/update")
    assert r_upd.status_code == 200
    d = r_upd.json()["data"]
    assert d["ok"] is True
    assert d["previousVersion"] == "0.0.10"
    assert d["currentVersion"] == "0.0.12"
    assert seen_rc["val"]["mode"] == "cdp_chrome"
    assert seen_rc["val"]["cdp_url"] == "http://127.0.0.1:9222"
    cu.invalidate_connector_update_cache()
