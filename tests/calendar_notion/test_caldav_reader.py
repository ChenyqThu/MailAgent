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


# --------- get_collection_ctag (caldav 3.x PROPFIND element 修复) ---------
#
# 回归: caldav 3.x get_properties 只收 BaseElement 实例, 老写法传
# ("DAV:", "getctag") tuple 每轮 tick 抛 "'tuple' object has no attribute
# 'xmlelement'" 刷屏 (24h 613 次 WARNING), worker 永远拿不到 ctag 退化全量拉取.

from loguru import logger as _loguru_logger


@pytest.fixture
def log_messages():
    """捕获 loguru 输出 (level name + text)."""
    messages: list[tuple[str, str]] = []
    hid = _loguru_logger.add(
        lambda m: messages.append((m.record["level"].name, m.record["message"])),
        level="DEBUG",
    )
    yield messages
    _loguru_logger.remove(hid)


def _reader_with_calendar(cal):
    reader = _make_reader()
    reader._principal = SimpleNamespace(calendars=lambda: [cal])
    return reader


def test_get_collection_ctag_uses_base_element():
    """PROPFIND 用 BaseElement 实例 (带 calendarserver getctag tag), 不是 tuple."""
    get_property = MagicMock(return_value="ctag-v1")
    cal = SimpleNamespace(name="日历", get_property=get_property)
    reader = _reader_with_calendar(cal)

    assert reader.get_collection_ctag("日历") == "ctag-v1"
    (prop,), _ = get_property.call_args
    assert not isinstance(prop, tuple)
    assert prop.tag == "{http://calendarserver.org/ns/}getctag"
    assert callable(prop.xmlelement)  # caldav 3.x 库内部会调


def test_get_collection_ctag_server_returns_none():
    """server 不支持 getctag (prop 缺失) → None, 不抛."""
    cal = SimpleNamespace(name="日历", get_property=MagicMock(return_value=None))
    reader = _reader_with_calendar(cal)
    assert reader.get_collection_ctag("日历") is None


def test_get_collection_ctag_failure_warns_once(log_messages):
    """探测失败 → None (worker 降级假定有变化); warning 只出第一次, 之后降 DEBUG."""
    cal = SimpleNamespace(
        name="日历", get_property=MagicMock(side_effect=RuntimeError("boom"))
    )
    reader = _reader_with_calendar(cal)

    assert reader.get_collection_ctag("日历") is None
    assert reader.get_collection_ctag("日历") is None

    ctag_logs = [(lvl, msg) for lvl, msg in log_messages if "getctag" in msg]
    warnings = [m for lvl, m in ctag_logs if lvl == "WARNING"]
    debugs = [m for lvl, m in ctag_logs if lvl == "DEBUG"]
    assert len(warnings) == 1
    assert len(debugs) == 1


def test_get_collection_ctag_warn_resets_after_recovery(log_messages):
    """失败 → 成功 → 再失败: 恢复后重置去重, 第二轮失败重新 WARNING."""
    cal = SimpleNamespace(name="日历", get_property=MagicMock())
    reader = _reader_with_calendar(cal)

    cal.get_property.side_effect = RuntimeError("boom")
    assert reader.get_collection_ctag("日历") is None
    cal.get_property.side_effect = None
    cal.get_property.return_value = "ctag-v2"
    assert reader.get_collection_ctag("日历") == "ctag-v2"
    cal.get_property.side_effect = RuntimeError("boom again")
    assert reader.get_collection_ctag("日历") is None

    warnings = [
        m for lvl, m in log_messages if lvl == "WARNING" and "getctag" in m
    ]
    assert len(warnings) == 2


def test_get_collection_ctag_calendar_not_found():
    cal = SimpleNamespace(name="日历", get_property=MagicMock(return_value="x"))
    reader = _reader_with_calendar(cal)
    assert reader.get_collection_ctag("不存在") is None
