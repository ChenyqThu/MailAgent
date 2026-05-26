"""Phase 3 §P1-a — pytest for CalendarService facade.

CalendarService 抽 13 个 CLI subcommand + IPC handler 共享业务逻辑. 本测试套主
要覆盖:
- 服务无状态构造 + lazy repo
- Read ops 校验 + 数据 shape (against fresh DB + upsert fixture)
- Write ops 校验 (不调真 SMTP / CalDAV, dry_run 路径 + mock cfg)
- 异常映射: ValueError for 参数 / not-found

不在 scope: 真 CalDAV PUT/DELETE (caldav_writer 测试套已有), 真 SMTP RSVP
(rsvp 测试套已有), Notion replay (calendar_notion 测试套已有). 这里只测
service facade 是否正确把参数 forward 到底层 + dict 输出 shape.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.calendar_sync import CalendarEventRepository, CalendarService
from src.calendar_sync.service import (
    RSVP_RESPONSE_ALIAS,
    VALID_EVENT_SOURCES,
    VALID_EVENT_STATUS,
    occurrence_to_dict,
    row_to_dict,
)


# ============================================================
# Constants + import smoke
# ============================================================

def test_constants_exported():
    """Verify public constants 跟 CLI 用的同 shape (catch typo)."""
    assert VALID_EVENT_SOURCES == ("caldav", "email_ics", "legacy_calendar_app")
    assert VALID_EVENT_STATUS == ("CONFIRMED", "TENTATIVE", "CANCELLED")
    # RSVP alias 至少要支持 3 个 canonical lowercase 别名
    assert RSVP_RESPONSE_ALIAS["accept"] == "ACCEPTED"
    assert RSVP_RESPONSE_ALIAS["tentative"] == "TENTATIVE"
    assert RSVP_RESPONSE_ALIAS["decline"] == "DECLINED"


def test_service_constructs_without_cfg(fresh_db: str):
    """CalendarService(db_path) — 不传 cfg 也能构造 (纯读 ops 不需要)."""
    svc = CalendarService(db_path=fresh_db)
    assert svc.db_path == fresh_db
    # repo lazy: 第一次访问构造
    assert svc._repo is None
    _ = svc.repo
    assert svc._repo is not None
    # 重复访问复用同一个 (lazy 单例语义)
    assert svc.repo is svc._repo


def test_cfg_property_raises_when_none(fresh_db: str):
    """写 ops 路径要 cfg, None 时访问 .cfg 该 raise."""
    svc = CalendarService(db_path=fresh_db, cfg=None)
    with pytest.raises(ValueError, match="cfg is None"):
        _ = svc.cfg


# ============================================================
# Read ops — list_events_in_window + today/week
# ============================================================

def test_list_events_in_window_validation(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    now = datetime.now(timezone.utc)
    earlier = now - timedelta(hours=1)

    # limit <= 0
    with pytest.raises(ValueError, match="limit must be > 0"):
        svc.list_events_in_window(
            window_start=earlier, window_end=now, limit=0,
        )

    # bad source
    with pytest.raises(ValueError, match="not in"):
        svc.list_events_in_window(
            window_start=earlier, window_end=now, source="bogus",
        )

    # window_end <= window_start
    with pytest.raises(ValueError, match="must be >"):
        svc.list_events_in_window(
            window_start=now, window_end=earlier,
        )


def test_list_events_in_window_empty(fresh_db: str):
    """Fresh DB 无事件, 应返 events=[], total=0."""
    svc = CalendarService(db_path=fresh_db)
    now = datetime.now(timezone.utc)
    result = svc.list_events_in_window(
        window_start=now - timedelta(hours=1),
        window_end=now + timedelta(hours=1),
    )
    assert result["events"] == []
    assert result["total"] == 0
    assert "window" in result
    assert "filters" in result


def test_list_events_in_window_with_data(repo: CalendarEventRepository, make_event):
    """Upsert 一个 event, 然后 service.list_events_in_window 能读出来."""
    svc = CalendarService(db_path=str(repo.db_path))
    ev = make_event(uid="svc-test-1", summary="服务集成测试事件")
    repo.upsert_from_caldav_event(ev, source="caldav")

    result = svc.list_events_in_window(
        window_start=datetime(2026, 5, 22, 0, 0, tzinfo=timezone.utc),
        window_end=datetime(2026, 5, 23, 0, 0, tzinfo=timezone.utc),
    )
    assert result["total"] == 1
    assert result["events"][0]["ical_uid"] == "svc-test-1"
    assert result["events"][0]["summary"] == "服务集成测试事件"
    assert result["events"][0]["source"] == "caldav"


def test_list_today_returns_window_shape(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    result = svc.list_today()
    # window 是今天 00:00 → 24:00
    ws_iso = result["window"]["from_iso"]
    we_iso = result["window"]["to_iso"]
    ws = datetime.fromisoformat(ws_iso)
    we = datetime.fromisoformat(we_iso)
    assert (we - ws).total_seconds() == pytest.approx(86400)


def test_list_week_returns_7_days(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    result = svc.list_week()
    ws = datetime.fromisoformat(result["window"]["from_iso"])
    we = datetime.fromisoformat(result["window"]["to_iso"])
    assert (we - ws).days == 7


# ============================================================
# get_event
# ============================================================

def test_get_event_not_found_raises_value_error(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    with pytest.raises(ValueError, match="not found"):
        svc.get_event(ical_uid="ghost-uid", source="caldav")


def test_get_event_bad_source(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    with pytest.raises(ValueError, match="not in"):
        svc.get_event(ical_uid="x", source="bogus_source")


def test_get_event_returns_full_row_dict(
    repo: CalendarEventRepository, make_event
):
    svc = CalendarService(db_path=str(repo.db_path))
    ev = make_event(
        uid="get-test", summary="Get test", location="Room 101",
    )
    repo.upsert_from_caldav_event(ev, source="caldav")

    out = svc.get_event(ical_uid="get-test", source="caldav")
    event = out["event"]
    assert event["ical_uid"] == "get-test"
    assert event["summary"] == "Get test"
    assert event["location"] == "Room 101"
    # row_to_dict 跟 occurrence_to_dict 区别: 含 ics_raw + dtstart_iso (不是
    # occurrence_start_iso)
    assert "dtstart_iso" in event
    assert "ics_raw" in event


# ============================================================
# list_sync_states + list_calendar_names
# ============================================================

def test_list_sync_states_empty(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    result = svc.list_sync_states()
    assert result == {
        "calendars": [],
        "total": 0,
        "worker_enabled": False,
    }


def test_list_sync_states_worker_enabled_flag(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    result = svc.list_sync_states(worker_enabled=True)
    assert result["worker_enabled"] is True


def test_list_calendar_names_empty(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    assert svc.list_calendar_names() == []


def test_list_calendar_names_distinct_sorted(
    repo: CalendarEventRepository, make_event
):
    svc = CalendarService(db_path=str(repo.db_path))
    # 同 calendar_name 两个 event → distinct 后只剩一个
    repo.upsert_from_caldav_event(
        make_event(uid="c1", calendar_name="Work"),
    )
    repo.upsert_from_caldav_event(
        make_event(uid="c2", calendar_name="Work"),
    )
    repo.upsert_from_caldav_event(
        make_event(uid="c3", calendar_name="Personal"),
    )
    repo.upsert_from_caldav_event(
        make_event(uid="c4", calendar_name="Family"),
    )

    names = svc.list_calendar_names()
    assert names == ["Family", "Personal", "Work"]


# ============================================================
# discover_recurring_series — group + master pick
# ============================================================

def test_discover_recurring_validation(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    with pytest.raises(ValueError, match="limit must be > 0"):
        svc.discover_recurring_series(
            sync_store=MagicMock(), limit=0,
        )


def test_discover_recurring_groups_by_uid(fresh_db: str):
    """3 个 matches 但只 2 个 uid → 应该 2 个 series."""
    svc = CalendarService(db_path=fresh_db)
    fake_matches = [
        {
            "uid": "series-A", "internal_id": 1,
            "dtstart": "2026-05-22T09:00:00+00:00",
            "subject": "Series A weekly", "sender": "a@x.com",
            "method": "REQUEST", "rrule": "FREQ=WEEKLY",
        },
        {
            "uid": "series-A", "internal_id": 2,
            "dtstart": "2026-05-29T09:00:00+00:00",
            "subject": "Series A weekly update", "sender": "a@x.com",
            "method": "REQUEST", "rrule": "FREQ=WEEKLY",
        },
        {
            "uid": "series-B", "internal_id": 3,
            "dtstart": "2026-05-23T10:00:00+00:00",
            "subject": "Series B", "sender": "b@x.com",
            "method": "REQUEST", "rrule": "FREQ=DAILY",
        },
    ]

    async def _fake_discover(*args, **kwargs):
        return fake_matches

    with patch(
        "src.calendar_notion.recurring_invite.discover_recurring",
        side_effect=_fake_discover,
    ):
        result = svc.discover_recurring_series(
            sync_store=MagicMock(), limit=100,
        )

    assert result["total_series"] == 2
    assert result["matches_total"] == 3
    uids = {s["series_uid"] for s in result["series"]}
    assert uids == {"series-A", "series-B"}

    # series-A 的 master 应该是 earliest dtstart (2026-05-22, internal_id=1)
    series_a = next(s for s in result["series"] if s["series_uid"] == "series-A")
    assert series_a["master_dtstart"] == "2026-05-22T09:00:00+00:00"
    assert series_a["internal_ids"] == [1, 2]


# ============================================================
# Write ops validation (不调真 backend)
# ============================================================

def test_create_event_validates_status(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="status="):
        svc.create_event(
            summary="X",
            dtstart_utc=datetime(2026, 1, 1, tzinfo=timezone.utc),
            dtend_utc=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            status="BOGUS",
        )


def test_create_event_validates_dtend_after_dtstart(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="must be >"):
        svc.create_event(
            summary="X",
            dtstart_utc=datetime(2026, 1, 1, 12, tzinfo=timezone.utc),
            dtend_utc=datetime(2026, 1, 1, 10, tzinfo=timezone.utc),
        )


def test_update_event_validates_status(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="status="):
        svc.update_event(ical_uid="x", status="BOGUS")


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_create_event_passes_rrule_to_writer(mock_writer_cls, fresh_db: str):
    """Phase 4·#3 — service.create_event 透传 rrule 给 writer (创建周期事件)."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.create_event.return_value = {"action": "created"}
    svc.create_event(
        summary="Standup",
        dtstart_utc=datetime(2026, 1, 1, 9, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 1, 1, 9, 30, tzinfo=timezone.utc),
        rrule="FREQ=WEEKLY;BYDAY=MO",
    )
    _, kwargs = mock_writer_cls.return_value.create_event.call_args
    assert kwargs["rrule"] == "FREQ=WEEKLY;BYDAY=MO"


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_update_event_omits_rrule_when_not_passed(mock_writer_cls, fresh_db: str):
    """不传 rrule → service 不 forward rrule kwarg (writer 默认 _UNSET 保留)."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.update_event.return_value = {"action": "updated"}
    svc.update_event(ical_uid="u", summary="X")
    _, kwargs = mock_writer_cls.return_value.update_event.call_args
    assert "rrule" not in kwargs


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_update_event_forwards_rrule_override(mock_writer_cls, fresh_db: str):
    """显式 rrule str → forward 给 writer 覆盖整系列规则."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.update_event.return_value = {"action": "updated"}
    svc.update_event(ical_uid="u", rrule="FREQ=DAILY")
    _, kwargs = mock_writer_cls.return_value.update_event.call_args
    assert kwargs["rrule"] == "FREQ=DAILY"


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_update_event_forwards_empty_rrule_to_clear(mock_writer_cls, fresh_db: str):
    """显式 rrule='' → forward 空串 (writer 删除 RRULE, 周期变单次)."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.update_event.return_value = {"action": "updated"}
    svc.update_event(ical_uid="u", rrule="")
    _, kwargs = mock_writer_cls.return_value.update_event.call_args
    assert kwargs["rrule"] == ""


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_create_event_passes_is_all_day(mock_writer_cls, fresh_db: str):
    """Phase 4·#2 — service.create_event 透传 is_all_day 给 writer."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.create_event.return_value = {"action": "created"}
    svc.create_event(
        summary="假期",
        dtstart_utc=datetime(2026, 6, 1, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 6, 2, tzinfo=timezone.utc),
        is_all_day=True,
    )
    _, kwargs = mock_writer_cls.return_value.create_event.call_args
    assert kwargs["is_all_day"] is True


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_update_event_omits_is_all_day_when_not_passed(mock_writer_cls, fresh_db: str):
    """不传 is_all_day → service 不 forward (writer 检测保持原全天状态)."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.update_event.return_value = {"action": "updated"}
    svc.update_event(ical_uid="u", summary="X")
    _, kwargs = mock_writer_cls.return_value.update_event.call_args
    assert "is_all_day" not in kwargs


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_update_event_forwards_is_all_day(mock_writer_cls, fresh_db: str):
    """显式 is_all_day=True → forward 给 writer (edit 改全天状态)."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.update_event.return_value = {"action": "updated"}
    svc.update_event(ical_uid="u", is_all_day=True)
    _, kwargs = mock_writer_cls.return_value.update_event.call_args
    assert kwargs["is_all_day"] is True


def test_update_occurrence_validates_status(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="status="):
        svc.update_occurrence(
            ical_uid="x",
            recurrence_id_utc=datetime(2026, 1, 12, 9, tzinfo=timezone.utc),
            status="BOGUS",
        )


@patch("src.calendar_sync.caldav_writer.CalDAVWriter")
def test_update_occurrence_forwards_to_writer(mock_writer_cls, fresh_db: str):
    """Phase 4·#3c — service.update_occurrence 透传给 writer.update_occurrence."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    mock_writer_cls.return_value.update_occurrence.return_value = {
        "action": "occurrence_updated"
    }
    rid = datetime(2026, 1, 12, 9, 0, tzinfo=timezone.utc)
    svc.update_occurrence(ical_uid="u", recurrence_id_utc=rid, summary="改这次")
    _, kwargs = mock_writer_cls.return_value.update_occurrence.call_args
    assert kwargs["recurrence_id_utc"] == rid
    assert kwargs["summary"] == "改这次"


def test_sync_now_validates_days(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="future_days"):
        svc.sync_now(past_days=10, future_days=0)
    with pytest.raises(ValueError, match="past_days"):
        svc.sync_now(past_days=-1, future_days=10)


def test_send_rsvp_bad_source(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="not in"):
        svc.send_rsvp(
            ical_uid="x", response_status="ACCEPTED", source="bogus",
        )


def test_replay_event_bad_source(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="not in"):
        svc.replay_event_to_notion(
            ical_uid="x", source="bogus", dry_run=True,
        )


def test_replay_event_dry_run_not_found(fresh_db: str):
    """Dry-run 模式 row 不存在 → ValueError (tried sources 信息)."""
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="not found"):
        svc.replay_event_to_notion(
            ical_uid="ghost", dry_run=True,
        )


def test_replay_event_dry_run_finds_row(
    repo: CalendarEventRepository, make_event
):
    svc = CalendarService(db_path=str(repo.db_path), cfg=MagicMock())
    ev = make_event(uid="replay-test", summary="Replay candidate")
    repo.upsert_from_caldav_event(ev, source="caldav")

    out = svc.replay_event_to_notion(
        ical_uid="replay-test", dry_run=True,
    )
    assert out["dry_run"] is True
    assert out["action"] == "would_replay"
    assert out["ical_uid"] == "replay-test"
    assert out["source"] == "caldav"
    assert out["summary"] == "Replay candidate"


def test_recurring_replay_validation(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    with pytest.raises(ValueError, match="internal_ids"):
        svc.recurring_replay_by_internal_ids(
            internal_ids=[], sync_store=MagicMock(), arm=MagicMock(),
        )


def test_recurring_replay_dry_run(fresh_db: str):
    svc = CalendarService(db_path=fresh_db, cfg=MagicMock())
    out = svc.recurring_replay_by_internal_ids(
        internal_ids=[1, 2, 3],
        sync_store=MagicMock(),
        arm=MagicMock(),
        dry_run=True,
    )
    assert out["dry_run"] is True
    assert out["total"] == 3
    assert out["candidate_internal_ids"] == [1, 2, 3]
    assert out["succeeded"] == 0
    assert out["failed"] == 0


def test_expand_recurring_validation(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    with pytest.raises(ValueError, match="horizon_weeks"):
        svc.expand_recurring(
            sync_store=MagicMock(), horizon_weeks=0, dry_run=True,
        )


def test_expand_recurring_dry_run_shape(fresh_db: str):
    svc = CalendarService(db_path=fresh_db)
    fake_store = MagicMock()
    fake_store.iter_series_needing_expansion.return_value = iter([])

    out = svc.expand_recurring(
        sync_store=fake_store, horizon_weeks=8, dry_run=True,
    )
    assert out["mode"] == "dry_run"
    assert out["horizon_weeks"] == 8
    assert out["total_series"] == 0
    assert out["dry_run"] is True


# ============================================================
# Row dict helpers
# ============================================================

def test_occurrence_to_dict_shape(repo: CalendarEventRepository, make_event):
    """occurrence_to_dict 必须含前端 timeline 渲染需要的所有 key."""
    ev = make_event(uid="occ-test", summary="OK")
    repo.upsert_from_caldav_event(ev, source="caldav")

    occs = repo.list_event_occurrences(
        start_utc=datetime(2026, 5, 22, 0, 0, tzinfo=timezone.utc),
        end_utc=datetime(2026, 5, 23, 0, 0, tzinfo=timezone.utc),
    )
    assert len(occs) == 1
    d = occurrence_to_dict(occs[0])
    # 前端必备 key
    for key in (
        "id", "ical_uid", "recurrence_id", "sequence", "summary",
        "occurrence_start_iso", "occurrence_end_iso", "is_recurrence_instance",
        "is_all_day", "calendar_name", "organizer", "attendees", "location",
        "url", "status", "response_status", "source", "notion_page_id",
        "related_email_internal_id",
    ):
        assert key in d, f"occurrence_to_dict missing key {key!r}"


def test_row_to_dict_shape(repo: CalendarEventRepository, make_event):
    """row_to_dict 必须含 ics_raw + last_synced_at_iso (event-get 详情用)."""
    ev = make_event(uid="row-test")
    repo.upsert_from_caldav_event(ev, source="caldav")

    row = repo.get_by_ical_uid("row-test", source="caldav")
    assert row is not None
    d = row_to_dict(row)
    for key in (
        "id", "ical_uid", "summary", "dtstart_iso", "dtend_iso",
        "rrule", "exdates", "rdates", "ics_raw", "last_synced_at_iso",
        "created_at_iso", "updated_at_iso", "source", "notion_page_id",
    ):
        assert key in d, f"row_to_dict missing key {key!r}"
