"""CLI calendar 子命令测试 (RFC v2 §4.10, PR-3 US-007)."""

from __future__ import annotations

import pytest

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


# ============================================================
# expand
# ============================================================

class TestCalendarExpand:
    def test_expand_dry_run_empty(self, cli_runner, cli_env, seeded_db, monkeypatch):
        # seeded_db 没有 recurring_series 表 / 行 → iter 返回空
        # 防御性 patch: 把 sync_store.iter_series_needing_expansion 替成空 iter
        def fake_iter(self, cutoff_iso):
            return iter([])
        from src.mail.sync_store import SyncStore
        monkeypatch.setattr(SyncStore, "iter_series_needing_expansion", fake_iter)
        result = _invoke(cli_runner, "calendar", "expand", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["total_series"] == 0
        assert payload["data"]["total_occurrences_added"] == 0
        assert payload["data"]["horizon_weeks"] == 8

    def test_expand_dry_run_with_stub_series(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        def fake_iter(self, cutoff_iso):
            return iter([{
                "series_uid": "uid-1",
                "master_dtstart": "2026-05-01T09:00:00Z",
                "last_occurrence_dtstart": "2026-05-30T09:00:00Z",
                "notion_page_id": "p-1",
                "subject": "Weekly Sync",
            }])
        from src.mail.sync_store import SyncStore
        monkeypatch.setattr(SyncStore, "iter_series_needing_expansion", fake_iter)
        result = _invoke(cli_runner, "calendar", "expand",
                         "--horizon-weeks", "4", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_series"] == 1
        assert payload["data"]["expanded"][0]["series_uid"] == "uid-1"
        assert payload["data"]["expanded"][0]["occurrences_added"] == 0
        assert payload["data"]["horizon_weeks"] == 4

    def test_expand_no_dry_run_not_implemented(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "calendar", "expand", "--no-dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_IMPLEMENTED"

    def test_expand_invalid_horizon(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "calendar", "expand", "--horizon-weeks", "0",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


# ============================================================
# recurring discover
# ============================================================

class TestCalendarRecurringDiscover:
    def test_discover_with_stub(self, cli_runner, cli_env, seeded_db, monkeypatch):
        async def fake_discover(sync_store, arm, *, since=None, limit=2000):
            return [{
                "internal_id": 53120,
                "subject": "Weekly Sync",
                "sender": "boss@example.com",
                "date": "2026-04-01 09:00:00",
                "uid": "uid-1",
                "rrule": "FREQ=WEEKLY;COUNT=10",
                "method": "REQUEST",
                "dtstart": "2026-04-01T09:00:00+00:00",
            }]
        import scripts.replay_recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "discover_recurring", fake_discover)
        # 防止 AppleScriptArm 真初始化
        from src.mail import applescript_arm
        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "__init__",
            lambda self, *a, **kw: None,
        )
        result = _invoke(cli_runner, "calendar", "recurring", "discover",
                         "--since", "2026-04-01", "--discover-limit", "100",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        # PRD §US-007: series 是 grouped per-uid (不是 per-email rows)
        assert payload["data"]["total_series"] == 1
        assert payload["data"]["matches_total"] == 1
        s = payload["data"]["series"][0]
        assert s["series_uid"] == "uid-1"
        assert s["internal_ids"] == [53120]
        assert s["summary"] == "Weekly Sync"
        assert payload["data"]["since"] == "2026-04-01"
        assert payload["data"]["limit"] == 100
        # PR-3 round-7 fix (codex MAJOR 2): scanned 是实际 SQL 扫描的 synced
        # 邮件数, 不是 discover_limit 近似. seeded fixture 只有 1 个
        # sync_status='synced' 且 date>=2026-04-01 的邮件 (12345, date=2026-05-15)
        assert payload["data"]["scanned"] == 1

    def test_discover_empty(self, cli_runner, cli_env, seeded_db, monkeypatch):
        async def fake_discover(*args, **kwargs):
            return []
        import scripts.replay_recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "discover_recurring", fake_discover)
        from src.mail import applescript_arm
        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "__init__",
            lambda self, *a, **kw: None,
        )
        result = _invoke(cli_runner, "calendar", "recurring", "discover",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_series"] == 0

    def test_discover_invalid_limit(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "calendar", "recurring", "discover",
                         "--discover-limit", "0", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


# ============================================================
# recurring replay
# ============================================================

class TestCalendarRecurringReplay:
    def test_replay_dry_run_single(self, cli_runner, cli_env, seeded_db):
        # RFC §4.10: positional internal_id (not --internal-id flag)
        result = _invoke(
            cli_runner, "calendar", "recurring", "replay",
            "53120", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["total"] == 1
        assert payload["data"]["candidate_internal_ids"] == [53120]

    def test_replay_dry_run_multi(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "calendar", "recurring", "replay",
            "--ids", "53120,53121,53122", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 3
        assert payload["data"]["candidate_internal_ids"] == [53120, 53121, 53122]

    def test_replay_no_ids(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "calendar", "recurring", "replay",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_replay_bad_ids(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "calendar", "recurring", "replay",
            "--ids", "abc,123", "--dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_replay_real_with_stub(self, cli_runner, cli_env, seeded_db, monkeypatch):
        async def fake_replay_one(internal_id, sync_store, arm, meeting_sync):
            return f"page-{internal_id}"

        import scripts.replay_recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "replay_one", fake_replay_one)
        from src.mail import applescript_arm, meeting_sync as meet_mod
        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "__init__",
            lambda self, *a, **kw: None,
        )
        monkeypatch.setattr(
            meet_mod.MeetingInviteSync, "__init__",
            lambda self, *a, **kw: None,
        )
        # reset_stats 仍需可调
        monkeypatch.setattr(
            meet_mod.MeetingInviteSync, "reset_stats",
            lambda self: None,
        )
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "calendar", "recurring", "replay",
            "--ids", "53120,53121", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dry_run"] is False
        assert payload["data"]["succeeded"] == 2
        assert payload["data"]["failed"] == 0
        assert payload["data"]["replayed"][0]["action"] == "replayed"
        assert payload["data"]["replayed"][0]["page_id"] == "page-53120"
