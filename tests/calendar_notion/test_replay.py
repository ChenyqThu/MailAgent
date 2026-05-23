"""Phase 2.4 replay 单测.

覆盖:
- ``_event_id_for_row`` master vs RRULE 实例
- ``_map_status`` 三态 + case-insensitive
- ``_row_to_calendar_event`` mapping 关键字段 + mailto: 剥离 + 空值兜底
- ``replay_calendar_event`` 找到 caldav row → sync_event 调 → 回写 page_id
- ``replay_calendar_event`` source=None 走 caldav → email_ics fallback
- ``replay_calendar_event`` source='caldav' 限定不 fallback
- ``replay_calendar_event`` row 不存在 → ValueError
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.calendar_notion.replay import (
    SOURCES_TRY_ORDER,
    _event_id_for_row,
    _map_status,
    _row_to_calendar_event,
    replay_calendar_event,
)
from src.calendar_sync.repository import CalendarEventRow
from src.models import EventStatus


# ----------------------------------------------------------------------------
# fixture helpers
# ----------------------------------------------------------------------------

def _make_row(
    *,
    ical_uid: str = "uid-test",
    recurrence_id: str | None = None,
    summary: str = "Team Sync",
    organizer: str = "alice@example.com",
    attendees: list[dict] | None = None,
    status: str = "CONFIRMED",
    rrule: str = "",
    source: str = "caldav",
    notion_page_id: str | None = None,
    is_all_day: bool = False,
) -> CalendarEventRow:
    """Minimal CalendarEventRow for unit tests — fills defaults for all fields."""
    now = datetime(2026, 5, 23, 14, 0, tzinfo=timezone.utc)
    return CalendarEventRow(
        id=1,
        ical_uid=ical_uid,
        recurrence_id=recurrence_id,
        sequence=0,
        calendar_name="日历",
        summary=summary,
        description="",
        location="",
        organizer=organizer,
        attendees=attendees or [],
        dtstart_utc=now,
        dtend_utc=datetime(2026, 5, 23, 15, 0, tzinfo=timezone.utc),
        is_all_day=is_all_day,
        rrule=rrule,
        exdates=[],
        rdates=[],
        status=status,
        response_status="ACCEPTED",
        url="",
        ics_raw="",
        source=source,
        notion_page_id=notion_page_id,
        related_email_internal_id=None,
        last_synced_at=now,
        deleted_at=None,
        created_at=now,
        updated_at=now,
    )


# ----------------------------------------------------------------------------
# _event_id_for_row
# ----------------------------------------------------------------------------

def test_event_id_master_event_no_recurrence():
    row = _make_row(ical_uid="abc-123", recurrence_id=None)
    assert _event_id_for_row(row) == "abc-123"


def test_event_id_recurrence_instance():
    row = _make_row(ical_uid="abc-123", recurrence_id="2026-05-23T14:00:00Z")
    assert _event_id_for_row(row) == "abc-123@2026-05-23T14:00:00Z"


# ----------------------------------------------------------------------------
# _map_status
# ----------------------------------------------------------------------------

def test_map_status_none_returns_none_enum():
    assert _map_status(None) == EventStatus.NONE


def test_map_status_empty_returns_none_enum():
    assert _map_status("") == EventStatus.NONE


def test_map_status_confirmed():
    assert _map_status("CONFIRMED") == EventStatus.CONFIRMED


def test_map_status_cancelled_case_insensitive():
    assert _map_status("cancelled") == EventStatus.CANCELLED
    assert _map_status("CANCELLED") == EventStatus.CANCELLED


def test_map_status_tentative():
    assert _map_status("TENTATIVE") == EventStatus.TENTATIVE


def test_map_status_unknown_falls_to_none():
    assert _map_status("WHATEVER") == EventStatus.NONE


# ----------------------------------------------------------------------------
# _row_to_calendar_event
# ----------------------------------------------------------------------------

def test_row_to_event_basic_mapping():
    row = _make_row(summary="Standup", organizer="bob@acme.com")
    event = _row_to_calendar_event(row)
    assert event.title == "Standup"
    assert event.event_id == row.ical_uid
    assert event.calendar_name == "日历"
    assert event.organizer == "bob@acme.com"
    assert event.organizer_email == "bob@acme.com"
    assert event.is_all_day is False
    assert event.status == EventStatus.CONFIRMED


def test_row_to_event_strips_mailto_prefix():
    row = _make_row(organizer="mailto:carol@example.com")
    event = _row_to_calendar_event(row)
    assert event.organizer == "carol@example.com"
    assert event.organizer_email == "carol@example.com"


def test_row_to_event_organizer_no_email_no_mailto():
    """organizer 字段是普通字符串 (no @) — 不抽 organizer_email."""
    row = _make_row(organizer="Conference Room A")
    event = _row_to_calendar_event(row)
    assert event.organizer == "Conference Room A"
    assert event.organizer_email is None


def test_row_to_event_attendees_mapping():
    row = _make_row(attendees=[
        {"email": "a@x.com", "name": "Alice", "response": "ACCEPTED", "role": "REQ-PARTICIPANT"},
        {"email": "b@x.com", "name": "Bob", "response": "DECLINED", "role": "OPT-PARTICIPANT"},
    ])
    event = _row_to_calendar_event(row)
    assert len(event.attendees) == 2
    assert event.attendees[0].email == "a@x.com"
    assert event.attendees[0].name == "Alice"
    assert event.attendees[0].status == "accepted"  # response → status (lowercased)
    assert event.attendees[1].status == "declined"


def test_row_to_event_attendees_skips_non_dict_entries():
    """SQLite attendees_json 解析炸时可能是 garbage; 防御性跳过."""
    row = _make_row(attendees=[
        {"email": "a@x.com"},
        "not-a-dict",  # type: ignore[list-item]
        None,
    ])
    event = _row_to_calendar_event(row)
    assert len(event.attendees) == 1


def test_row_to_event_rrule_sets_is_recurring():
    row = _make_row(rrule="FREQ=WEEKLY;BYDAY=MO")
    event = _row_to_calendar_event(row)
    assert event.is_recurring is True
    assert event.recurrence_rule == "FREQ=WEEKLY;BYDAY=MO"


def test_row_to_event_no_rrule():
    row = _make_row(rrule="")
    event = _row_to_calendar_event(row)
    assert event.is_recurring is False
    assert event.recurrence_rule is None


def test_row_to_event_all_day():
    row = _make_row(is_all_day=True)
    event = _row_to_calendar_event(row)
    assert event.is_all_day is True


# ----------------------------------------------------------------------------
# replay_calendar_event — happy path + fallback + errors
# ----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replay_caldav_event_calls_sync_and_writes_back_page_id():
    row = _make_row(ical_uid="caldav-uid", source="caldav")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    repo.update_notion_link = MagicMock()
    notion_sync = MagicMock()
    notion_sync.sync_event = AsyncMock(return_value=("created", "page-abc"))

    result = await replay_calendar_event(
        repo, notion_sync, ical_uid="caldav-uid",
    )

    assert result == {
        "action": "created",
        "page_id": "page-abc",
        "ical_uid": "caldav-uid",
        "recurrence_id": None,
        "source": "caldav",
    }
    # 第一次按 SOURCES_TRY_ORDER 找 caldav 就命中
    repo.get_by_ical_uid.assert_called_once_with(
        "caldav-uid", source="caldav", recurrence_id=None,
    )
    notion_sync.sync_event.assert_awaited_once()
    repo.update_notion_link.assert_called_once_with(row.id, "page-abc")


@pytest.mark.asyncio
async def test_replay_source_none_falls_back_caldav_then_email_ics():
    """source=None: caldav miss → email_ics hit → sync 用 email_ics row."""
    row = _make_row(ical_uid="x", source="email_ics")
    repo = MagicMock()
    # caldav miss, email_ics hit, legacy 不应被问
    repo.get_by_ical_uid.side_effect = lambda ical_uid, source, recurrence_id: (
        row if source == "email_ics" else None
    )
    repo.update_notion_link = MagicMock()
    notion_sync = MagicMock()
    notion_sync.sync_event = AsyncMock(return_value=("updated", "page-y"))

    result = await replay_calendar_event(
        repo, notion_sync, ical_uid="x",
    )

    assert result["source"] == "email_ics"
    assert result["action"] == "updated"
    # caldav 先被查 (miss), email_ics 第二被查 (hit), legacy 应该没被查
    calls = [c.kwargs["source"] for c in repo.get_by_ical_uid.call_args_list]
    assert calls == ["caldav", "email_ics"]


@pytest.mark.asyncio
async def test_replay_explicit_source_does_not_fallback():
    """显式 source='caldav' 不会 fallback 到其他."""
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = None  # caldav miss
    notion_sync = MagicMock()

    with pytest.raises(ValueError, match="not found"):
        await replay_calendar_event(
            repo, notion_sync, ical_uid="missing", source="caldav",
        )
    # 只查 caldav 一次, 不试 email_ics / legacy
    assert repo.get_by_ical_uid.call_count == 1


@pytest.mark.asyncio
async def test_replay_recurrence_id_passed_through():
    """recurrence_id 透传给 repo.get_by_ical_uid + 影响 event_id 生成."""
    row = _make_row(ical_uid="rrule-uid", recurrence_id="2026-05-30T10:00:00Z")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    repo.update_notion_link = MagicMock()
    notion_sync = MagicMock()
    captured_event = []
    async def _capture_sync(event):
        captured_event.append(event)
        return ("created", "page-rec")
    notion_sync.sync_event = AsyncMock(side_effect=_capture_sync)

    result = await replay_calendar_event(
        repo, notion_sync,
        ical_uid="rrule-uid",
        recurrence_id="2026-05-30T10:00:00Z",
    )

    assert result["recurrence_id"] == "2026-05-30T10:00:00Z"
    assert captured_event[0].event_id == "rrule-uid@2026-05-30T10:00:00Z"


@pytest.mark.asyncio
async def test_replay_not_found_raises_value_error_lists_sources():
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = None
    notion_sync = MagicMock()
    notion_sync.sync_event = AsyncMock()

    with pytest.raises(ValueError) as exc_info:
        await replay_calendar_event(
            repo, notion_sync, ical_uid="ghost-uid",
        )
    # 错误信息含 sources 列表方便排查
    err = str(exc_info.value)
    assert "ghost-uid" in err
    for s in SOURCES_TRY_ORDER:
        assert s in err
    # sync_event 没被调
    notion_sync.sync_event.assert_not_called()


@pytest.mark.asyncio
async def test_replay_update_notion_link_failure_does_not_raise():
    """SQLite 回写 page_id 炸时仅 warning 不抛 — Notion 已经写完了."""
    row = _make_row(ical_uid="x")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    repo.update_notion_link.side_effect = RuntimeError("db locked")
    notion_sync = MagicMock()
    notion_sync.sync_event = AsyncMock(return_value=("created", "page-x"))

    # 应该返回正常 result, 不抛
    result = await replay_calendar_event(
        repo, notion_sync, ical_uid="x",
    )
    assert result["action"] == "created"
    assert result["page_id"] == "page-x"
