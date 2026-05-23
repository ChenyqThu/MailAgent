"""CLI calendar 子命令测试 (RFC v2 §4.10, PR-3 US-007)."""

from __future__ import annotations

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _patch_cli_backend(monkeypatch):
    """Stub CliContext.backend → fake backend with .arm = no-op object.

    Phase 0.1 fix 把 calendar 子命令从硬编码 ``AppleScriptArm()`` 改成
    ``cli.backend.arm`` (走 factory 尊重 MAILAGENT_BACKEND env). 测试环境下
    factory 会 probe DavMail IMAP @ 127.0.0.1:1143 超时 (10s); 用此 helper
    短路 backend property 返回 mock, ``arm`` 字段是占位 object (被 stub 化的
    discover_recurring/replay_one 接收但不实际调用).
    """
    class _FakeBackend:
        arm = object()

    from src.cli import context as _ctx_mod
    monkeypatch.setattr(
        _ctx_mod.CliContext,
        "backend",
        property(lambda self: _FakeBackend()),
    )


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

    def test_expand_no_dry_run_inline(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        async def fake_run(sync_store, meeting_sync, horizon_weeks, *, dry_run=False):
            return {"series_scanned": 0, "occurrences_synced": 0, "errors": []}

        import src.calendar_notion.expansion as expansion_mod
        import src.cli.commands.calendar as calendar_cmd
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        monkeypatch.setattr(expansion_mod, "run_expansion_tick", fake_run)
        monkeypatch.setattr(calendar_cmd, "_build_meeting_sync", lambda sync_store: object())

        result = _invoke(cli_runner, "calendar", "expand", "--no-dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["series_scanned"] == 0

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
        # Phase 1.5: discover_recurring 签名变 (drop arm 参数, 改读 calendar_event 表).
        async def fake_discover(sync_store, *, since=None, limit=2000):
            return [{
                "internal_id": 53120,
                "subject": "Weekly Sync",
                "sender": "boss@example.com",
                "date": "2026-04-01T09:00:00+00:00",
                "uid": "uid-1",
                "rrule": "FREQ=WEEKLY;COUNT=10",
                "method": "REQUEST",
                "dtstart": "2026-04-01T09:00:00+00:00",
            }]
        import src.calendar_notion.recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "discover_recurring", fake_discover)
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
        # Phase 1.5: scanned 现在 = calendar_event rows with rrule!='' 数量.
        # seeded_db 没 seed calendar_event 行, 所以 = 0.
        assert payload["data"]["scanned"] == 0

    def test_discover_empty(self, cli_runner, cli_env, seeded_db, monkeypatch):
        async def fake_discover(*args, **kwargs):
            return []
        import src.calendar_notion.recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "discover_recurring", fake_discover)
        # Phase 1.5: discover 不再触发 backend factory, 不需要 _patch_cli_backend
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

    def test_discover_reads_calendar_event_table(
        self, cli_runner, cli_env, seeded_db,
    ):
        """Phase 1.5 integration: 真 calendar_event seed, 不 mock discover_recurring."""
        from datetime import datetime, timezone, timedelta
        from src.calendar_notion.caldav_reader import CalendarEvent
        from src.calendar_sync import CalendarEventRepository

        repo = CalendarEventRepository(str(seeded_db))
        # 2 个 recurring (uid-1 master + uid-1 occurrence), 1 个单次 (uid-2)
        start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
        master = CalendarEvent(
            summary="Weekly sync",
            start=start, end=start + timedelta(hours=1),
            ical_uid="uid-weekly",
            rrule="FREQ=WEEKLY;COUNT=10",
            organizer="boss@example.com",
            calendar_name="Personal",
        )
        occ = CalendarEvent(
            summary="Weekly sync (rescheduled)",
            start=start + timedelta(weeks=1, hours=1),
            end=start + timedelta(weeks=1, hours=2),
            ical_uid="uid-weekly",
            recurrence_id=(start + timedelta(weeks=1)).isoformat(),
            rrule="FREQ=WEEKLY;COUNT=10",  # occurrence 也带 rrule 字段拷贝
            organizer="boss@example.com",
            calendar_name="Personal",
        )
        single = CalendarEvent(
            summary="One-off",
            start=start + timedelta(days=3), end=start + timedelta(days=3, hours=1),
            ical_uid="uid-single",
            rrule="",  # 无 RRULE — 不该出现在 discover 结果
            organizer="someone@example.com",
            calendar_name="Personal",
        )
        repo.upsert_from_caldav_event(master, source="caldav")
        repo.upsert_from_caldav_event(occ, source="caldav")
        repo.upsert_from_caldav_event(single, source="caldav")

        result = _invoke(cli_runner, "calendar", "recurring", "discover",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)

        # uid-weekly grouped → 1 series; uid-single 不带 rrule → 不入结果
        assert payload["data"]["total_series"] == 1, payload["data"]
        assert payload["data"]["matches_total"] == 2  # master + occurrence 两行
        s = payload["data"]["series"][0]
        assert s["series_uid"] == "uid-weekly"
        assert s["summary"] == "Weekly sync"
        assert "FREQ=WEEKLY" in (s["rrule"] or "")
        # scanned 也应该跟 matches_total 一致 (2 rows with rrule!='')
        assert payload["data"]["scanned"] == 2


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

        import src.calendar_notion.recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "replay_one", fake_replay_one)
        from src.mail import meeting_sync as meet_mod
        _patch_cli_backend(monkeypatch)
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


# ============================================================
# Phase 2 §2.1 — events / today / week / event-get / sync-status / sync-now
# ============================================================

from datetime import datetime, timedelta, timezone


def _seed_calendar_event(
    db_path: str,
    *,
    ical_uid: str = "uid-test-1",
    summary: str = "Test event",
    calendar_name: str = "Personal",
    source: str = "caldav",
    start: datetime = None,
    duration_hours: float = 1.0,
    rrule: str = "",
    response_status: str = "",
    organizer: str = "",
) -> int:
    """Seed 一个 calendar_event row, 返回 id."""
    from src.calendar_notion.caldav_reader import CalendarEvent
    from src.calendar_sync import CalendarEventRepository

    if start is None:
        start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
    ev = CalendarEvent(
        summary=summary, start=start, end=start + timedelta(hours=duration_hours),
        ical_uid=ical_uid, calendar_name=calendar_name,
        rrule=rrule, response_status=response_status, organizer=organizer,
    )
    repo = CalendarEventRepository(db_path)
    return repo.upsert_from_caldav_event(ev, source=source)


class TestCalendarEvents:
    def test_empty_db_returns_zero(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "calendar", "events", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 0
        assert payload["data"]["events"] == []
        assert "window" in payload["data"]
        assert "filters" in payload["data"]

    def test_seeded_single_event_in_today_window(self, cli_runner, cli_env, seeded_db):
        # 用今天作 dtstart 保证落 default 窗口
        today = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
        _seed_calendar_event(str(seeded_db), start=today, ical_uid="today-evt",
                             summary="Stand-up")
        result = _invoke(cli_runner, "calendar", "events", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 1
        evt = payload["data"]["events"][0]
        assert evt["ical_uid"] == "today-evt"
        assert evt["summary"] == "Stand-up"
        assert evt["is_recurrence_instance"] is False
        assert evt["source"] == "caldav"

    def test_window_filter_excludes_outside(self, cli_runner, cli_env, seeded_db):
        # Seed 2025 年事件, 用 2026-5/--from --to 窗口
        _seed_calendar_event(
            str(seeded_db),
            ical_uid="old-event",
            start=datetime(2025, 1, 1, 9, 0, tzinfo=timezone.utc),
        )
        result = _invoke(
            cli_runner, "calendar", "events",
            "--from", "2026-05-01", "--to", "2026-06-01", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 0

    def test_rrule_expanded_in_wide_window(self, cli_runner, cli_env, seeded_db):
        _seed_calendar_event(
            str(seeded_db),
            ical_uid="recur",
            start=datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc),
            rrule="FREQ=WEEKLY;COUNT=4",
        )
        result = _invoke(
            cli_runner, "calendar", "events",
            "--from", "2026-05-01", "--to", "2026-07-01", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 4
        for ev in payload["data"]["events"]:
            assert ev["is_recurrence_instance"] is True

    def test_no_expand_returns_master_only(self, cli_runner, cli_env, seeded_db):
        _seed_calendar_event(
            str(seeded_db),
            ical_uid="recur",
            start=datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc),
            rrule="FREQ=WEEKLY;COUNT=4",
        )
        result = _invoke(
            cli_runner, "calendar", "events", "--no-expand",
            "--from", "2026-05-01", "--to", "2026-07-01", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 1
        assert payload["data"]["events"][0]["is_recurrence_instance"] is False
        assert payload["data"]["filters"]["expand_recurrences"] is False

    def test_calendar_name_filter(self, cli_runner, cli_env, seeded_db):
        today = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
        _seed_calendar_event(str(seeded_db), ical_uid="a",
                             calendar_name="Work", start=today)
        _seed_calendar_event(str(seeded_db), ical_uid="b",
                             calendar_name="Personal", start=today)
        result = _invoke(
            cli_runner, "calendar", "events",
            "--calendar", "Work", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 1
        assert payload["data"]["events"][0]["calendar_name"] == "Work"

    def test_source_filter(self, cli_runner, cli_env, seeded_db):
        today = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
        _seed_calendar_event(str(seeded_db), ical_uid="caldav-1",
                             source="caldav", start=today)
        _seed_calendar_event(str(seeded_db), ical_uid="email-1",
                             source="email_ics", start=today)
        result = _invoke(
            cli_runner, "calendar", "events",
            "--source", "caldav", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 1
        assert payload["data"]["events"][0]["ical_uid"] == "caldav-1"

    def test_invalid_source_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "calendar", "events",
            "--source", "bogus", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_invalid_window_rejected(self, cli_runner, cli_env, seeded_db):
        # --to < --from
        result = _invoke(
            cli_runner, "calendar", "events",
            "--from", "2026-06-01", "--to", "2026-05-01",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_today_command(self, cli_runner, cli_env, seeded_db):
        today = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
        _seed_calendar_event(str(seeded_db), start=today)
        # 历史事件不该出现
        _seed_calendar_event(
            str(seeded_db),
            ical_uid="old",
            start=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        result = _invoke(cli_runner, "calendar", "today", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 1

    def test_week_command(self, cli_runner, cli_env, seeded_db):
        # 今天 + 3 天后都应该在 7 天窗口
        today = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
        _seed_calendar_event(str(seeded_db), ical_uid="now", start=today)
        _seed_calendar_event(
            str(seeded_db), ical_uid="3d", start=today + timedelta(days=3),
        )
        result = _invoke(cli_runner, "calendar", "week", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 2


class TestCalendarEventGet:
    def test_get_master(self, cli_runner, cli_env, seeded_db):
        eid = _seed_calendar_event(str(seeded_db), ical_uid="get-me")
        result = _invoke(
            cli_runner, "calendar", "event-get", "get-me",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        ev = payload["data"]["event"]
        assert ev["id"] == eid
        assert ev["ical_uid"] == "get-me"
        assert ev["recurrence_id"] is None
        assert "dtstart_iso" in ev
        assert "dtend_iso" in ev

    def test_get_missing_returns_not_found(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "calendar", "event-get", "nope-uid",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code != 0
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_get_invalid_source_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "calendar", "event-get", "uid",
            "--source", "bogus", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestCalendarSyncStatus:
    def test_empty_state(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "calendar", "sync-status",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 0
        assert payload["data"]["calendars"] == []
        assert isinstance(payload["data"]["worker_enabled"], bool)

    def test_listed_after_upsert(self, cli_runner, cli_env, seeded_db):
        from src.calendar_sync import CalendarEventRepository
        repo = CalendarEventRepository(str(seeded_db))
        repo.upsert_sync_state(
            "Personal", ctag="ctag-1", sync_token="tok-1", full_sync=True,
        )
        result = _invoke(cli_runner, "calendar", "sync-status",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 1
        c = payload["data"]["calendars"][0]
        assert c["calendar_name"] == "Personal"
        assert c["ctag"] == "ctag-1"
        assert c["sync_token"] == "tok-1"
        assert c["last_full_sync_at_iso"] is not None
        assert c["last_error"] is None


class TestCalendarSyncNow:
    def test_requires_auth(self, cli_runner, cli_env, seeded_db, monkeypatch):
        # 默认 require_auth 在 cli_env 下被关掉; 主路径已测
        # 这里 verify auth flow 被走过 (env 缺 token → reject)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "expected-key")
        # CLI 不传 --api-key → 应被拒
        result = _invoke(cli_runner, "calendar", "sync-now",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code != 0
        payload = _last_json(result.output)
        # E_AUTH_REQUIRED 或类似
        assert "error" in payload

    def test_full_mode_with_stubbed_reader(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """stub CalDAVReader → 模拟一次 full sync 跑通."""
        from src.calendar_notion.caldav_reader import CalendarEvent, CalDAVReader
        from src.cli.commands import calendar as cal_cmd

        # 1. 让 list_calendar_names_for_sync 返单 calendar
        # 2. list_events_with_full_detail 返 1 个 event
        # 3. get_collection_ctag 返 fake ctag
        stub_event = CalendarEvent(
            summary="Stubbed", start=datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc),
            end=datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc),
            ical_uid="stub-uid-1", calendar_name="StubCal",
        )
        monkeypatch.setattr(
            CalDAVReader, "list_calendar_names_for_sync",
            lambda self: ["StubCal"],
        )
        monkeypatch.setattr(
            CalDAVReader, "list_events_with_full_detail",
            lambda self, ws, we, *, calendar_name=None: [stub_event],
        )
        monkeypatch.setattr(
            CalDAVReader, "get_collection_ctag",
            lambda self, cal: "fake-ctag-1",
        )
        # __init__ 不需要 stub — 不调 caldav lib 直到 _connect

        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "calendar", "sync-now", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_calendars"] == 1
        assert payload["data"]["mode"] == "full"
        r = payload["data"]["results"][0]
        assert r["calendar_name"] == "StubCal"
        assert r["mode"] == "full"
        assert r["upserted"] == 1
        assert r["ctag"] == "fake-ctag-1"

    def test_caldav_failure_records_error(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        from src.calendar_notion.caldav_reader import CalDAVReader

        def _boom(self):
            raise RuntimeError("CalDAV unreachable")

        monkeypatch.setattr(
            CalDAVReader, "list_calendar_names_for_sync", _boom,
        )
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "calendar", "sync-now", "-o", "json", db_path=seeded_db,
        )
        # 应失败返回 error wrapper (无 calendars 列表)
        assert result.exit_code != 0
        payload = _last_json(result.output)
        assert "error" in payload
        assert "CalDAV" in payload["error"]["message"]
