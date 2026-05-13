"""周期展开器单测：覆盖 horizon、since、本周一、DST、Windows TZ、EXDATE、解析失败."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from src.calendar_notion.recurrence import (
    compute_since,
    expand_occurrences,
    mint_event_id,
)
from src.mail.icalendar_parser import ICalendarParser


PT_TZ = ZoneInfo("America/Los_Angeles")
BJ_TZ = ZoneInfo("Asia/Shanghai")


@pytest.fixture
def parser() -> ICalendarParser:
    return ICalendarParser()


def test_mint_event_id_uses_utc():
    """CST 14:00 → UTC 06:00."""
    dt = datetime(2026, 4, 27, 14, 0, tzinfo=BJ_TZ)
    assert mint_event_id("evt-1", dt) == "evt-1@20260427T060000Z"


def test_compute_since_picks_monday_of_week():
    """now=周三 → since 至少包含本周一 00:00 北京时间."""
    now = datetime(2026, 5, 6, 18, 0, tzinfo=BJ_TZ)  # 周三 18:00
    master = datetime(2026, 1, 1, 14, 0, tzinfo=BJ_TZ)
    since = compute_since(now, master, last_expanded_until=None)
    expected_monday = datetime(2026, 5, 4, 0, 0, tzinfo=BJ_TZ)
    assert since == expected_monday


def test_compute_since_clips_at_master_dtstart():
    """master 比本周一更晚 → since=master."""
    now = datetime(2026, 5, 6, 18, 0, tzinfo=BJ_TZ)
    master = datetime(2026, 5, 5, 9, 0, tzinfo=BJ_TZ)  # 周二，比周一晚
    since = compute_since(now, master, last_expanded_until=None)
    assert since == master


def test_compute_since_respects_high_water_mark():
    """last_expanded_until 高于本周一 → since=last_expanded_until."""
    now = datetime(2026, 5, 6, 18, 0, tzinfo=BJ_TZ)
    master = datetime(2026, 1, 1, 14, 0, tzinfo=BJ_TZ)
    high_water = datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc)
    since = compute_since(now, master, last_expanded_until=high_water)
    assert since == high_water


def test_horizon_truncates_infinite_rrule(parser, make_ical):
    """FREQ=WEEKLY 无 UNTIL/COUNT，horizon=4 周 → 至多 4 个."""
    src = make_ical(
        uid="weekly-inf",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    occurrences = expand_occurrences(invite, since=since, horizon_weeks=4)
    assert len(occurrences) == 4
    # 时间序列 4/20, 4/27, 5/4, 5/11
    expected_starts = [
        datetime(2026, 4, 20, 14, 0, tzinfo=BJ_TZ),
        datetime(2026, 4, 27, 14, 0, tzinfo=BJ_TZ),
        datetime(2026, 5, 4, 14, 0, tzinfo=BJ_TZ),
        datetime(2026, 5, 11, 14, 0, tzinfo=BJ_TZ),
    ]
    actual = [o.start_time for o in occurrences]
    assert actual == expected_starts


def test_since_filter_excludes_past(parser, make_ical):
    """DTSTART 在远古，since=今天 → 只取 since 之后的."""
    src = make_ical(
        uid="historical",
        rrule="FREQ=WEEKLY",
        dtstart="20260101T140000",  # 今年初
        dtend="20260101T150000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 5, 1, 0, 0, tzinfo=BJ_TZ)
    occurrences = expand_occurrences(invite, since=since, horizon_weeks=2)
    # 5/7、5/14 在 [5/1, 5/15] 范围内
    assert len(occurrences) == 2
    for occ in occurrences:
        assert occ.start_time >= since


def test_dst_boundary_pacific(parser, make_ical):
    """PT 9:00 周会跨 2026 年秋季 DST 边界 (Nov 1)，wall-clock 不变 / UTC offset 切换."""
    # 用合法 PT 时区（rrulestr 不接受 'Pacific Standard Time' 这种 Windows 名）
    src = make_ical(
        uid="pt-weekly",
        rrule="FREQ=WEEKLY;BYDAY=TU",
        dtstart="20261027T090000",  # Tue Oct 27, 2026 09:00 PDT
        dtend="20261027T100000",
        tzid="America/Los_Angeles",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 10, 26, 0, 0, tzinfo=PT_TZ)
    occurrences = expand_occurrences(invite, since=since, horizon_weeks=3)
    # Oct 27, Nov 3, Nov 10 — Nov 1 切换 PDT→PST，Nov 3 之后是 PST
    assert len(occurrences) >= 3

    # 全部 wall-clock 9:00 PT
    for occ in occurrences:
        local = occ.start_time.astimezone(PT_TZ)
        assert local.hour == 9 and local.minute == 0

    # Oct 27 (PDT, UTC-7) UTC = 16:00；Nov 3 / Nov 10 (PST, UTC-8) UTC = 17:00
    pre_dst = occurrences[0].start_time.astimezone(timezone.utc)
    post_dst = next(
        o for o in occurrences if o.start_time.astimezone(PT_TZ).month == 11
    ).start_time.astimezone(timezone.utc)
    assert pre_dst.hour == 16
    assert post_dst.hour == 17


def test_windows_tz_resolution(parser, make_ical):
    """China Standard Time → Asia/Shanghai (UTC+8)."""
    src = make_ical(
        uid="cn-weekly",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
        tzid="China Standard Time",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    occurrences = expand_occurrences(invite, since=since, horizon_weeks=2)
    assert len(occurrences) == 2
    for occ in occurrences:
        # 14:00 北京 = 06:00 UTC
        assert occ.start_time.astimezone(timezone.utc).hour == 6


def test_exdate_skipped(parser, make_ical):
    """EXDATE 排除指定日期 → 该 occurrence 不出现."""
    src = make_ical(
        uid="exclude",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
        exdates=["20260427T140000"],
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    occurrences = expand_occurrences(invite, since=since, horizon_weeks=4)
    starts = {occ.start_time for occ in occurrences}
    # 4/27 应该被排除
    assert datetime(2026, 4, 27, 14, 0, tzinfo=BJ_TZ) not in starts
    # 4/20, 5/4, 5/11 应该都在
    assert datetime(2026, 4, 20, 14, 0, tzinfo=BJ_TZ) in starts


def test_rrule_parse_failure_returns_empty(parser, make_ical):
    """malformed RRULE → 空 list + warning（不抛）."""
    src = make_ical(uid="bad-1", rrule="FREQ=WEEKLY")
    invite = parser.extract_from_email_source(src)
    assert invite is not None
    # 主动制造一个 dateutil 拒绝的 rule
    invite.recurrence_rule = "TOTALLY_INVALID"

    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    out = expand_occurrences(invite, since=since, horizon_weeks=4)
    assert out == []


def test_no_rrule_returns_empty(parser, make_ical):
    """非周期会议 → 空 list（调用方走单事件路径）."""
    src = make_ical(uid="single", rrule=None)
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    out = expand_occurrences(invite, since=since, horizon_weeks=4)
    assert out == []


def test_persisted_exdates_from_series_state(parser, make_ical):
    """series_state 里的 exdates_json 应被合并到展开过滤."""
    src = make_ical(
        uid="persist",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    series_state = {
        "exdates_json": '["2026-04-27T14:00:00+08:00", "2026-05-04T14:00:00+08:00"]',
    }
    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    occurrences = expand_occurrences(
        invite, since=since, horizon_weeks=4, series_state=series_state
    )
    starts = {occ.start_time for occ in occurrences}
    assert datetime(2026, 4, 27, 14, 0, tzinfo=BJ_TZ) not in starts
    assert datetime(2026, 5, 4, 14, 0, tzinfo=BJ_TZ) not in starts


def test_occurrence_inherits_master_fields(parser, make_ical):
    """occurrence 继承主 invite 的标题、组织者、TZ-aware tzinfo."""
    # 注意：MIME builder 是 ASCII envelope，中文要走 UTF-8 编码 quoted-printable，
    # 测试 fixture 没做这层（也不在 expander 职责内）。这里用 ASCII summary。
    src = make_ical(
        uid="inherit",
        summary="Sync meeting",
        organizer_cn="Alice",
        organizer_email="alice@example.com",
        rrule="FREQ=WEEKLY",
        dtstart="20260420T140000",
        dtend="20260420T150000",
    )
    invite = parser.extract_from_email_source(src)
    assert invite is not None

    since = datetime(2026, 4, 20, 0, 0, tzinfo=BJ_TZ)
    occurrences = expand_occurrences(invite, since=since, horizon_weeks=2)
    assert len(occurrences) >= 1
    occ = occurrences[0]
    assert occ.title == "Sync meeting"
    assert occ.organizer == "Alice"
    assert occ.organizer_email == "alice@example.com"
    assert occ.is_recurring is True
    assert occ.master_event_id == "inherit"
    assert occ.event_id.startswith("inherit@")
