"""Phase 5 WP-5C — MCP Server 细粒度权限控制与外科手术式客户端配置写入测试。

覆盖：
  1. ``GET /api/mcp-service/scope-options`` 返回 read_scopes / write_scopes /
     available_tools / ttl_presets_days / client_targets；
  2. 细粒度单只读 scope（``["email:read"]``）：``/mcp`` tools/list 仅暴露邮件只读工具；
  3. TTL 过期拒绝（``ttl_days`` 持久化 + 过期密钥在 ``/mcp`` 与 ``/api/skills/invoke`` 恒 401）；
  4. per-key ``disabled_tools``：``/mcp`` tools/list 隐身 + ``/api/skills/invoke`` 返回
     403 ``E_TOOL_DISABLED_FOR_KEY``；
  5. per-key ``write_rpm_limit``：写/运行类工具超限返回 429 ``E_RATE_LIMITED``，
     纯只读工具不受写限流影响；
  6. ``client_config_writer`` + ``POST /api/mcp-service/client-config``：
     - ``Depends(verify_local_token)`` 阻止远程 CF JWT / 无 token（403）；
     - 保留既有顶层字段与兄弟 ``mcpServers``、创建 `.bak` 备份、``0o600`` 权限；
     - ``dry_run=True`` 不落盘；
     - 损坏 JSON Fail-Closed 返回 409 ``E_CLIENT_CONFIG_INVALID_JSON``。
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import time
from pathlib import Path
from typing import Any

import pytest

import src.api.auth as auth_mod
from src.mcp import client_config_writer
from src.skills import rate_limit

LOCAL_TOK = "ephemeral-secret-phase5-mcp-srv"
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "header.payload.sig"}
LOCAL_HEADERS = {auth_mod.LOCAL_TOKEN_HEADER: LOCAL_TOK}


@pytest.fixture(autouse=True)
def _reset_rate_limit() -> Any:
    rate_limit.reset()
    yield
    rate_limit.reset()


def _arm_cf_jwt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


def _rpc(method: str, params: dict[str, Any] | None = None, req_id: int = 1) -> dict[str, Any]:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def test_scope_options_and_granular_read_scopes(
    skill_client, api_key_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    opts_resp = skill_client.get("/api/mcp-service/scope-options")
    assert opts_resp.status_code == 200, opts_resp.text
    opts = opts_resp.json()["data"]
    assert "email:read" in opts["read_scopes"]
    assert any(w["scope"] == "report:run" for w in opts["write_scopes"])
    assert any(t["tool"] == "email_search" for t in opts["available_tools"])
    assert 7 in opts["ttl_presets_days"]
    assert set(opts["client_targets"]) == {
        "claude_desktop",
        "claude_code",
        "cursor",
        "antigravity",
    }

    created = skill_client.post(
        "/api/mcp-service/keys",
        json={"label": "mail-reader", "scopes": ["email:read"]},
    )
    assert created.status_code == 200, created.text
    plaintext = created.json()["data"]["plaintext"]
    assert created.json()["data"]["key"]["scopes"] == ["email:read"]

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    tools_resp = skill_client.post(
        "/mcp",
        json=_rpc("tools/list"),
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert tools_resp.status_code == 200, tools_resp.text
    names = {t["name"] for t in tools_resp.json()["result"]["tools"]}
    assert "mailagent_email_search" in names
    assert "mailagent_email_get" in names
    assert "mailagent_report_latest" not in names
    assert "mailagent_kos_query" not in names
    assert "mailagent_email_draft" not in names


def test_key_ttl_expiration_rejects_mcp_and_invoke(
    skill_client, api_key_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = int(time.time())
    created = skill_client.post(
        "/api/mcp-service/keys",
        json={"label": "ephemeral", "scopes": ["email:read"], "ttl_days": 7},
    )
    assert created.status_code == 200, created.text
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    data = created.json()["data"]
    key_id = data["key"]["id"]
    plaintext = data["plaintext"]
    assert data["key"]["expires_at"] is not None
    assert data["key"]["expires_at"] >= before + 7 * 86400 - 5

    # Active before expiry.
    headers = {"Authorization": f"Bearer {plaintext}"}
    assert skill_client.post("/mcp", json=_rpc("tools/list"), headers=headers).status_code == 200

    # Backdate expires_at in sqlite to simulate expired key.
    with sqlite3.connect(api_key_store.db_path) as conn:
        conn.execute("UPDATE agent_api_keys SET expires_at = ? WHERE id = ?", (before - 60, key_id))
        conn.commit()

    assert skill_client.post("/mcp", json=_rpc("tools/list"), headers=headers).status_code == 403
    assert (
        skill_client.post(
            "/api/skills/invoke",
            json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
            headers=headers,
        ).status_code
        == 403
    )


def test_disabled_tools_hides_and_blocks_invoke(
    skill_client, api_key_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = skill_client.post(
        "/api/mcp-service/keys",
        json={"label": "tool-gated", "scopes": ["email:read"]},
    )
    assert created.status_code == 200
    key_id = created.json()["data"]["key"]["id"]
    plaintext = created.json()["data"]["plaintext"]
    headers = {"Authorization": f"Bearer {plaintext}"}

    patched = skill_client.patch(
        f"/api/mcp-service/keys/{key_id}",
        json={"disabled_tools": ["email_search"]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["key"]["disabled_tools"] == ["email_search"]

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    tools_resp = skill_client.post("/mcp", json=_rpc("tools/list"), headers=headers)
    assert tools_resp.status_code == 200
    names = {t["name"] for t in tools_resp.json()["result"]["tools"]}
    assert "mailagent_email_search" not in names
    assert "mailagent_email_get" in names

    blocked = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
        headers=headers,
    )
    assert blocked.status_code == 403, blocked.text
    assert blocked.json()["error"]["code"] == "E_TOOL_DISABLED_FOR_KEY"


def test_write_rpm_limit_throttles_writes_only(
    skill_client, api_key_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake_run(*, store, db_path, agent, **kwargs):
        rid = f"rep-{int(time.time() * 1000)}"
        store.create_report(
            report_id=rid,
            agent_id=agent["id"],
            cadence="daily",
            report_date="2026-06-02",
            window_start="2026-06-02T00:00:00Z",
            window_end="2026-06-03T00:00:00Z",
        )
        store.finish_report(
            rid,
            status="ready",
            headline="ok",
            blocks_json='{"blocks": []}',
            counts_json='{"total": 0}',
        )
        return rid

    monkeypatch.setattr("src.reports.worker.run_report_once", _fake_run)

    created = skill_client.post(
        "/api/mcp-service/keys",
        json={
            "label": "rpm-capped",
            "scopes": ["email:read", "report:read", "report:run"],
            "write_rpm_limit": 1,
        },
    )
    assert created.status_code == 200, created.text
    plaintext = created.json()["data"]["plaintext"]
    headers = {"Authorization": f"Bearer {plaintext}"}

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    ok_write = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "report",
            "tool": "report_run",
            "input": {"agent_id": "daily"},
            "confirm": True,
        },
        headers=headers,
    )
    assert ok_write.status_code == 200, ok_write.text

    throttled = skill_client.post(
        "/api/skills/invoke",
        json={
            "skill": "report",
            "tool": "report_run",
            "input": {"agent_id": "daily"},
            "confirm": True,
        },
        headers=headers,
    )
    assert throttled.status_code == 429, throttled.text
    assert throttled.json()["error"]["code"] == "E_RATE_LIMITED"

    # Read tools are never blocked by write_rpm_limit.
    ok_read = skill_client.post(
        "/api/skills/invoke",
        json={"skill": "search", "tool": "email_search", "input": {"q": "redis"}},
        headers=headers,
    )
    assert ok_read.status_code == 200, ok_read.text


def test_client_config_writer_surgical_merge_backup_permissions_and_auth(
    skill_client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_config_writer, "_CONFIG_ROOT_OVERRIDE", tmp_path)

    # Seed existing .claude.json with unrelated top-level key and sibling mcpServers entry.
    claude_code_path = tmp_path / ".claude.json"
    original_payload = {
        "theme": "dark",
        "mcpServers": {
            "github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/"}
        },
    }
    claude_code_path.write_text(json.dumps(original_payload), encoding="utf-8")

    # dry_run leaves disk untouched.
    dry = skill_client.post(
        "/api/mcp-service/client-config",
        json={
            "target": "claude_code",
            "mode": "http",
            "api_base": "http://127.0.0.1:8200",
            "api_key": "mak_secret_123",
            "dry_run": True,
        },
    )
    assert dry.status_code == 200, dry.text
    dry_data = dry.json()["data"]
    assert dry_data["dry_run"] is True
    assert dry_data["wrote"] is False
    assert json.loads(claude_code_path.read_text(encoding="utf-8")) == original_payload

    # Actual write merges cleanly, backs up to .bak, sets 0o600 permissions.
    wrote = skill_client.post(
        "/api/mcp-service/client-config",
        json={
            "target": "claude_code",
            "mode": "http",
            "api_base": "http://127.0.0.1:8200",
            "api_key": "mak_secret_123",
            "dry_run": False,
        },
    )
    assert wrote.status_code == 200, wrote.text
    wdata = wrote.json()["data"]
    assert wdata["wrote"] is True
    assert wdata["backup_path"] == f"{claude_code_path}.bak"

    merged = json.loads(claude_code_path.read_text(encoding="utf-8"))
    assert merged["theme"] == "dark"
    assert merged["mcpServers"]["github"] == original_payload["mcpServers"]["github"]
    assert merged["mcpServers"]["mailagent"] == {
        "type": "http",
        "url": "http://127.0.0.1:8200/mcp",
        "headers": {"Authorization": "Bearer mak_secret_123"},
    }
    assert json.loads(Path(wdata["backup_path"]).read_text(encoding="utf-8")) == original_payload
    assert stat.S_IMODE(os.stat(claude_code_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(wdata["backup_path"]).st_mode) == 0o600

    # Other client targets & stdio mode resolve properly under config_root.
    for target in ("claude_desktop", "cursor", "antigravity"):
        r_target = skill_client.post(
            "/api/mcp-service/client-config",
            json={
                "target": target,
                "mode": "stdio",
                "api_key": "mak_stdio_1",
                "dry_run": False,
            },
        )
        assert r_target.status_code == 200, r_target.text
        target_path = Path(r_target.json()["data"]["path"])
        assert target_path.exists()
        assert target_path.is_relative_to(tmp_path)
        entry = json.loads(target_path.read_text(encoding="utf-8"))["mcpServers"]["mailagent"]
        assert entry["args"] == ["-m", "src.mcp.mailagent_mcp"]
        assert entry["env"]["MAILAGENT_AGENT_KEY"] == "mak_stdio_1"

    # Malformed existing JSON fails closed with 409 E_CLIENT_CONFIG_INVALID_JSON.
    cursor_path = tmp_path / ".cursor" / "mcp.json"
    cursor_path.write_text("{malformed json", encoding="utf-8")
    bad_resp = skill_client.post(
        "/api/mcp-service/client-config",
        json={"target": "cursor", "mode": "http", "dry_run": False},
    )
    assert bad_resp.status_code == 409, bad_resp.text
    assert bad_resp.json()["error"]["code"] == "E_CLIENT_CONFIG_INVALID_JSON"
    assert cursor_path.read_text(encoding="utf-8") == "{malformed json"

    # Enforce verify_local_token when AUTH_DISABLED=False.
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    assert (
        skill_client.post(
            "/api/mcp-service/client-config",
            json={"target": "claude_code", "mode": "http", "dry_run": True},
            headers=CF_HEADERS,
        ).status_code
        == 403
    )
    assert (
        skill_client.post(
            "/api/mcp-service/client-config",
            json={"target": "claude_code", "mode": "http", "dry_run": True},
        ).status_code
        in (401, 403)
    )
    assert (
        skill_client.post(
            "/api/mcp-service/client-config",
            json={"target": "claude_code", "mode": "http", "dry_run": True},
            headers=LOCAL_HEADERS,
        ).status_code
        == 200
    )
