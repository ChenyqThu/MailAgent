"""calendar expand CLI tests."""

from __future__ import annotations

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def test_dry_run_default(cli_runner, cli_env, seeded_db, monkeypatch):
    from src.mail.sync_store import SyncStore

    def fake_iter(self, cutoff_iso):
        return iter(
            [
                {
                    "series_uid": "uid-1",
                    "master_dtstart": "2026-05-01T09:00:00+00:00",
                    "last_occurrence_dtstart": "2026-05-08T09:00:00+00:00",
                    "notion_page_id": "page-1",
                    "subject": "Weekly Sync",
                }
            ]
        )

    monkeypatch.setattr(SyncStore, "iter_series_needing_expansion", fake_iter)

    result = _invoke(cli_runner, "calendar", "expand", "-o", "json", db_path=seeded_db)

    assert result.exit_code == 0, result.output
    payload = _last_json(result.output)
    assert payload["data"]["mode"] == "dry_run"
    assert payload["data"]["dry_run"] is True
    assert payload["data"]["total_series"] == 1
    assert payload["data"]["expanded"][0]["series_uid"] == "uid-1"


def test_horizon_weeks_zero_rejected(cli_runner, cli_env, seeded_db):
    result = _invoke(
        cli_runner,
        "calendar",
        "expand",
        "--horizon-weeks",
        "0",
        "-o",
        "json",
        db_path=seeded_db,
    )

    assert result.exit_code == 2, result.output
    payload = _last_json(result.output)
    assert payload["error"]["code"] == "E_INVALID_ARG"
    assert "--horizon-weeks must be > 0" in payload["error"]["message"]


def test_dry_run_no_series(cli_runner, cli_env, seeded_db, monkeypatch):
    from src.mail.sync_store import SyncStore

    monkeypatch.setattr(
        SyncStore,
        "iter_series_needing_expansion",
        lambda self, cutoff_iso: iter([]),
    )

    result = _invoke(cli_runner, "calendar", "expand", "-o", "json", db_path=seeded_db)

    assert result.exit_code == 0, result.output
    payload = _last_json(result.output)
    assert payload["data"]["mode"] == "dry_run"
    assert payload["data"]["expanded"] == []
    assert payload["data"]["total_series"] == 0


def test_real_run_no_yes_fine(cli_runner, cli_env, seeded_db, monkeypatch):
    async def fake_run(sync_store, meeting_sync, horizon_weeks, *, dry_run=False):
        return {"series_scanned": 0, "occurrences_synced": 0, "errors": []}

    import src.calendar_notion.expansion as expansion_mod
    import src.cli.commands.calendar as calendar_cmd

    monkeypatch.setattr(expansion_mod, "run_expansion_tick", fake_run)
    monkeypatch.setattr(calendar_cmd, "_build_meeting_sync", lambda sync_store: object())

    result = _invoke(
        cli_runner,
        "calendar",
        "expand",
        "--no-dry-run",
        "-o",
        "json",
        db_path=seeded_db,
    )

    assert result.exit_code == 0, result.output
    payload = _last_json(result.output)
    assert payload["data"]["mode"] == "inline"
    assert payload["data"]["series_scanned"] == 0
    assert payload["data"]["occurrences_synced"] == 0


def test_real_run_horizon_weeks_4_mocked(cli_runner, cli_env, seeded_db, monkeypatch):
    async def fake_run(sync_store, meeting_sync, horizon_weeks, *, dry_run=False):
        assert horizon_weeks == 4
        assert dry_run is False
        return {"series_scanned": 2, "occurrences_synced": 5, "errors": []}

    import src.calendar_notion.expansion as expansion_mod
    import src.cli.commands.calendar as calendar_cmd

    monkeypatch.setattr(expansion_mod, "run_expansion_tick", fake_run)
    monkeypatch.setattr(calendar_cmd, "_build_meeting_sync", lambda sync_store: object())

    result = _invoke(
        cli_runner,
        "calendar",
        "expand",
        "--no-dry-run",
        "--horizon-weeks",
        "4",
        "-o",
        "json",
        db_path=seeded_db,
    )

    assert result.exit_code == 0, result.output
    payload = _last_json(result.output)
    assert payload["data"]["mode"] == "inline"
    assert payload["data"]["horizon_weeks"] == 4
    assert payload["data"]["series_scanned"] == 2
    assert payload["data"]["occurrences_synced"] == 5
    assert payload["data"]["errors"] == []


def test_error_handling(cli_runner, cli_env, seeded_db, monkeypatch):
    async def fake_run(sync_store, meeting_sync, horizon_weeks, *, dry_run=False):
        raise RuntimeError("boom")

    import src.calendar_notion.expansion as expansion_mod
    import src.cli.commands.calendar as calendar_cmd

    monkeypatch.setattr(expansion_mod, "run_expansion_tick", fake_run)
    monkeypatch.setattr(calendar_cmd, "_build_meeting_sync", lambda sync_store: object())

    result = _invoke(
        cli_runner,
        "calendar",
        "expand",
        "--no-dry-run",
        "-o",
        "json",
        db_path=seeded_db,
    )

    assert result.exit_code == 1, result.output
    payload = _last_json(result.output)
    assert payload["error"]["code"] == "E_INTERNAL"
    assert "boom" in payload["error"]["message"]
