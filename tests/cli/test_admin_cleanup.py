"""admin cleanup-syncstore / cleanup-duplicates / repair-parents tests (PR-4 US-009)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch


from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", *args],
    )


def _fake_run(returncode=0):
    cap = {"args": None}

    def _r(cmd, **kwargs):
        cap["args"] = cmd
        return SimpleNamespace(returncode=returncode, stdout="ok", stderr="")

    return _r, cap


class TestCleanupSyncStore:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "cleanup-syncstore",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["action"] == "cleanup-syncstore"
        assert payload["data"]["dry_run"] is True
        assert "--dry-run" in cap["args"]

    def test_no_dry_run_requires_yes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, _ = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "cleanup-syncstore", "--no-dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_no_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        run, _ = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "cleanup-syncstore", "--no-dry-run", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4


class TestCleanupDuplicates:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "cleanup-duplicates",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["action"] == "cleanup-duplicates"
        # uses cleanup_duplicate_message_ids.py
        assert "cleanup_duplicate_message_ids.py" in " ".join(cap["args"])


class TestRepairParents:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "repair-parents",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["action"] == "repair-parents"
        cmd = cap["args"]
        assert "--action" in cmd and "repair-parents" in cmd
        assert "--dry-run" in cmd

    def test_thread_id_passthrough(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "repair-parents", "--thread-id", "<thread@x>",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--thread-id" in cmd
        assert "<thread@x>" in cmd
