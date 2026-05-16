"""mailagent init * tests (PR-4 US-007).

Mock subprocess. Covers:
- fetch-cache (--inbox-count) → action=fetch-cache 透传
- analyze --skip-fetch 透传
- fix-properties --yes 缺 auth → exit 4
- sync-new auth 校验
- all --yes 烟测 (returncode 0)
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch


from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "init", *args],
    )


def _fake_run(returncode=0):
    captured = {"args": None}

    def _r(cmd, **kwargs):
        captured["args"] = cmd
        return SimpleNamespace(returncode=returncode, stdout="OK", stderr="")

    return _r, captured


class TestInitFetchCache:
    def test_fetch_cache_smoke(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "fetch-cache", "--inbox-count", "100",
                "--sent-count", "20", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["action"] == "init-fetch-cache"
        cmd = cap["args"]
        assert "--action" in cmd and "fetch-cache" in cmd
        assert "--inbox-count" in cmd and "100" in cmd
        assert "--sent-count" in cmd and "20" in cmd


class TestInitAnalyze:
    def test_skip_fetch_passthrough(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "analyze", "--skip-fetch",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--action" in cmd and "analyze" in cmd
        assert "--skip-fetch" in cmd


class TestInitWriteActions:
    """fix-properties / fix-critical / update-parents / sync-new / all 是写命令."""

    def test_fix_properties_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        run, _ = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "fix-properties", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4

    def test_fix_critical_with_unsafe_writes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, cap = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "fix-critical", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "fix-critical" in cmd
        assert "--yes" in cmd

    def test_update_parents_action_name_mapping(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """update-parents CLI 名 → update-all-parents script 名."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, cap = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "update-parents", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "update-all-parents" in cmd

    def test_sync_new_yes_passthrough(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, cap = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync-new", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "sync-new" in cmd

    def test_init_all_smoke(self, cli_runner, cli_env, seeded_db, monkeypatch):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, cap = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "all", "--yes",
                "--inbox-count", "100",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--action" in cmd and "all" in cmd
        assert "--inbox-count" in cmd and "100" in cmd
