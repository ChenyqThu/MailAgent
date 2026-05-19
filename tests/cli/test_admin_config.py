"""tests/cli/test_admin_config.py — Sprint 15 Stage 3.

`mailagent admin config show / get / set` 覆盖:
- show 列全部 + 敏感字段脱敏
- show --key 单字段
- show --key invalid → E_NOT_FOUND
- show / get --show-secrets 需要 auth
- get <key>
- set 类型 coerce (bool / int / float / str)
- set 类型 invalid → E_INVALID_ARG
- set dry_run 不写 .env
- set 真写 .env (atomic, 注释保留)
- set unknown key → E_NOT_FOUND
- set auth required (写命令)
- set 敏感字段返回 envelope 中 mask
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.cli.conftest import extract_last_json_object as _extract


def _invoke_config(cli_runner, *args, db_path, config_path=None):
    from src.cli.main import app

    base = ["--db-path", str(db_path)]
    if config_path:
        base.extend(["--config", str(config_path)])
    base.extend(["admin", "config", *args])
    return cli_runner.invoke(app, base)


@pytest.fixture
def env_file(tmp_path):
    """造一个 .env 文件含已有变量和注释."""
    p = tmp_path / ".env"
    p.write_text(
        "# Critical user identity (must keep)\n"
        "NOTION_TOKEN=test-token-original\n"
        "EMAIL_DATABASE_ID=test-db\n"
        "USER_EMAIL=test@example.com\n"
        "MAIL_ACCOUNT_NAME=test\n"
        "\n"
        "# Service runtime flags\n"
        "LOG_LEVEL=INFO\n"
        "SYNC_START_DATE=2026-01-01\n"
    )
    return p


# ============================================================
# show
# ============================================================

class TestShow:
    def test_show_all_lists_settings(self, cli_runner, cli_env, seeded_db):
        result = _invoke_config(
            cli_runner, "show", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["status"] == "success"
        assert "settings" in payload["data"]
        assert payload["data"]["count"] > 10  # 有很多字段
        # 几个关键字段都应该在
        keys = payload["data"]["settings"].keys()
        assert "notion_token" in keys
        assert "sync_mailboxes" in keys
        assert "log_level" in keys

    def test_show_masks_sensitive(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """默认 notion_token / 含 secret/password 字段被脱敏."""
        monkeypatch.setenv("NOTION_TOKEN", "supersecrettoken12345")
        result = _invoke_config(
            cli_runner, "show", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        token_info = payload["data"]["settings"]["notion_token"]
        assert token_info["sensitive"] is True
        # value 应该被 mask
        assert "supersecret" not in str(token_info["value"])
        assert "***" in str(token_info["value"])

    def test_show_key_single(self, cli_runner, cli_env, seeded_db):
        result = _invoke_config(
            cli_runner, "show", "--key", "log_level",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["key"] == "log_level"
        assert payload["data"]["env_var"] == "LOG_LEVEL"
        assert payload["data"]["sensitive"] is False

    def test_show_key_unknown(self, cli_runner, cli_env, seeded_db):
        result = _invoke_config(
            cli_runner, "show", "--key", "no_such_field",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 1
        payload = _extract(result.output)
        assert payload["status"] == "error"
        assert payload["error"]["code"] == "E_NOT_FOUND"


# ============================================================
# get
# ============================================================

class TestGet:
    def test_get_single_field(self, cli_runner, cli_env, seeded_db):
        result = _invoke_config(
            cli_runner, "get", "log_level", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["key"] == "log_level"
        assert payload["data"]["env_var"] == "LOG_LEVEL"

    def test_get_unknown(self, cli_runner, cli_env, seeded_db):
        result = _invoke_config(
            cli_runner, "get", "no_such_field",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 1
        payload = _extract(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_get_sensitive_masked(self, cli_runner, cli_env, seeded_db, monkeypatch):
        monkeypatch.setenv("NOTION_TOKEN", "supersecrettoken12345")
        result = _invoke_config(
            cli_runner, "get", "notion_token", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert "supersecret" not in str(payload["data"]["value"])
        assert "***" in str(payload["data"]["value"])


# ============================================================
# set
# ============================================================

class TestSet:
    @pytest.fixture
    def _unauth_writes_on(self, monkeypatch):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")

    def test_set_dry_run_no_write(self, cli_runner, cli_env, seeded_db, env_file):
        result = _invoke_config(
            cli_runner, "set", "log_level", "DEBUG", "--dry-run",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["new_value"] == "DEBUG"
        # .env 未被修改
        assert "LOG_LEVEL=INFO" in env_file.read_text()

    def test_set_unknown_field(self, cli_runner, cli_env, seeded_db, env_file):
        result = _invoke_config(
            cli_runner, "set", "no_such_field", "X", "--dry-run",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 1
        payload = _extract(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_set_writes_env_file(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        result = _invoke_config(
            cli_runner, "set", "log_level", "DEBUG",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["dry_run"] is False
        assert payload["data"]["new_value"] == "DEBUG"
        assert payload["data"]["restart_required"] is True
        content = env_file.read_text()
        assert "LOG_LEVEL=" in content
        assert "DEBUG" in content
        # 注释保留
        assert "# Critical user identity" in content
        assert "# Service runtime flags" in content

    def test_set_preserves_other_vars(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        original_email = "USER_EMAIL=test@example.com"
        result = _invoke_config(
            cli_runner, "set", "log_level", "DEBUG",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0
        # 其他变量原封不动
        assert original_email in env_file.read_text()

    def test_set_bool_coerce_true(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        result = _invoke_config(
            cli_runner, "set", "mailagent_outbox_enabled", "true",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["new_value"] is True

    def test_set_bool_coerce_yes(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        result = _invoke_config(
            cli_runner, "set", "feishu_notify_enabled", "yes",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert payload["data"]["new_value"] is True

    def test_set_bool_coerce_invalid(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        result = _invoke_config(
            cli_runner, "set", "mailagent_outbox_enabled", "maybe-not",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 2
        payload = _extract(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_set_int_coerce(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        result = _invoke_config(
            cli_runner, "set", "mailagent_outbox_poll_interval_sec", "10",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert payload["data"]["new_value"] == 10

    def test_set_int_coerce_invalid(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        result = _invoke_config(
            cli_runner, "set", "mailagent_outbox_poll_interval_sec", "abc",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 2
        payload = _extract(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_set_sensitive_masks_in_response(
        self, cli_runner, cli_env, seeded_db, env_file, _unauth_writes_on,
    ):
        """敏感字段的 new_value 在 envelope 中 mask, 不泄漏到 log."""
        result = _invoke_config(
            cli_runner, "set", "notion_token", "very-secret-value-123",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert payload["data"]["sensitive"] is True
        # mask: 不应包含原值的中间部分
        assert "very-secret" not in str(payload["data"]["new_value"])
        assert "***" in str(payload["data"]["new_value"])

    def test_set_dry_run_skips_auth(
        self, cli_runner, cli_env, seeded_db, env_file, monkeypatch,
    ):
        """dry-run 跳过 auth 检查."""
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")  # 关掉
        result = _invoke_config(
            cli_runner, "set", "log_level", "DEBUG", "--dry-run",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 0, result.output

    def test_set_requires_auth_when_not_dry_run(
        self, cli_runner, cli_env, seeded_db, env_file, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")
        result = _invoke_config(
            cli_runner, "set", "log_level", "DEBUG",
            "-o", "json", db_path=seeded_db, config_path=env_file,
        )
        assert result.exit_code == 4
        payload = _extract(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"
