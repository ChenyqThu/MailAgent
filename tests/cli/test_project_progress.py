"""mailagent project-progress sync tests (PR-5 US-002).

Mock ProjectProgressRunner. Covers:
- --internal-id N --dry-run inline sync
- --all-history --limit 5 target resolution
- 互斥校验
- --sheets 校验
- 非 dry-run + 缺 auth → exit 4
- --first-migration-dry-run 跳过 auth
- failed runner summary → non-zero exit
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, call, patch

from src.project_progress.runner import SyncSummary
from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "project-progress", *args],
    )


def _summary(internal_id: int, status: str = "completed") -> SyncSummary:
    return SyncSummary(
        internal_id=internal_id,
        status=status,
        week_tag="2026-W19",
        total_rows=10,
        enbu_rows=8,
        projects_total=6,
        created=1,
        updated=5,
        dry_run=True,
    )


def _runner(summary: SyncSummary | None = None) -> MagicMock:
    mock_runner = MagicMock()
    mock_runner.find_latest_pending = MagicMock(return_value=52258)
    mock_runner.find_all_history = MagicMock(return_value=[1, 2, 3])
    mock_runner.sync_from_email = AsyncMock(return_value=summary or _summary(52258))
    mock_runner.backfill_project_start = AsyncMock(return_value={
        "total": 1,
        "updated": 1,
        "skipped": 0,
        "missing": 0,
        "failed": 0,
    })
    return mock_runner


class TestProjectProgressSync:
    def test_internal_id_dry_run(self, cli_runner, cli_env, seeded_db):
        mock_runner = _runner()
        with patch(
            "src.cli.commands.project_progress.ProjectProgressRunner",
            return_value=mock_runner,
        ):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "52258", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        mock_runner.sync_from_email.assert_awaited_once_with(
            internal_id=52258,
            force=False,
            dry_run=True,
            sheets=None,
        )
        payload = _xj(result.output)
        assert payload["data"]["action"] == "project-progress-sync"
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["internal_id"] == 52258
        assert payload["data"]["summaries"][0]["internal_id"] == 52258

    def test_all_history_passthrough(self, cli_runner, cli_env, seeded_db):
        mock_runner = _runner()
        mock_runner.sync_from_email = AsyncMock(side_effect=[
            _summary(1),
            _summary(2),
            _summary(3),
        ])
        with patch(
            "src.cli.commands.project_progress.ProjectProgressRunner",
            return_value=mock_runner,
        ):
            result = _invoke(
                cli_runner, "sync", "--all-history", "--limit", "5", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        mock_runner.find_all_history.assert_called_once_with(limit=5)
        mock_runner.sync_from_email.assert_has_awaits([
            call(internal_id=1, force=False, dry_run=True, sheets=None),
            call(internal_id=2, force=False, dry_run=True, sheets=None),
            call(internal_id=3, force=False, dry_run=True, sheets=None),
        ])
        payload = _xj(result.output)
        assert payload["data"]["targets"] == [1, 2, 3]
        assert [s["internal_id"] for s in payload["data"]["summaries"]] == [1, 2, 3]

    def test_mutually_exclusive_internal_id_all_history(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner, "sync",
            "--internal-id", "5", "--all-history", "--dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_invalid_sheets_rejected(self, cli_runner, cli_env, seeded_db):
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
        mock_runner = _runner()
        with patch(
            "src.cli.commands.project_progress.ProjectProgressRunner",
            return_value=mock_runner,
        ):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "52258",
                "--first-migration-dry-run", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        mock_runner.sync_from_email.assert_awaited_once_with(
            internal_id=52258,
            force=False,
            dry_run=True,
            sheets=None,
        )

    def test_runner_failure_returns_exit_1(self, cli_runner, cli_env, seeded_db):
        mock_runner = _runner(_summary(52258, status="failed"))
        with patch(
            "src.cli.commands.project_progress.ProjectProgressRunner",
            return_value=mock_runner,
        ):
            result = _invoke(
                cli_runner, "sync", "--internal-id", "52258", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 1
        payload = _xj(result.output)
        assert payload["data"]["any_failed"] is True
        assert payload["data"]["summaries"][0]["status"] == "failed"
