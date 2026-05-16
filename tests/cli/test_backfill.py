"""mailagent backfill body / derivatives tests (PR-4 US-005).

Mock subprocess.run so tests don't actually invoke scripts/.

Covers:
- backfill body --dry-run (mock returncode 0)
- backfill body --since-date / --limit 透传
- backfill body --all 与 --since-date 互斥
- backfill body 缺 filter 报错
- backfill body 非 dry-run + 缺 auth → exit 4
- backfill derivatives --dry-run
- backfill derivatives --internal-id 透传
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch


from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "backfill", *args],
    )


def _fake_run_factory(returncode=0, stdout="", stderr=""):
    captured = {"args": None}

    def _run(cmd, **kwargs):
        captured["args"] = cmd
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    return _run, captured


# ============================================================
# backfill body
# ============================================================

class TestBackfillBody:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run_factory(returncode=0, stdout="OK\n")
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "body", "--dry-run", "--limit", "5",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["action"] == "backfill-body"
        assert payload["data"]["script_returncode"] == 0
        # --dry-run 和 --limit 透传到 subprocess
        cmd = cap["args"]
        assert "--dry-run" in cmd
        assert "--limit" in cmd
        assert "5" in cmd

    def test_since_date_passthrough(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run_factory(returncode=0)
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "body", "--dry-run",
                "--since-date", "2026-03-01",
                "--until-date", "2026-03-31",
                "--mailbox", "收件箱",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--since-date" in cmd
        assert "2026-03-01" in cmd
        assert "--until-date" in cmd
        assert "2026-03-31" in cmd
        assert "--mailbox" in cmd
        assert "收件箱" in cmd

    def test_all_mutually_exclusive_with_filters(
        self, cli_runner, cli_env, seeded_db,
    ):
        run, _ = _fake_run_factory()
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "body", "--all", "--since-date", "2026-03-01",
                "-o", "json", "--dry-run",
                db_path=seeded_db,
            )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_no_filter_no_all_rejects(
        self, cli_runner, cli_env, seeded_db,
    ):
        run, _ = _fake_run_factory()
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "body", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert "filter" in payload["error"]["message"].lower() or "all" in payload["error"]["message"].lower()

    def test_non_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        run, _ = _fake_run_factory()
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "body", "--limit", "5",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"

    def test_subprocess_non_zero_propagates(
        self, cli_runner, cli_env, seeded_db,
    ):
        run, _ = _fake_run_factory(returncode=3, stderr="boom")
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "body", "--dry-run", "--limit", "1",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 3


# ============================================================
# backfill derivatives
# ============================================================

class TestBackfillDerivatives:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run_factory(returncode=0)
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "derivatives", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["action"] == "backfill-derivatives"
        cmd = cap["args"]
        assert "--dry-run" in cmd

    def test_internal_id_passthrough(self, cli_runner, cli_env, seeded_db):
        run, cap = _fake_run_factory(returncode=0)
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "derivatives", "--internal-id", "53677", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        cmd = cap["args"]
        assert "--internal-id" in cmd
        assert "53677" in cmd

    def test_non_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        run, _ = _fake_run_factory()
        with patch("src.cli.commands.backfill.subprocess.run", run):
            result = _invoke(
                cli_runner, "derivatives",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4
