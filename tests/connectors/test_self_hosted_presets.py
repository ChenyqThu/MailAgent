"""Self-Hosted MCP Presets (Artifact Server) — catalog, API exposure & custom connector creation."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Iterator

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")
os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(tempfile.mkdtemp(prefix="mailagent-preset-conntest-"), "agent_config.db"),
)

import pytest
from fastapi.testclient import TestClient

from src.agent_config import secrets
from src.agent_config import store as acstore
from src.agent_config.store import AgentConfigStore
from src.api.app import app
from src.api.deps import get_settings
from src.connectors.catalog import (
    COMPOSIO_CATALOG,
    DIRECT_CATALOG,
    MANAGED_LOCAL_CATALOG,
    SELF_HOSTED_PRESETS,
    get_self_hosted_preset,
    self_hosted_preset_views,
    track_for,
)


class _Cfg:
    mcp_connectors_enabled = True
    connector_timeout_seconds = 5.0


@pytest.fixture()
def preset_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[TestClient, AgentConfigStore]]:
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    acstore.reset_agent_config_store_cache()
    app.dependency_overrides[get_settings] = lambda: _Cfg()
    try:
        store = acstore.get_agent_config_store()
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client, store
    finally:
        app.dependency_overrides.pop(get_settings, None)
        secrets.reset_master_key_cache()
        acstore.reset_agent_config_store_cache()


def test_self_hosted_presets_invariants():
    assert "artifact_server" in SELF_HOSTED_PRESETS
    preset = get_self_hosted_preset("artifact_server")
    assert preset is not None
    assert preset.default_server_url == "https://canvas.chenge.ink/mcp"
    assert preset.transport == "streamable_http"
    assert preset.auth_header == "Authorization"
    assert preset.auth_prefix == "Bearer "

    views = self_hosted_preset_views()
    assert [v.connector_id for v in views] == sorted(SELF_HOSTED_PRESETS)
    for cid in SELF_HOSTED_PRESETS:
        assert cid not in DIRECT_CATALOG
        assert cid not in COMPOSIO_CATALOG
        assert cid not in MANAGED_LOCAL_CATALOG
        assert track_for(cid) is None


def test_catalog_exposes_self_hosted_preset_and_tracks_configured_state(
    preset_env: tuple[TestClient, AgentConfigStore],
):
    client, store = preset_env

    res = client.get("/api/connector/catalog")
    assert res.status_code == 200
    presets = res.json()["data"]["self_hosted_presets"]
    artifact = next(p for p in presets if p["connector_id"] == "artifact_server")
    assert artifact["configured"] is False
    assert artifact["default_server_url"] == "https://canvas.chenge.ink/mcp"

    created = client.post(
        "/api/connector/custom",
        json={
            "connector_id": "artifact_server",
            "display_name": "Artifact Server",
            "transport": "streamable_http",
            "server_url": "https://canvas.chenge.ink/mcp",
            "headers": {"Authorization": "Bearer secret-agent-token"},
        },
    )
    assert created.status_code == 200
    body = created.json()["data"]
    assert body["connector_id"] == "artifact_server"
    assert body["is_custom"] is True
    assert body["custom_header_names"] == ["Authorization"]
    assert "secret-agent-token" not in created.text

    headers_dec, _env = store.get_connector_custom_secrets("artifact_server")
    assert headers_dec == {"Authorization": "Bearer secret-agent-token"}

    res_after = client.get("/api/connector/catalog")
    assert res_after.status_code == 200
    presets_after = res_after.json()["data"]["self_hosted_presets"]
    artifact_after = next(p for p in presets_after if p["connector_id"] == "artifact_server")
    assert artifact_after["configured"] is True
