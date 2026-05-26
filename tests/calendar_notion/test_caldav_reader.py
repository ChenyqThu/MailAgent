"""CalDAVReader._parse_event 边界 + build_llm_caldav_context 测试.

覆盖 review HIGH #6 + MEDIUM:
- 空 SUMMARY / 多 SUMMARY / list value 不崩
- dtstart=date / dtstart=datetime / dtend 缺失 / mixed date+datetime 都归一 tz-aware
- Teams link 抽取 (description regex)
- build_llm_caldav_context 默认关闭 → 空字符串
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.calendar_sync.caldav_reader import (
    CalDAVReader,
    CalendarEvent,
    _coerce_aware,
    _safe_value,
    build_llm_caldav_context,
)


# --------- _safe_value (HIGH #6 防御式 getattr) ---------

def test_safe_value_missing_attr():
    vevent = SimpleNamespace()  # 没 summary 属性
    assert _safe_value(vevent, "summary", "default") == "default"


def test_safe_value_normal_attr():
    vevent = SimpleNamespace(summary=SimpleNamespace(value="Team Sync"))
    assert _safe_value(vevent, "summary") == "Team Sync"


def test_safe_value_none_value():
    """vobject 解析空 SUMMARY: 属性存在但 value=None."""
    vevent = SimpleNamespace(summary=SimpleNamespace(value=None))
    assert _safe_value(vevent, "summary", "fallback") == "fallback"


def test_safe_value_list_value():
    """多 SUMMARY (RFC 5545 异常但实际见过) → 取第一个."""
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value=["First", "Second"])
    )
    assert _safe_value(vevent, "summary") == "First"


def test_safe_value_list_prop():
    """vobject 有时返回 list of property 对象."""
    inner = SimpleNamespace(value="X")
    vevent = SimpleNamespace(summary=[inner])
    assert _safe_value(vevent, "summary") == "X"


def test_safe_value_attr_access_throws():
    """getattr 抛 → 不传染."""
    class _Boom:
        @property
        def value(self):
            raise RuntimeError("vobject crash")
    vevent = SimpleNamespace(summary=_Boom())
    assert _safe_value(vevent, "summary", "ok") == "ok"


# --------- _coerce_aware (MEDIUM mixed date/datetime) ---------

def test_coerce_aware_none():
    assert _coerce_aware(None) is None


def test_coerce_aware_aware_datetime():
    dt = datetime(2026, 5, 22, 14, 30, tzinfo=timezone.utc)
    out = _coerce_aware(dt)
    assert out is dt


def test_coerce_aware_naive_datetime_to_utc():
    dt = datetime(2026, 5, 22, 14, 30)
    out = _coerce_aware(dt)
    assert out is not None
    assert out.tzinfo is not None


def test_coerce_aware_date_to_midnight_utc():
    d = date(2026, 5, 22)
    out = _coerce_aware(d)
    assert isinstance(out, datetime)
    assert out.tzinfo is not None
    assert out.hour == 0


def test_coerce_aware_unknown_type():
    assert _coerce_aware("garbage") is None


# --------- _parse_event ---------

def _make_reader():
    cfg = SimpleNamespace(
        davmail_imap_host="127.0.0.1",
        davmail_caldav_port=1080,
        user_email="me@x.com",
        davmail_cipher_key="test-key",
    )
    return CalDAVReader(cfg)


def _make_raw_event(vevent):
    """模拟 caldav.Event 返回, 含 .vobject_instance.vevent."""
    obj = SimpleNamespace(vevent=vevent)
    return SimpleNamespace(vobject_instance=obj)


def test_parse_event_basic_meeting():
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="Team Standup"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, 14, 30, tzinfo=timezone.utc)),
        dtend=SimpleNamespace(value=datetime(2026, 5, 22, 15, 0, tzinfo=timezone.utc)),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert out.summary == "Team Standup"
    assert out.is_all_day is False
    assert out.organizer == ""
    assert out.attendees == []


def test_parse_event_all_day():
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="Holiday"),
        dtstart=SimpleNamespace(value=date(2026, 5, 22)),
        dtend=SimpleNamespace(value=date(2026, 5, 23)),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert out.is_all_day is True
    assert out.start.tzinfo is not None
    assert out.end.tzinfo is not None


def test_parse_event_empty_summary_doesnt_crash():
    """HIGH #6: 空 SUMMARY → event 仍返回, summary 是空串."""
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value=None),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, tzinfo=timezone.utc)),
        dtend=SimpleNamespace(value=datetime(2026, 5, 22, 1, 0, tzinfo=timezone.utc)),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert out.summary == ""


def test_parse_event_missing_dtend_defaults_to_one_hour():
    """MEDIUM: dtend 缺 (RFC 5545 允许) → 默认 start + 1h."""
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="Quick"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, 14, 0, tzinfo=timezone.utc)),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert (out.end - out.start) == timedelta(hours=1)


def test_parse_event_mixed_date_datetime():
    """MEDIUM: dtstart=datetime, dtend=date 混合不再 TypeError 静默吞."""
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="Mixed"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, 14, 0, tzinfo=timezone.utc)),
        dtend=SimpleNamespace(value=date(2026, 5, 23)),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    # end - start 不再 TypeError
    delta = out.end - out.start
    assert isinstance(delta, timedelta)


def test_parse_event_naive_datetime_gets_utc():
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="X"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, 10, 0)),  # naive
        dtend=SimpleNamespace(value=datetime(2026, 5, 22, 11, 0)),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert out.start.tzinfo is not None
    assert out.end.tzinfo is not None


def test_parse_event_teams_link_extraction():
    reader = _make_reader()
    desc = "Click https://teams.microsoft.com/l/meetup-join/19:abc... to join"
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="Meet"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, tzinfo=timezone.utc)),
        dtend=SimpleNamespace(value=datetime(2026, 5, 22, 1, tzinfo=timezone.utc)),
        description=SimpleNamespace(value=desc),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert out.url.startswith("https://teams.microsoft.com/")


def test_parse_event_organizer_strips_mailto():
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="X"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, tzinfo=timezone.utc)),
        dtend=SimpleNamespace(value=datetime(2026, 5, 22, 1, tzinfo=timezone.utc)),
        organizer=SimpleNamespace(value="mailto:boss@x.com"),
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    assert out.organizer == "boss@x.com"


def test_parse_event_attendees_dedup():
    reader = _make_reader()

    class _Att:
        def __init__(self, v):
            self.value = v

    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="X"),
        dtstart=SimpleNamespace(value=datetime(2026, 5, 22, tzinfo=timezone.utc)),
        dtend=SimpleNamespace(value=datetime(2026, 5, 22, 1, tzinfo=timezone.utc)),
        attendee_list=[
            _Att("mailto:a@x.com"),
            _Att("mailto:b@x.com"),
            _Att("mailto:a@x.com"),  # dup
            _Att("mailto:A@X.com"),  # case dup
        ],
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is not None
    # dedup case-insensitive
    lower_set = {a.lower() for a in out.attendees}
    assert lower_set == {"a@x.com", "b@x.com"}


def test_parse_event_no_dtstart_returns_none():
    reader = _make_reader()
    vevent = SimpleNamespace(
        summary=SimpleNamespace(value="X"),
        # no dtstart
    )
    out = reader._parse_event(_make_raw_event(vevent))
    assert out is None


# --------- CalendarEvent.to_llm_brief ---------

def test_to_llm_brief_format():
    ev = CalendarEvent(
        summary="Standup",
        start=datetime(2026, 5, 22, 14, 30, tzinfo=timezone.utc),
        end=datetime(2026, 5, 22, 15, 0, tzinfo=timezone.utc),
        location="Room 101",
        organizer="boss@x",
        attendees=["a@x", "b@x"],
        url="",
    )
    brief = ev.to_llm_brief()
    assert "05-22 14:30" in brief
    assert "Standup" in brief
    assert "Room 101" in brief
    assert "boss@x" in brief
    assert "2 attendees" in brief


def test_to_llm_brief_with_teams_url_emoji():
    ev = CalendarEvent(
        summary="Sync",
        start=datetime(2026, 5, 22, 14, 0, tzinfo=timezone.utc),
        end=datetime(2026, 5, 22, 15, 0, tzinfo=timezone.utc),
        url="https://teams.microsoft.com/...",
    )
    brief = ev.to_llm_brief()
    assert "🎦" in brief


# --------- build_llm_caldav_context ---------

def test_build_llm_caldav_context_disabled():
    """默认关闭 → 空字符串 (review HIGH #6 graceful degrade)."""
    cfg = SimpleNamespace(llm_caldav_context_enabled=False)
    assert build_llm_caldav_context(cfg) == ""


def test_build_llm_caldav_context_caldav_unavailable(monkeypatch):
    """caldav 未装 / 连接失败 → 空字符串 + warning."""
    cfg = SimpleNamespace(
        llm_caldav_context_enabled=True,
        davmail_imap_host="127.0.0.1",
        davmail_caldav_port=1080,
        user_email="me@x.com",
        davmail_cipher_key="test-key",
    )

    def boom(self):
        raise RuntimeError("caldav unreachable")

    monkeypatch.setattr(CalDAVReader, "_connect", boom)
    # 不抛, 返回空串
    assert build_llm_caldav_context(cfg, horizon="today") == ""
