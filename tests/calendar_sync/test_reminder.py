"""MeetingReminder (会前 NotifyCenter 提醒) — 窗口命中/幂等/跳过规则."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.calendar_sync.reminder import MeetingReminder, extract_join_url
from src.notify.center import NotifyCenter

TEAMS_URL = (
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x"
)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _seed(repo, make_event, *, uid: str, start: datetime, **over) -> None:
    repo.upsert_from_caldav_event(make_event(uid, start=start, **over))


def test_window_hit_publishes_once_with_join_url(repo, make_event):
    """窗口内 (start-now ≤ lead) 的会 → 发布一条 NotifyCenter 提醒, 带 joinUrl."""
    now = _now()
    _seed(
        repo,
        make_event,
        uid="ev-hit",
        start=now + timedelta(minutes=5),
        summary="架构评审",
        url=TEAMS_URL,
        location="Room 3B",
    )

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 1
    items = NotifyCenter(repo.db_path).list(limit=10).items
    assert len(items) == 1
    item = items[0]
    assert item["category"] == "action_required"
    assert item["source"] == "calendar_reminder"
    assert item["severity"] == "warn"
    assert item["title"] == "架构评审"
    assert "Room 3B" in item["body"]
    occ_iso = (now + timedelta(minutes=5)).isoformat()
    assert item["payload"] == {
        "delivery": "both",
        "icalUid": "ev-hit",
        "occurrenceStartIso": occ_iso,
        "link": {
            "type": "route",
            "to": "/admin/calendar",
            "search": {
                "view": "today",
                "icalUid": "ev-hit",
                "dateIso": occ_iso,
                "openDrawer": True,
            },
        },
        "joinUrl": TEAMS_URL,
        "actions": [
            {"id": "join_meeting", "label": "一键入会", "url": TEAMS_URL},
            {
                "id": "open_calendar_ai",
                "label": "AI 跟进此会",
                "icalUid": "ev-hit",
                "recurrenceId": None,
                "occurrenceStartIso": occ_iso,
                "meetingSummary": "架构评审",
            },
        ],
    }
    # 幂等: 第二轮 tick 不重发
    assert r.tick(now + timedelta(seconds=60)) == 0
    assert len(NotifyCenter(repo.db_path).list(limit=10).items) == 1


def test_outside_window_or_started_skipped(repo, make_event):
    """窗口外 (30min 后) 与已开始的会都不发."""
    now = _now()
    _seed(repo, make_event, uid="ev-far", start=now + timedelta(minutes=30))
    _seed(repo, make_event, uid="ev-started", start=now - timedelta(minutes=5))

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 0
    assert NotifyCenter(repo.db_path).list(limit=10).items == []
    # 时间推进到窗口内 → ev-far 补发
    assert r.tick(now + timedelta(minutes=21)) == 1
    assert len(NotifyCenter(repo.db_path).list(limit=10).items) == 1


def test_cancelled_declined_allday_skipped(repo, make_event):
    """CANCELLED / 本人已 DECLINED / 全天事件不提醒."""
    now = _now()
    _seed(repo, make_event, uid="ev-cancel", start=now + timedelta(minutes=5), status="CANCELLED")
    _seed(repo, make_event, uid="ev-decline", start=now + timedelta(minutes=5), response_status="DECLINED")
    allday = make_event("ev-allday", start=now + timedelta(minutes=5))
    allday.is_all_day = True
    repo.upsert_from_caldav_event(allday)

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 0
    assert NotifyCenter(repo.db_path).list(limit=10).items == []


def test_notified_marks_pruned_after_meeting(repo, make_event):
    """幂等标记在会议开始 1h 后清理 (长跑进程不无界增长)."""
    now = _now()
    _seed(repo, make_event, uid="ev-prune", start=now + timedelta(minutes=5))

    r = MeetingReminder(repo, lead_minutes=10)
    assert r.tick(now) == 1
    assert len(r._center_notified) == 1
    r.tick(now + timedelta(hours=2))
    assert r._center_notified == {}


def test_repo_failure_fail_open():
    """repo 查询抛异常 → 静默返回 0, 不上抛."""
    class BoomRepo:
        db_path = "unused.db"

        def list_event_occurrences(self, *a, **kw):
            raise RuntimeError("db locked")

    r = MeetingReminder(BoomRepo(), lead_minutes=10)  # type: ignore[arg-type]
    assert r.tick(_now()) == 0


class TestExtractJoinUrl:
    def test_priority_and_variants(self):
        zoom = "https://us02web.zoom.us/j/98765432101"
        meet = "https://meet.google.com/abc-defg-hij"
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


def test_meeting_reminder_channels_and_prep_session_button(repo, make_event):
    from src.notify.prefs import (
        MEETING_PREP_PRESET_AGENT_ID,
        lookup_meeting_prep_session,
        record_meeting_prep_session,
        save_notification_prefs,
    )

    now = _now()
    occ_start = now + timedelta(minutes=8)
    _seed(
        repo,
        make_event,
        uid="uid-prep-1",
        start=occ_start,
        summary="季度规划会",
        url="https://meet.google.com/abc-defg-hij",
        organizer="alice@example.com",
        status="CONFIRMED",
        response_status="ACCEPTED",
    )

    save_notification_prefs(repo.db_path, {"meetingDelivery": "off"})
    reminder = MeetingReminder(repo)
    assert reminder.tick(now) == 0

    save_notification_prefs(
        repo.db_path,
        {"meetingDelivery": "system_only", "meetingPrepEnabled": True},
    )
    assert reminder.tick(now) == 1
    rows = NotifyCenter(repo.db_path).list(state="all").items
    assert len(rows) == 1
    assert rows[0]["state"] == "resolved"
    actions = rows[0]["payload"]["actions"]
    assert [a["id"] for a in actions] == ["join_meeting", "meeting_prep"]
    assert actions[1]["label"] == "立即会前准备"

    record_meeting_prep_session(repo.db_path, "uid-prep-1", occ_start.isoformat(), 42)
    assert lookup_meeting_prep_session(repo.db_path, "uid-prep-1", occ_start.isoformat()) == {
        "session_id": 42,
        "agent_id": MEETING_PREP_PRESET_AGENT_ID,
    }
    reminder2 = MeetingReminder(repo)
    save_notification_prefs(repo.db_path, {"meetingDelivery": "both"})
    assert reminder2.tick(now) == 1
    rows2 = NotifyCenter(repo.db_path).list(state="open").items
    assert rows2[0]["payload"]["actions"][1]["label"] == "查看会前准备"
    assert rows2[0]["payload"]["actions"][1]["prepSessionId"] == 42
