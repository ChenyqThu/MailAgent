"""expand_in_window — RRULE 展开测试.

TestTzidWallClock (#10 tzid 半步) 的 DST 跨界夹具与前端
frontend/tests/main/calendar.test.ts 「expandInWindow tzid 墙钟展开」describe
钉的是**同一组期望值** — 单改一侧必漂移 (P1-1 教训), 改夹具必须双侧同步。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


from src.calendar_sync import expand_in_window


WINDOW_WIDE_START = datetime(2026, 5, 1, tzinfo=timezone.utc)
WINDOW_WIDE_END = datetime(2026, 7, 1, tzinfo=timezone.utc)


def _utc(year, month, day, hour=0, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


# ============================================================
# 单次 event (无 RRULE)
# ============================================================

class TestSingleEvent:
    def test_event_in_window(self):
        occs = expand_in_window(
            dtstart=_utc(2026, 5, 22, 9), dtend=_utc(2026, 5, 22, 10),
            rrule="", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 1
        assert occs[0][0] == _utc(2026, 5, 22, 9)
        assert occs[0][1] == _utc(2026, 5, 22, 10)

    def test_event_before_window(self):
        occs = expand_in_window(
            dtstart=_utc(2026, 4, 1, 9), dtend=_utc(2026, 4, 1, 10),
            rrule="", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 0

    def test_event_after_window(self):
        occs = expand_in_window(
            dtstart=_utc(2026, 8, 1, 9), dtend=_utc(2026, 8, 1, 10),
            rrule="", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 0

    def test_event_spans_window_boundary(self):
        """事件 dtstart 在窗外但 dtend 在窗内 → 算 in (overlap)."""
        occs = expand_in_window(
            dtstart=_utc(2026, 4, 30, 23),
            dtend=_utc(2026, 5, 1, 1),  # 窗口起点是 5/1 00:00
            rrule="", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 1

    def test_missing_dtend_defaults_to_one_hour(self):
        occs = expand_in_window(
            dtstart=_utc(2026, 5, 22, 9), dtend=None,
            rrule="", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 1
        assert occs[0][1] - occs[0][0] == timedelta(hours=1)

    def test_naive_dtstart_treated_as_utc(self):
        """naive datetime 应被当作 UTC."""
        naive_start = datetime(2026, 5, 22, 9, 0)  # no tzinfo
        occs = expand_in_window(
            dtstart=naive_start, dtend=naive_start + timedelta(hours=1),
            rrule="", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 1
        assert occs[0][0].tzinfo is not None


# ============================================================
# RRULE
# ============================================================

class TestRRule:
    def test_weekly_count_4(self):
        start = _utc(2026, 5, 22, 9)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=WEEKLY;COUNT=4", exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 4
        # 间隔 7 天
        for i in range(1, 4):
            delta = occs[i][0] - occs[i - 1][0]
            assert delta == timedelta(days=7)

    def test_daily_with_until(self):
        start = _utc(2026, 5, 22, 9)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=DAILY;UNTIL=20260526T235959Z",
            exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        # 5/22, 5/23, 5/24, 5/25, 5/26 = 5 days
        assert len(occs) == 5

    def test_rrule_partially_in_window(self):
        """RRULE 跨窗口边界 — 只返回窗内 occurrences."""
        start = _utc(2026, 5, 22, 9)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=WEEKLY;COUNT=20",  # 远超窗口
            exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START,
            window_end=_utc(2026, 6, 15),  # 6/15 截止
        )
        # 5/22, 5/29, 6/5, 6/12 = 4
        assert len(occs) == 4

    def test_invalid_rrule_falls_back_to_single(self):
        start = _utc(2026, 5, 22, 9)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="GARBAGE=NOT_AN_RRULE",
            exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        # 解析失败 → fallback 单次
        assert len(occs) == 1

    def test_rrule_with_prefix_tolerated(self):
        """RRULE:FREQ=... 跟 FREQ=... 两种前缀都能处理."""
        start = _utc(2026, 5, 22, 9)
        occs1 = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="RRULE:FREQ=WEEKLY;COUNT=3",
            exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        occs2 = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=WEEKLY;COUNT=3",
            exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs1) == len(occs2) == 3


# ============================================================
# EXDATE / RDATE
# ============================================================

class TestExceptionDates:
    def test_exdate_skip(self):
        start = _utc(2026, 5, 22, 9)
        # 跳过第 2 周
        skip = start + timedelta(weeks=1)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=WEEKLY;COUNT=4",
            exdates_iso=[skip.isoformat()], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 3
        # 5/29 不应在结果里
        for occ_start, _ in occs:
            assert occ_start != skip

    def test_rdate_adds(self):
        start = _utc(2026, 5, 22, 9)
        extra = start + timedelta(days=3)  # 5/25
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=WEEKLY;COUNT=4",
            exdates_iso=[], rdates_iso=[extra.isoformat()],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        assert len(occs) == 5
        # 5/25 应在
        starts = [o[0] for o in occs]
        assert extra in starts

    def test_garbage_exdate_ignored(self):
        start = _utc(2026, 5, 22, 9)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=WEEKLY;COUNT=4",
            exdates_iso=["not-an-iso-date"], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
        )
        # garbage 被忽略, 全部 4 个 occurrence 出现
        assert len(occs) == 4


# ============================================================
# max_count cap (防 infinite RRULE)
# ============================================================

class TestMaxCountCap:
    def test_daily_infinite_capped(self):
        """无 UNTIL/COUNT 的 RRULE 在大窗口里会无限展开, max_count cap."""
        start = _utc(2026, 5, 22, 9)
        occs = expand_in_window(
            dtstart=start, dtend=start + timedelta(hours=1),
            rrule="FREQ=DAILY",  # 无 UNTIL/COUNT
            exdates_iso=[], rdates_iso=[],
            window_start=WINDOW_WIDE_START, window_end=WINDOW_WIDE_END,
            max_count=10,
        )
        assert len(occs) <= 10


# ============================================================
# #10 tzid 半步 — 墙钟展开 (DST 跨界夹具, 与 TS calendar.test.ts 钉同组值)
# ============================================================

class TestTzidWallClock:
    def test_la_spring_forward_wall_clock_constant(self):
        """LA 2026-03-08 春令跳变: 09:00 墙钟恒定, UTC 侧 17:00Z→16:00Z."""
        occs = expand_in_window(
            dtstart=_utc(2026, 3, 4, 17), dtend=_utc(2026, 3, 4, 17, 30),
            rrule="FREQ=WEEKLY;COUNT=3", exdates_iso=[], rdates_iso=[],
            window_start=_utc(2026, 3, 1), window_end=_utc(2026, 4, 1),
            tzid="America/Los_Angeles",
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-03-04T17:00:00+00:00",
            "2026-03-11T16:00:00+00:00",
            "2026-03-18T16:00:00+00:00",
        ]
        # duration 保持 30min
        assert all(e - s == timedelta(minutes=30) for s, e in occs)

    def test_la_fall_back_wall_clock_constant(self):
        """LA 2026-11-01 冬令回拨: 09:00 墙钟恒定, UTC 侧 16:00Z→17:00Z."""
        occs = expand_in_window(
            dtstart=_utc(2026, 10, 28, 16), dtend=_utc(2026, 10, 28, 17),
            rrule="FREQ=WEEKLY;COUNT=2", exdates_iso=[], rdates_iso=[],
            window_start=_utc(2026, 10, 25), window_end=_utc(2026, 11, 10),
            tzid="America/Los_Angeles",
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-10-28T16:00:00+00:00",
            "2026-11-04T17:00:00+00:00",
        ]

    def test_shanghai_no_dst_control(self):
        """Asia/Shanghai 无 DST 对照: UTC 时刻恒定 (跨 3 月 LA DST 边界不受扰)."""
        occs = expand_in_window(
            dtstart=_utc(2026, 3, 4, 1), dtend=_utc(2026, 3, 4, 2),
            rrule="FREQ=WEEKLY;COUNT=3", exdates_iso=[], rdates_iso=[],
            window_start=_utc(2026, 3, 1), window_end=_utc(2026, 4, 1),
            tzid="Asia/Shanghai",
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-03-04T01:00:00+00:00",
            "2026-03-11T01:00:00+00:00",
            "2026-03-18T01:00:00+00:00",
        ]

    def test_tzid_none_keeps_utc_grid(self):
        """tzid=None (v35 前旧行 / 裸 Z): 现状 UTC 展开, 跨 DST 不偏移."""
        occs = expand_in_window(
            dtstart=_utc(2026, 3, 4, 17), dtend=_utc(2026, 3, 4, 17, 30),
            rrule="FREQ=WEEKLY;COUNT=3", exdates_iso=[], rdates_iso=[],
            window_start=_utc(2026, 3, 1), window_end=_utc(2026, 4, 1),
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-03-04T17:00:00+00:00",
            "2026-03-11T17:00:00+00:00",
            "2026-03-18T17:00:00+00:00",
        ]

    def test_unresolvable_tzid_falls_back_to_utc(self):
        occs = expand_in_window(
            dtstart=_utc(2026, 3, 4, 17), dtend=_utc(2026, 3, 4, 17, 30),
            rrule="FREQ=WEEKLY;COUNT=3", exdates_iso=[], rdates_iso=[],
            window_start=_utc(2026, 3, 1), window_end=_utc(2026, 4, 1),
            tzid="Fake/Zone",
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-03-04T17:00:00+00:00",
            "2026-03-11T17:00:00+00:00",
            "2026-03-18T17:00:00+00:00",
        ]

    def test_until_absolute_utc_semantics_with_tzid(self):
        """UNTIL=Z 在 tzid 路径按绝对时刻裁剪 (TS 侧摘出后置过滤对齐此语义)."""
        occs = expand_in_window(
            dtstart=_utc(2026, 9, 4, 1), dtend=_utc(2026, 9, 4, 2),
            rrule="FREQ=DAILY;UNTIL=20260906T010000Z", exdates_iso=[], rdates_iso=[],
            window_start=_utc(2026, 9, 1), window_end=_utc(2026, 9, 30),
            tzid="America/Los_Angeles",
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-09-04T01:00:00+00:00",
            "2026-09-05T01:00:00+00:00",
            "2026-09-06T01:00:00+00:00",
        ]

    def test_exdate_matches_in_utc_with_tzid(self):
        """EXDATE 按 UTC 时刻匹配 (跨 DST 后的 16:00Z occurrence 可被剔除)."""
        occs = expand_in_window(
            dtstart=_utc(2026, 3, 4, 17), dtend=_utc(2026, 3, 4, 17, 30),
            rrule="FREQ=WEEKLY;COUNT=3",
            exdates_iso=["2026-03-11T16:00:00+00:00"], rdates_iso=[],
            window_start=_utc(2026, 3, 1), window_end=_utc(2026, 4, 1),
            tzid="America/Los_Angeles",
        )
        assert [s.isoformat() for s, _ in occs] == [
            "2026-03-04T17:00:00+00:00",
            "2026-03-18T16:00:00+00:00",
        ]
