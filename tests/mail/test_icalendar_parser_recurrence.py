"""ICalendarParser 周期相关字段解析单测."""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from src.mail.icalendar_parser import ICalendarParser


@pytest.fixture
def parser() -> ICalendarParser:
    return ICalendarParser()


def _bj(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=ZoneInfo("Asia/Shanghai"))


def test_parses_weekly_rrule(parser, make_ical):
    """RRULE:FREQ=WEEKLY;BYDAY=TU 应原值保留到 invite.recurrence_rule."""
    src = make_ical(
        uid="weekly-1",
        rrule="FREQ=WEEKLY;BYDAY=TU",
        dtstart="20260421T140000",
        dtend="20260421T150000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.recurrence_rule == "FREQ=WEEKLY;BYDAY=TU"
    assert invite.recurrence_id is None
    assert invite.exdates == []


def test_parses_biweekly_with_interval(parser, make_ical):
    """INTERVAL=2 双周会议."""
    src = make_ical(
        uid="biweekly-1",
        rrule="FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.recurrence_rule == "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"


def test_parses_until_bounded(parser, make_ical):
    """UNTIL 截止时间应原样保留."""
    src = make_ical(
        uid="until-1",
        rrule="FREQ=WEEKLY;UNTIL=20260601T000000Z",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.recurrence_rule == "FREQ=WEEKLY;UNTIL=20260601T000000Z"


def test_parses_count_bounded(parser, make_ical):
    """COUNT=N 总次数."""
    src = make_ical(
        uid="count-1",
        rrule="FREQ=WEEKLY;COUNT=10",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.recurrence_rule == "FREQ=WEEKLY;COUNT=10"


def test_parses_exdate_list(parser, make_ical):
    """EXDATE 多值（逗号分隔，含 TZID）应被收集成 list."""
    src = make_ical(
        uid="exdate-1",
        rrule="FREQ=WEEKLY",
        exdates=["20260427T140000", "20260504T140000"],
        tzid="China Standard Time",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert len(invite.exdates) == 2
    # 验证 TZ-aware 且时间正确
    for ex in invite.exdates:
        assert ex.tzinfo is not None
    assert invite.exdates[0] == _bj(2026, 4, 27, 14, 0)
    assert invite.exdates[1] == _bj(2026, 5, 4, 14, 0)


def test_parses_recurrence_id_override(parser, make_ical):
    """RECURRENCE-ID 单实例 override：method=REQUEST + RECURRENCE-ID 必填."""
    src = make_ical(
        uid="override-1",
        method="REQUEST",
        recurrence_id="20260427T140000",
        # override 邮件本身不带 RRULE
        rrule=None,
        # 给 override 一个移动后的时间
        dtstart="20260427T160000",
        dtend="20260427T170000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.recurrence_rule is None
    assert invite.recurrence_id is not None
    assert invite.recurrence_id == _bj(2026, 4, 27, 14, 0)
    # override 的 dtstart 是新时间
    assert invite.start_time == _bj(2026, 4, 27, 16, 0)


def test_parses_recurrence_id_cancel(parser, make_ical):
    """METHOD:CANCEL + RECURRENCE-ID = 取消单次实例."""
    src = make_ical(
        uid="cancel-instance-1",
        method="CANCEL",
        recurrence_id="20260504T140000",
        rrule=None,
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.method == "CANCEL"
    assert invite.recurrence_id == _bj(2026, 5, 4, 14, 0)
    assert invite.status == "cancelled"


def test_parses_all_day_recurring(parser, make_ical):
    """全天周期事件: DTSTART 长度 8 + RRULE 同时存在."""
    src = make_ical(
        uid="allday-recurring",
        all_day=True,
        dtstart="20260420",
        dtend="20260421",
        rrule="FREQ=YEARLY",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.is_all_day is True
    assert invite.recurrence_rule == "FREQ=YEARLY"


def test_parses_tzid_field(parser, make_ical):
    """TZID 应保留到 invite.tzid（用于 expansion 时复现 wall-clock 锚点）."""
    src = make_ical(
        uid="tzid-1",
        tzid="Pacific Standard Time",
        rrule="FREQ=WEEKLY",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.tzid == "Pacific Standard Time"


def test_to_calendar_event_recurring(parser, make_ical):
    """周期会议: to_calendar_event 应写真值 is_recurring + recurrence_rule."""
    src = make_ical(
        uid="ev-rec",
        rrule="FREQ=WEEKLY;BYDAY=WE",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    event = parser.to_calendar_event(invite)
    assert event.is_recurring is True
    assert event.recurrence_rule == "FREQ=WEEKLY;BYDAY=WE"


def test_to_calendar_event_non_recurring(parser, make_ical):
    """单次会议: is_recurring=False, recurrence_rule=None（保留旧行为）."""
    src = make_ical(uid="ev-single", rrule=None)
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    event = parser.to_calendar_event(invite)
    assert event.is_recurring is False
    assert event.recurrence_rule is None


def test_to_override_event_event_id_format(parser, make_ical):
    """to_override_event: event_id = {uid}@{recurrence_id_utc_iso}."""
    src = make_ical(
        uid="ov-1",
        method="REQUEST",
        recurrence_id="20260427T140000",  # CST 14:00 = UTC 06:00
        rrule=None,
        dtstart="20260427T160000",
        dtend="20260427T170000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    event = parser.to_override_event(invite)
    assert event.event_id == "ov-1@20260427T060000Z"
    assert event.master_event_id == "ov-1"
    assert event.recurrence_id == _bj(2026, 4, 27, 14, 0)


def test_parse_rrule_rejects_subsecond_freq():
    """_parse_rrule 拒绝 SECONDLY/MINUTELY/HOURLY 防爆."""
    parser = ICalendarParser()
    assert parser._parse_rrule("FREQ=WEEKLY;BYDAY=MO") == "FREQ=WEEKLY;BYDAY=MO"
    assert parser._parse_rrule("FREQ=DAILY") == "FREQ=DAILY"
    assert parser._parse_rrule("FREQ=SECONDLY") is None
    assert parser._parse_rrule("FREQ=MINUTELY") is None
    assert parser._parse_rrule("FREQ=HOURLY") is None
    assert parser._parse_rrule("INVALID") is None
    assert parser._parse_rrule("") is None


def test_description_not_overwritten_by_valarm(parser):
    """VALARM 块里的 DESCRIPTION:REMINDER 不应覆盖 VEVENT 真实的 DESCRIPTION。

    Outlook 风格邀请典型结构：VEVENT 的 DESCRIPTION 在前，VALARM 块在后，
    VALARM 内含 DESCRIPTION:REMINDER。扁平解析会让后者覆盖前者，
    导致 Notion 日程页正文只剩 "REMINDER"。
    """
    src = (
        "From: a@x\r\nTo: b@x\r\nSubject: t\r\nMIME-Version: 1.0\r\n"
        "Content-Type: text/calendar; method=REQUEST; charset=UTF-8\r\n"
        "Content-Transfer-Encoding: 8bit\r\n\r\n"
        "BEGIN:VCALENDAR\r\n"
        "METHOD:REQUEST\r\n"
        "BEGIN:VEVENT\r\n"
        "UID:valarm-uid-1\r\n"
        "SUMMARY:Meeting Update\r\n"
        "DTSTART;TZID=China Standard Time:20260512T140000\r\n"
        "DTEND;TZID=China Standard Time:20260512T150000\r\n"
        "DESCRIPTION:Updated meeting time to BJT 14:00 due to conflict\r\n"
        "BEGIN:VALARM\r\n"
        "DESCRIPTION:REMINDER\r\n"
        "ACTION:DISPLAY\r\n"
        "TRIGGER:-PT15M\r\n"
        "END:VALARM\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    assert invite.description == "Updated meeting time to BJT 14:00 due to conflict"
    assert invite.summary == "Meeting Update"
