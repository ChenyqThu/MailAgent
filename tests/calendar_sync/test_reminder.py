"""MeetingReminder (阶段2·2.5 会前岛提醒) — 窗口命中/幂等/门控/跳过规则.

island_dispatch 出口全 monkeypatch (不碰 socket); repo 用 conftest 真 SQLite.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from src.calendar_sync.reminder import MeetingReminder, extract_join_url

TEAMS_URL = (
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x"
)


@pytest.fixture
def dispatched(monkeypatch):
    """Patch island_dispatch: enabled=True + 捕获 dispatch_meeting_reminder 调用."""
    from src.notify import island_dispatch

    calls: list[dict] = []
    monkeypatch.setattr(island_dispatch, "is_enabled", lambda: True)
    monkeypatch.setattr(
        island_dispatch,
        "dispatch_meeting_reminder",
        lambda **kw: calls.append(kw),
    )
    return calls


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _seed(repo, make_event, *, uid: str, start: datetime, **over) -> None:
    repo.upsert_from_caldav_event(make_event(uid, start=start, **over))


def test_window_hit_dispatches_once_with_join_url(repo, make_event, dispatched):
    """窗口内 (start-now ≤ lead) 的会 → 发卡一次, join_url 从 url 字段提取."""
    now = _now()
    _seed(repo, make_event, uid="ev-hit", start=now + timedelta(minutes=5),
          summary="架构评审", url=TEAMS_URL)

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 1
    assert len(dispatched) == 1
    kw = dispatched[0]
    assert kw["ical_uid"] == "ev-hit"
    assert kw["summary"] == "架构评审"
    assert kw["join_url"] == TEAMS_URL
    # 幂等: 第二轮 tick 不重发
    assert r.tick(now + timedelta(seconds=60)) == 0
    assert len(dispatched) == 1


def test_outside_window_or_started_skipped(repo, make_event, dispatched):
    """窗口外 (30min 后) 与已开始的会都不发."""
    now = _now()
    _seed(repo, make_event, uid="ev-far", start=now + timedelta(minutes=30))
    _seed(repo, make_event, uid="ev-started", start=now - timedelta(minutes=5))

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 0
    assert dispatched == []
    # 时间推进到窗口内 → ev-far 补发
    assert r.tick(now + timedelta(minutes=21)) == 1
    assert dispatched[0]["ical_uid"] == "ev-far"


def test_cancelled_declined_allday_skipped(repo, make_event, dispatched):
    """CANCELLED / 本人已 DECLINED / 全天事件不提醒."""
    now = _now()
    _seed(repo, make_event, uid="ev-cancel", start=now + timedelta(minutes=5),
          status="CANCELLED")
    _seed(repo, make_event, uid="ev-decline", start=now + timedelta(minutes=5),
          response_status="DECLINED")
    allday = make_event("ev-allday", start=now + timedelta(minutes=5))
    allday.is_all_day = True
    repo.upsert_from_caldav_event(allday)

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 0
    assert dispatched == []


def test_flag_off_inert_and_recoverable(repo, make_event, monkeypatch):
    """island 派发关 → 整条 inert 且不标记已提醒; 中途打开 → 补发."""
    from src.notify import island_dispatch

    calls: list[dict] = []
    enabled = {"v": False}
    monkeypatch.setattr(island_dispatch, "is_enabled", lambda: enabled["v"])
    monkeypatch.setattr(
        island_dispatch, "dispatch_meeting_reminder", lambda **kw: calls.append(kw)
    )

    now = _now()
    _seed(repo, make_event, uid="ev-gated", start=now + timedelta(minutes=5))

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 0
    assert calls == []
    enabled["v"] = True
    assert r.tick(now + timedelta(seconds=60)) == 1
    assert calls[0]["ical_uid"] == "ev-gated"


def test_notified_marks_pruned_after_meeting(repo, make_event, dispatched):
    """幂等标记在会议开始 1h 后清理 (长跑进程不无界增长)."""
    now = _now()
    _seed(repo, make_event, uid="ev-prune", start=now + timedelta(minutes=5))

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 1
    assert len(r._notified) == 1
    r.tick(now + timedelta(hours=2))
    assert r._notified == {}


def test_repo_failure_fail_open(make_event, dispatched):
    """repo 查询抛异常 → 静默返回 0, 不上抛 (不连坐 sync loop)."""

    class BoomRepo:
        def list_event_occurrences(self, *a, **kw):
            raise RuntimeError("db locked")

    r = MeetingReminder(BoomRepo(), lead_minutes=10)
    assert r.tick(_now()) == 0
    assert dispatched == []


class TestExtractJoinUrl:
    def test_priority_and_variants(self):
        zoom = "https://us02web.zoom.us/j/98765432101"
        meet = "https://meet.google.com/abc-defg-hij"
        # url > location > description
        assert extract_join_url(TEAMS_URL, zoom, meet) == TEAMS_URL
        assert extract_join_url("", zoom, meet) == zoom
        assert extract_join_url(None, "", meet) == meet

    def test_text_wrapped_and_trailing_punct(self):
        desc = f"Microsoft Teams 会议\n加入: <{TEAMS_URL}>\nID: 123"
        assert extract_join_url(desc) == TEAMS_URL
        assert extract_join_url("请点 https://meet.google.com/abc-defg-hij.") == (
            "https://meet.google.com/abc-defg-hij"
        )

    def test_non_meeting_urls_ignored(self):
        assert extract_join_url("https://example.com/meeting") == ""
        assert extract_join_url("https://teams.microsoft.com/downloads") == ""
        assert extract_join_url("https://zoom.us/pricing", None) == ""
        assert extract_join_url() == ""
