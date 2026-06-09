"""CLI `folder discover / enable / disable` 契约 (多文件夹同步)。

mock list_folders (不连真实 IMAP)，验证 JSON 契约 + davmail 门控 + .env 白名单读写。
"""
from __future__ import annotations

import pytest

from src.mail.backend.imap_client import FolderInfo
from tests.cli.conftest import extract_last_json_object as _extract


def _fake_folders():
    return [
        FolderInfo("INBOX", "INBOX", "/", None, True, False, None, 100),
        FolderInfo("Sent", "Sent", "/", "\\sent", True, False, None, 50),
        FolderInfo("DMS&VvpO9lPRXgM-", "DMS固件发布", "/", None, False, False, None, 728),
        FolderInfo("Jira", "Jira", "/", None, False, False, None, 3458),
        # 含逗号的 modified-UTF7 中文名 (对话历史记录) — 验证 JSON 白名单不拆坏
        FolderInfo("&W,mL3VOGU,KLsF9V-", "对话历史记录", "/", None, False, True, None, 12),
    ]


def _invoke(cli_runner, args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(app, ["--db-path", str(db_path), "folder", *args])


@pytest.fixture
def davmail_env(cli_env, monkeypatch):
    monkeypatch.setenv("MAILAGENT_BACKEND", "davmail")
    monkeypatch.setattr(
        "src.mail.backend.imap_client.list_folders", lambda cfg, with_counts=True: _fake_folders()
    )
    return cli_env


class TestDiscover:
    def test_discover_json_contract(self, cli_runner, davmail_env, seeded_db):
        result = _invoke(cli_runner, ["discover", "-o", "json"], seeded_db)
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["status"] == "success"
        data = payload["data"]
        assert len(data["folders"]) == 5
        names = {f["display_name"] for f in data["folders"]}
        assert "DMS固件发布" in names and "Jira" in names and "对话历史记录" in names
        # 系统标记 + special_use 透传
        inbox = next(f for f in data["folders"] if f["imap_name"] == "INBOX")
        assert inbox["is_system"] is True
        # 白名单空 → 全 is_synced False
        assert all(f["is_synced"] is False for f in data["folders"])
        assert data["whitelist"] == []
        assert "tree" in data

    def test_discover_marks_synced_from_whitelist(self, cli_runner, davmail_env, seeded_db, monkeypatch):
        monkeypatch.setenv("SYNC_FOLDERS", "Jira")
        result = _invoke(cli_runner, ["discover", "-o", "json"], seeded_db)
        payload = _extract(result.output)
        jira = next(f for f in payload["data"]["folders"] if f["imap_name"] == "Jira")
        assert jira["is_synced"] is True
        assert payload["data"]["whitelist"] == ["Jira"]

    def test_discover_gated_on_applescript(self, cli_runner, cli_env, seeded_db, monkeypatch):
        monkeypatch.setenv("MAILAGENT_BACKEND", "applescript")
        result = _invoke(cli_runner, ["discover", "-o", "json"], seeded_db)
        payload = _extract(result.output)
        assert payload["status"] == "error"
        assert "davmail" in (payload.get("error", {}).get("message", "") + result.output).lower()


class TestEnableDisable:
    def test_enable_dry_run_no_write(self, cli_runner, davmail_env, seeded_db):
        result = _invoke(cli_runner, ["enable", "Notion", "--dry-run", "-o", "json"], seeded_db)
        assert result.exit_code == 0, result.output
        data = _extract(result.output)["data"]
        assert data["dry_run"] is True
        assert data["changed"] is False
        assert data["whitelist"] == ["Notion"]

    def test_enable_writes_env(self, cli_runner, davmail_env, seeded_db, tmp_path, monkeypatch):
        env_file = tmp_path / ".env"
        env_file.write_text("MAILAGENT_BACKEND=davmail\n")
        monkeypatch.setenv("MAILAGENT_CONFIG", str(env_file))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, ["enable", "Jira", "-o", "json"], seeded_db)
        assert result.exit_code == 0, result.output
        data = _extract(result.output)["data"]
        assert data["changed"] is True
        assert "Jira" in data["whitelist"]
        assert "SYNC_FOLDERS" in env_file.read_text()
        assert "Jira" in env_file.read_text()

    def test_enable_idempotent_already_enabled(self, cli_runner, davmail_env, seeded_db, monkeypatch):
        monkeypatch.setenv("SYNC_FOLDERS", "Notion")
        result = _invoke(cli_runner, ["enable", "Notion", "-o", "json"], seeded_db)
        data = _extract(result.output)["data"]
        assert data["changed"] is False
        assert data["reason"] == "already enabled"

    def test_disable_removes_from_whitelist(self, cli_runner, davmail_env, seeded_db, tmp_path, monkeypatch):
        env_file = tmp_path / ".env"
        env_file.write_text("MAILAGENT_BACKEND=davmail\nSYNC_FOLDERS=Notion,Jira\n")
        monkeypatch.setenv("SYNC_FOLDERS", "Notion,Jira")
        monkeypatch.setenv("MAILAGENT_CONFIG", str(env_file))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, ["disable", "Notion", "-o", "json"], seeded_db)
        data = _extract(result.output)["data"]
        assert data["changed"] is True
        assert data["whitelist"] == ["Jira"]

    def test_disable_not_in_whitelist(self, cli_runner, davmail_env, seeded_db):
        result = _invoke(cli_runner, ["disable", "Ghost", "-o", "json"], seeded_db)
        data = _extract(result.output)["data"]
        assert data["changed"] is False
        assert data["reason"] == "not in whitelist"

    def test_enable_rejects_system_folder(self, cli_runner, davmail_env, seeded_db, tmp_path, monkeypatch):
        """enable 系统文件夹 (Sent) 被拒绝 (gate)。"""
        env_file = tmp_path / ".env"
        env_file.write_text("MAILAGENT_BACKEND=davmail\n")
        monkeypatch.setenv("MAILAGENT_CONFIG", str(env_file))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, ["enable", "Sent", "-o", "json"], seeded_db)
        payload = _extract(result.output)
        assert payload["status"] == "error"
        assert "系统文件夹" in (payload.get("error", {}).get("message", "") + result.output)
        # 未写入
        assert "Sent" not in env_file.read_text() or "SYNC_FOLDERS" not in env_file.read_text()

    def test_enable_comma_name_writes_json(self, cli_runner, davmail_env, seeded_db, tmp_path, monkeypatch):
        """🔴 含逗号 modified-UTF7 名以 JSON 写 .env, 不被逗号拆坏。"""
        env_file = tmp_path / ".env"
        env_file.write_text("MAILAGENT_BACKEND=davmail\n")
        monkeypatch.setenv("MAILAGENT_CONFIG", str(env_file))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, ["enable", "&W,mL3VOGU,KLsF9V-", "-o", "json"], seeded_db)
        assert result.exit_code == 0, result.output
        data = _extract(result.output)["data"]
        assert data["changed"] is True
        assert data["whitelist"] == ["&W,mL3VOGU,KLsF9V-"]
        # .env 以 JSON 写入, 完整名字保留 (含两个逗号)
        content = env_file.read_text()
        assert "&W,mL3VOGU,KLsF9V-" in content
        # 重新解析回来名字不丢
        from src.mail.backend.davmail_backend import DavMailBackend
        from types import SimpleNamespace
        # 提取 SYNC_FOLDERS 值
        line = next(ln for ln in content.splitlines() if ln.startswith("SYNC_FOLDERS="))
        raw = line.split("=", 1)[1].strip().strip("'\"")
        parsed = DavMailBackend._parse_custom_folders(SimpleNamespace(sync_folders=raw))
        assert parsed == ["&W,mL3VOGU,KLsF9V-"]
