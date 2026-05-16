"""mailagent project-progress sync tests (PR-4 US-006).

Mock subprocess. Covers:
- --internal-id N --dry-run 透传
- --all-history --limit 5 透传
- 互斥校验
- --sheets 校验
- 非 dry-run + 缺 auth → exit 4
- --first-migration-dry-run 跳过 auth
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch


from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "project-progress", *args],
    )


def _fake_run(returncode=0):
    captured = {"args": None}

    def _r(cmd, **kwargs):
        captured["args"] = cmd
        return SimpleNamespace(returncode=returncode, stdout="ok", stderr="")

    return _r, captured


class TestProjectProgressSync:
    def test_internal_id_dry_run(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.project_progress.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "52258", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["action"] == "project-progress-sync"
        assert payload["data"]["internal_id"] == 52258
        cmd = cap["args"]
        assert "--internal-id" in cmd
        assert "52258" in cmd
        assert "--dry-run" in cmd

    def test_all_history_passthrough(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.project_progress.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync", "--all-history", "--limit", "5", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--all-history" in cmd
        assert "--limit" in cmd
        assert "5" in cmd

    def test_mutually_exclusive_internal_id_all_history(
        self, cli_runner, cli_env, seeded_db,
    ):
        run, _ = _fake_run(0)
        with patch("src.cli.commands.project_progress.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync",
                "--internal-id", "5", "--all-history", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_invalid_sheets_rejected(self, cli_runner, cli_env, seeded_db):
        run, _ = _fake_run(0)
        with patch("src.cli.commands.project_progress.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "1", "--sheets", "bogus",
                "--dry-run", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 2

    def test_non_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        run, _ = _fake_run(0)
        with patch("src.cli.commands.project_progress.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "52258",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4

    def test_first_migration_dry_run_skips_auth(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        run, cap = _fake_run(0)
        with patch("src.cli.commands.project_progress.subprocess.run", run):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "52258",
                "--first-migration-dry-run", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--first-migration-dry-run" in cmd
