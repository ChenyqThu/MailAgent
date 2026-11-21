"""Wave 3 (WS-3) managed_local 本地安装器与 TCC 权限单测。"""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest

from src.connectors import local_installer


def _build_tar_gz(entries: dict[str, tuple[bytes, int]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, (data, mode) in entries.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            info.mode = mode
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_resolve_mcp_runtimes_dir_defaults_and_override(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "MAILAGENT_AGENT_CONFIG_DB_PATH",
        str(tmp_path / "userData" / "data" / "agent_config.db"),
    )
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", None)
    assert (
        local_installer.resolve_mcp_runtimes_dir()
        == (tmp_path / "userData" / "mcp-runtimes").resolve()
    )

    custom_dir = tmp_path / "custom-rt"
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", custom_dir)
    assert local_installer.resolve_mcp_runtimes_dir() == custom_dir.resolve()


def test_resolve_mcp_runtimes_dir_isolates_flat_test_db(tmp_path, monkeypatch):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", None)
    assert local_installer.resolve_mcp_runtimes_dir() == (tmp_path / "mcp-runtimes").resolve()


def test_browser_use_install_three_modes_and_uninstall(tmp_path, monkeypatch):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    calls: list[list[str]] = []

    monkeypatch.setattr(local_installer, "_find_npm", lambda: "/mock/bin/npm")
    monkeypatch.setattr(local_installer, "_find_node", lambda: "/mock/bin/node")

    def _fake_run(cmd, *, cwd=None, env=None, timeout=180.0):
        calls.append(list(cmd))
        # Simulate npm installing into --prefix <staging>/pkg
        prefix_idx = cmd.index("--prefix") + 1
        pkg_root = Path(cmd[prefix_idx])
        pkg_meta = pkg_root / "node_modules" / "@playwright" / "mcp"
        pkg_meta.mkdir(parents=True, exist_ok=True)
        (pkg_meta / "package.json").write_text(
            json.dumps({"name": "@playwright/mcp", "version": "0.0.42", "bin": "cli.js"}),
            encoding="utf-8",
        )
        (pkg_meta / "cli.js").write_text("console.log('mcp');\n", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(local_installer, "_run_subprocess", _fake_run)

    st = local_installer.install_runtime("browser_use", {"mode": "cdp_chrome"})
    assert st["installed"] is True
    assert st["version"] == "0.0.42"
    assert st["mode"] == "cdp_chrome"
    assert calls and calls[0][0] == "/mock/bin/npm"
    assert not any("sudo" in " ".join(c) for c in calls)
    # Ensure temporary staging and cache directories are cleaned up
    base = tmp_path / "runtimes"
    assert [p.name for p in base.iterdir()] == ["browser_use"]
    assert not (base / "browser_use" / ".npm-cache").exists()

    cmd_cdp = local_installer.resolve_stdio_command("browser_use", {"mode": "cdp_chrome"})
    assert cmd_cdp is not None
    assert cmd_cdp["command"] == "/mock/bin/node"
    assert cmd_cdp["args"][1:] == ["--cdp-endpoint=chrome"]

    cmd_explicit_chrome = local_installer.resolve_stdio_command(
        "browser_use", {"mode": "cdp_chrome", "cdp_url": "chrome"}
    )
    assert cmd_explicit_chrome["args"][1:] == ["--cdp-endpoint=chrome"]

    cmd_custom_cdp = local_installer.resolve_stdio_command(
        "browser_use", {"mode": "cdp_chrome", "cdp_url": "http://127.0.0.1:9333"}
    )
    assert cmd_custom_cdp["args"][1:] == ["--cdp-endpoint=http://127.0.0.1:9333"]

    cmd_ext = local_installer.resolve_stdio_command("browser_use", {"mode": "extension"})
    assert cmd_ext["args"][1:] == ["--extension"]

    cmd_iso = local_installer.resolve_stdio_command(
        "browser_use", {"mode": "isolated_profile"}
    )
    assert cmd_iso["args"][1:] == [
        "--browser=chrome",
        "--user-data-dir",
        str((base / "browser_use" / "profile").resolve()),
        "--headless",
    ]

    cmd_iso_headed = local_installer.resolve_stdio_command(
        "browser_use", {"mode": "isolated_profile", "headless": False}
    )
    assert cmd_iso_headed["args"][1:] == [
        "--browser=chrome",
        "--user-data-dir",
        str((base / "browser_use" / "profile").resolve()),
    ]

    uninstalled = local_installer.uninstall_runtime("browser_use")
    assert uninstalled["installed"] is False
    assert not (base / "browser_use").exists()


def test_browser_use_npm_failure_cleans_staging(tmp_path, monkeypatch):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    monkeypatch.setattr(local_installer, "_find_npm", lambda: "/mock/bin/npm")
    monkeypatch.setattr(
        local_installer,
        "_run_subprocess",
        lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="ENOTFOUND"),
    )
    with pytest.raises(local_installer.LocalInstallerError) as exc_info:
        local_installer.install_runtime("browser_use")
    assert exc_info.value.code == "E_INSTALL_FAILED"
    base = tmp_path / "runtimes"
    assert list(base.iterdir()) == []


def test_desktop_use_sha256_verify_macos_codesign_and_checksum_mismatch(tmp_path, monkeypatch):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    good_tar = _build_tar_gz(
        {
            "agent-desktop": (b"#!/bin/sh\necho mcp\n", 0o755),
            "README.txt": (b"docs", 0o644),
        }
    )
    good_sha = hashlib.sha256(good_tar).hexdigest()

    monkeypatch.setattr(local_installer, "_current_platform", lambda: "darwin")
    monkeypatch.setattr(local_installer, "_current_machine", lambda: "arm64")
    monkeypatch.setitem(
        local_installer._DESKTOP_ARTIFACTS,
        "darwin-arm64",
        local_installer.DesktopArtifactSpec(
            platform_key="darwin-arm64",
            asset_name="agent-desktop-test.tar.gz",
            download_url="https://example.invalid/agent-desktop.tar.gz",
            sha256=good_sha,
            binary_name="agent-desktop",
        ),
    )

    # 1) Checksum mismatch -> E_CHECKSUM_MISMATCH + fail-closed staging wipe
    monkeypatch.setattr(local_installer, "_download_bytes", lambda _url: b"corrupt-bytes")
    with pytest.raises(local_installer.LocalInstallerError) as exc_info:
        local_installer.install_runtime("desktop_use")
    assert exc_info.value.code == "E_CHECKSUM_MISMATCH"
    base = tmp_path / "runtimes"
    assert list(base.iterdir()) == []

    # 2) Valid checksum -> extracts, chmod 0o755, strips quarantine, ad-hoc codesign
    monkeypatch.setattr(local_installer, "_download_bytes", lambda _url: good_tar)
    cmds: list[list[str]] = []

    def _fake_sign(cmd, **kwargs):
        cmds.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(local_installer, "_run_subprocess", _fake_sign)

    st = local_installer.install_runtime("desktop_use")
    assert st["installed"] is True
    assert st["requires_permissions"] == ["accessibility", "screen_recording"]
    bin_path = base / "desktop_use" / "bin" / "agent-desktop"
    assert bin_path.is_file()
    assert (stat.S_IMODE(bin_path.stat().st_mode) & 0o755) == 0o755
    # Verify xattr + codesign ran only on binary (not README.txt) and never used sudo
    assert any(c[:3] == ["/usr/bin/xattr", "-d", "com.apple.quarantine"] for c in cmds)
    assert any(c[:3] == ["/usr/bin/codesign", "--sign", "-"] for c in cmds)
    assert not any("README.txt" in " ".join(c) for c in cmds)
    assert not any("sudo" in " ".join(c) for c in cmds)

    stdio_cmd = local_installer.resolve_stdio_command("desktop_use")
    assert stdio_cmd == {
        "command": str(bin_path),
        "args": ["mcp"],
        "cwd": str(base / "desktop_use"),
    }


def test_desktop_use_tar_traversal_and_unsupported_platform(tmp_path, monkeypatch):
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setattr(local_installer, "_RUNTIMES_DIR_OVERRIDE", tmp_path / "runtimes")
    monkeypatch.setattr(local_installer, "_current_platform", lambda: "linux")
    monkeypatch.setattr(local_installer, "_current_machine", lambda: "x86_64")
    assert local_installer.is_platform_supported("desktop_use") is False
    with pytest.raises(local_installer.LocalInstallerError) as exc_info:
        local_installer.install_runtime("desktop_use")
    assert exc_info.value.code == "E_PLATFORM_UNSUPPORTED"

    evil_tar = _build_tar_gz({"../escape": (b"x", 0o755)})
    with pytest.raises(local_installer.LocalInstallerError) as err:
        local_installer._safe_extract_tar_gz(evil_tar, tmp_path / "dest")
    assert err.value.code == "E_INSTALL_FAILED"


def test_runtime_options_validation_and_system_permissions(monkeypatch):
    with pytest.raises(local_installer.LocalInstallerError) as bad_mode:
        local_installer.normalize_runtime_options("browser_use", {"mode": "bogus"})
    assert bad_mode.value.code == "E_INVALID_RUNTIME_OPTION"

    with pytest.raises(local_installer.LocalInstallerError) as bad_url:
        local_installer.normalize_runtime_options(
            "browser_use", {"mode": "cdp_chrome", "cdp_url": "file:///etc/passwd"}
        )
    assert bad_url.value.code == "E_INVALID_RUNTIME_OPTION"

    monkeypatch.setattr(local_installer, "_current_platform", lambda: "linux")
    perms_linux = local_installer.check_system_permissions()
    assert perms_linux == {
        "platform": "linux",
        "accessibility": "unsupported",
        "screen_recording": "unsupported",
    }

    monkeypatch.setattr(local_installer, "_current_platform", lambda: "darwin")
    monkeypatch.setattr(local_installer, "_probe_macos_accessibility", lambda: "granted")
    monkeypatch.setattr(local_installer, "_probe_macos_screen_recording", lambda: "denied")
    assert local_installer.check_system_permissions() == {
        "platform": "darwin",
        "accessibility": "granted",
        "screen_recording": "denied",
    }

    opened_cmds: list[list[str]] = []
    monkeypatch.setattr(
        local_installer,
        "_run_subprocess",
        lambda cmd, **k: (
            opened_cmds.append(list(cmd))
            or subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        ),
    )
    res = local_installer.open_system_permission_pane("screen_recording")
    assert res == {"ok": True, "kind": "screen_recording", "opened": True}
    assert opened_cmds == [
        [
            "/usr/bin/open",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        ]
    ]


def test_additive_migration_adds_runtime_config_json(tmp_path):
    from src.agent_config.store import AgentConfigStore

    db_file = tmp_path / "legacy.db"
    conn = sqlite3.connect(db_file)
    conn.execute(
        """
        CREATE TABLE connector (
            connector_id TEXT PRIMARY KEY,
            server_url TEXT NOT NULL,
            transport TEXT NOT NULL DEFAULT 'streamable_http',
            display_name TEXT,
            status TEXT NOT NULL DEFAULT 'disconnected',
            enabled INTEGER NOT NULL DEFAULT 1,
            preprocess_enabled INTEGER NOT NULL DEFAULT 0,
            scopes_json TEXT,
            last_error TEXT,
            last_synced_at INTEGER,
            source TEXT NOT NULL DEFAULT 'custom_mcp',
            composio_session_id TEXT,
            custom_header_names_json TEXT,
            custom_headers_cipher BLOB,
            stdio_command_json TEXT,
            stdio_env_cipher BLOB,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO connector (connector_id, server_url, created_at, updated_at) "
        "VALUES ('notion', 'https://mcp.notion.com/mcp', 1, 1)"
    )
    conn.commit()
    conn.close()

    store = AgentConfigStore(str(db_file))
    row = store.get_connector("notion")
    assert row is not None and row.runtime_config is None
    store.upsert_connector(
        "browser_use",
        server_url="",
        display_name="Browser Use",
        transport="stdio",
        source="managed_local",
        runtime_config={"mode": "extension"},
    )
    updated = store.update_connector_runtime_config(
        "browser_use", {"mode": "isolated_profile"}
    )
    assert updated.source == "managed_local"
    assert updated.runtime_config == {"mode": "isolated_profile"}


@pytest.mark.asyncio
async def test_managed_local_client_passes_600s_idle_ttl(tmp_path, monkeypatch):
    from src.connectors.client import ConnectorClient
    from src.connectors.registry import ConnectorDef
    from src.connectors.stdio_pool import stdio_pool

    recorded_ttls: list[object] = []

    async def _fake_list_tools(connector_id, *, cmd, env, timeout_seconds, idle_ttl_seconds=None):
        recorded_ttls.append(idle_ttl_seconds)
        return []

    async def _fake_call_tool(
        connector_id, tool_name, arguments, *, cmd, env, timeout_seconds, idle_ttl_seconds=None
    ):
        recorded_ttls.append(idle_ttl_seconds)
        return {"content": [], "isError": False}

    monkeypatch.setattr(stdio_pool, "list_tools", _fake_list_tools)
    monkeypatch.setattr(stdio_pool, "call_tool", _fake_call_tool)

    defn = ConnectorDef(
        connector_id="browser_use",
        server_url="",
        display_name="Browser Use",
        transport="stdio",
        source="managed_local",
        is_custom=False,
        stdio_command={"command": "/mock/node", "args": ["/mock/cli.js", "--isolated"], "cwd": str(tmp_path)},
    )
    client = ConnectorClient("browser_use", interactive=False, definition=defn)
    await client.list_tools_manifest()
    await client.call_tool("browser_snapshot", {})
    assert recorded_ttls == [600.0, 600.0]


def test_browser_use_default_isolated_and_idempotent_db_migration(tmp_path):
    from src.agent_config.store import AgentConfigStore

    db_file = tmp_path / "migrate.db"
    store = AgentConfigStore(str(db_file))
    store.upsert_connector(
        "browser_use",
        server_url="",
        display_name="Browser Use",
        transport="stdio",
        source="managed_local",
        runtime_config={"mode": "cdp_chrome", "cdp_url": "chrome"},
    )
    # Remove one-time migration marker to simulate upgrading from Wave 5 DB
    import sqlite3

    conn = sqlite3.connect(db_file)
    conn.execute("DELETE FROM owner_settings WHERE key = 'browser_use_default_isolated_v1'")
    conn.commit()
    conn.close()

    upgraded = AgentConfigStore(str(db_file))
    row = upgraded.get_connector("browser_use")
    assert row is not None
    assert row.runtime_config == {"mode": "isolated_profile", "headless": True}

    # Explicit user switch back to cdp_chrome must persist across future restarts
    upgraded.update_connector_runtime_config(
        "browser_use", {"mode": "cdp_chrome", "cdp_url": "chrome"}
    )

    reopened = AgentConfigStore(str(db_file))
    row_after = reopened.get_connector("browser_use")
    assert row_after is not None
    assert row_after.runtime_config == {"mode": "cdp_chrome", "cdp_url": "chrome"}

    # Preserve last_imported_* metadata during runtime normalization
    norm = local_installer.normalize_runtime_options(
        "browser_use",
        {"mode": "isolated_profile", "headless": False},
        existing={"mode": "isolated_profile", "last_imported_profile": "Default", "last_imported_count": 12},
    )
    assert norm == {
        "mode": "isolated_profile",
        "headless": False,
        "last_imported_profile": "Default",
        "last_imported_count": 12,
    }
