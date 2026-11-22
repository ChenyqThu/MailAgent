"""MCP 连接器更新检测（managed_local 运行时 + 远端工具清单漂移）与一键更新端到端单测。"""

from __future__ import annotations

import asyncio
import json

import pytest

from src.agent_config.store import AgentConfigStore
from src.connectors import local_installer
from src.connectors import update_check as cu


class _FakeResetOnly:
    pass


@pytest.fixture(autouse=True)
def _reset_cache():
    cu.invalidate_connector_update_cache()
    yield
    cu.invalidate_connector_update_cache()


def test_check_connector_updates_local_and_remote_drift(tmp_path, monkeypatch):
    store = AgentConfigStore(str(tmp_path / "conn.db"))
    store.upsert_connector("browser_use", server_url="", display_name="Browser", transport="stdio", source="managed_local")
    store.upsert_connector("desktop_use", server_url="", display_name="Desktop", transport="stdio", source="managed_local")
    store.upsert_connector("linear", server_url="https://mcp.linear.app/mcp", display_name="Linear", transport="streamable_http", source="custom_mcp")
    store.update_connector_state("linear", status="connected", last_synced_at=100)
    store.sync_connector_tools(
        "linear",
        [
            {"name": "issue_list", "description": "old desc", "input_schema": {"type": "object"}, "crud_type": "read"},
            {"name": "legacy_tool", "description": "bye", "input_schema": {"type": "object"}, "crud_type": "read"},
        ],
    )

    def fake_status(cid: str, _rc=None):
        if cid == "browser_use":
            return {"installed": True, "version": "0.0.10"}
        if cid == "desktop_use":
            return {"installed": True, "version": local_installer.AGENT_DESKTOP_VERSION}
        return {"installed": False, "version": None}

    async def fake_npm(_client, _pkg):
        return "0.0.12"

    async def fake_gh(_client, _repo):
        return "v9.9.9"

    class _FakeClient:
        def __init__(self, cid, **_kw):
            self.cid = cid

        async def list_tools_manifest(self):
            return [
                {"name": "issue_list", "description": "new desc", "input_schema": {"type": "object"}, "crud_type": "read"},
                {"name": "issue_create", "description": "create", "input_schema": {"type": "object"}, "crud_type": "write"},
            ]

    monkeypatch.setattr(cu, "get_install_status", fake_status)
    monkeypatch.setattr(cu, "_fetch_npm_latest", fake_npm)
    monkeypatch.setattr(cu, "_fetch_github_latest_release", fake_gh)
    monkeypatch.setattr(cu, "ConnectorClient", _FakeClient)
    monkeypatch.setattr(cu, "get_connector_def", lambda cid: object())

    res = asyncio.run(cu.check_connector_updates(store, force=True, include_remote=True))
    by_id = {c["connector_id"]: c for c in res["connectors"]}

    assert res["updatesAvailableCount"] == 2
    assert by_id["browser_use"]["updateAvailable"] is True
    assert by_id["browser_use"]["latestVersion"] == "0.0.12"
    assert by_id["browser_use"]["canAutoUpdate"] is True

    assert by_id["desktop_use"]["updateAvailable"] is False
    assert by_id["desktop_use"]["canAutoUpdate"] is False
    assert by_id["desktop_use"]["upstreamLatestVersion"] == "v9.9.9"

    assert by_id["linear"]["updateAvailable"] is True
    assert by_id["linear"]["updateKind"] == "tool_schema_drift"
    assert by_id["linear"]["addedTools"] == ["issue_create"]
    assert by_id["linear"]["removedTools"] == ["legacy_tool"]
    assert by_id["linear"]["changedTools"] == ["issue_list"]
