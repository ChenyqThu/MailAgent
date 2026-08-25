"""L4 批次 1 Lane A：event 资源接活（#1）、calendar_event_ended 触发（#2）、event→matter 提案（#3）。

三块共享同一批 calendar_event 夹具。#3 的零自动写红线在断言里钉死：
落库的 link 恒 ``confirmed_at IS NULL``。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from src.calendar_sync.repository import CalendarEventRepository
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import RESOURCE_SUGGESTION_BACKLOG_CAP, MatterService
from src.matters.worker import CALENDAR_ENDED_WATERMARK_KEY, MatterAgendaWorker

NOW_DT = datetime(2026, 8, 11, 9, 5, tzinfo=timezone.utc)
NOW = int(NOW_DT.timestamp() * 1000)


class FakeState:
    def __init__(self):
        self.values = {}

    def get_state(self, key):
        return self.values.get(key)

    def set_state(self, key, value):
        self.values[key] = value
        return True


class FakeRuns:
    def __init__(self):
        self.calls = []

    def enqueue_run(self, public_id, **kwargs):
        self.calls.append((public_id, kwargs))
        return {"run": {"id": 1}, "coalesced": False}


def _insert_event(
    db_path,
    *,
    uid,
    start,
    end,
    attendees=None,
    status="CONFIRMED",
    rrule="",
    recurrence_id=None,
    deleted_at=None,
    summary="周会",
):
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "INSERT INTO calendar_event (ical_uid, recurrence_id, sequence, calendar_name, "
            "summary, description, location, organizer, attendees_json, dtstart_utc, "
            "dtend_utc, is_all_day, rrule, exdates_json, rdates_json, status, "
            "response_status, url, ics_raw, source, last_synced_at, deleted_at, "
            "created_at, updated_at) VALUES (?,?,0,'日历',?,'','','',?,?,?,0,?,'[]','[]',"
            "?,'','','','caldav',?,?,?,?)",
            (
                uid, recurrence_id, summary, json.dumps(attendees or []),
                start.timestamp(), end.timestamp(), rrule, status,
                NOW_DT.timestamp(), deleted_at, NOW_DT.timestamp(), NOW_DT.timestamp(),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _env(tmp_path, name="calendar-ended.db"):
    path = tmp_path / name
    SyncStore(str(path))
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    matter = service.create_matter(
        {"title": "对接项目"}, idempotency_key="create", source="test"
    )["matter"]
    return path, repo, service, matter


def _set_event_trigger(path, matter_id):
    envelope = {
        "v": 2,
        "triggers": [
            {"id": "mtr_cal", "kind": "event", "enabled": True,
             "event_type": "calendar_event_ended"},
        ],
    }
    with sqlite3.connect(str(path)) as conn:
        conn.execute(
            "UPDATE matter SET agent_enabled=1, schedule_json=? WHERE id=?",
            (json.dumps(envelope), matter_id),
        )
        conn.commit()


def _confirm_event_resource(service, matter, uid, *, confirmed=True):
    return service.add_resource(
        matter["public_id"],
        {
            "provider": "mailagent", "kind": "event",
            "external_key": f"event:{uid}", "title": "周会", "confirmed": confirmed,
        },
        expected_version=int(matter["version"]),
        idempotency_key=f"add-{uid}-{confirmed}",
        source="desktop_ui",
    )


def _stakeholder(path, matter_id, *, email=None, contact_id=None):
    with sqlite3.connect(str(path)) as conn:
        conn.execute(
            "INSERT INTO matter_stakeholder (matter_id, person_key, display_name, "
            "email_normalized, contact_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (matter_id, email or f"contact:{contact_id}", "Alice", email, contact_id, NOW, NOW),
        )
        conn.commit()


def _contact_with_anchor(path, email):
    with sqlite3.connect(str(path)) as conn:
        cursor = conn.execute(
            "INSERT INTO contact (created_at, updated_at) VALUES (?,?)", (NOW, NOW)
        )
        contact_id = int(cursor.lastrowid)
        conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, created_at) "
            "VALUES (?,?,?)",
            (contact_id, email, NOW),
        )
        conn.commit()
    return contact_id


@pytest.fixture
def calendar_on(monkeypatch):
    from src.config import config

    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)


@pytest.fixture
def calendar_off(monkeypatch):
    from src.config import config

    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", False)


def _worker(repo, state=None, runs=None, clock_ms=None):
    return MatterAgendaWorker(
        repository=repo,
        sync_store=state or FakeState(),
        clock_ms=clock_ms or (lambda: NOW),
        run_service=runs or FakeRuns(),
    )


# ── #2 共享原语：list_ended_occurrences ────────────────────────────────────────


def test_list_ended_occurrences_window_and_exclusions(tmp_path):
    path = tmp_path / "cal.db"
    SyncStore(str(path))
    window_start = NOW_DT - timedelta(minutes=30)
    _insert_event(
        path, uid="ended",
        start=NOW_DT - timedelta(minutes=50), end=NOW_DT - timedelta(minutes=10),
    )
    _insert_event(
        path, uid="running",
        start=NOW_DT - timedelta(minutes=10), end=NOW_DT + timedelta(minutes=20),
    )
    _insert_event(
        path, uid="cancelled", status="CANCELLED",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=5),
    )
    _insert_event(
        path, uid="soft-deleted", deleted_at=NOW_DT.timestamp(),
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=5),
    )
    # 左开：结束恰在 window_start 的属于上一个窗口，不重复消费。
    _insert_event(
        path, uid="at-start",
        start=window_start - timedelta(minutes=30), end=window_start,
    )
    repo = CalendarEventRepository(str(path), pool=False)
    ended = repo.list_ended_occurrences(window_start, NOW_DT)
    assert [occ.row.ical_uid for occ in ended] == ["ended"]
    # 右闭：结束恰在 window_end 的算本窗口。
    at_end = repo.list_ended_occurrences(NOW_DT - timedelta(minutes=10), NOW_DT + timedelta(minutes=20))
    assert "running" in [occ.row.ical_uid for occ in at_end]


def test_list_ended_occurrences_expands_rrule_and_straddles_window_start(tmp_path):
    path = tmp_path / "cal-rrule.db"
    SyncStore(str(path))
    # 每日 08:30-08:50；今天这场 08:30 开始（早于窗口起点 08:35）、08:50 结束（在窗口内）。
    _insert_event(
        path, uid="daily", rrule="FREQ=DAILY",
        start=datetime(2026, 8, 1, 8, 30, tzinfo=timezone.utc),
        end=datetime(2026, 8, 1, 8, 50, tzinfo=timezone.utc),
    )
    repo = CalendarEventRepository(str(path), pool=False)
    ended = repo.list_ended_occurrences(NOW_DT - timedelta(minutes=30), NOW_DT)
    assert len(ended) == 1
    occurrence = ended[0]
    assert occurrence.is_recurrence_instance is True
    assert occurrence.occurrence_end_utc == datetime(2026, 8, 11, 8, 50, tzinfo=timezone.utc)
    # 昨天的 occurrence 不落本窗口。
    assert all(
        occ.occurrence_end_utc.date() == NOW_DT.date()
        for occ in ended
    )


# ── #1：event 资源的存在性判定 ────────────────────────────────────────────────


def test_resource_available_checks_calendar_event_rows(tmp_path):
    path = tmp_path / "avail.db"
    SyncStore(str(path))
    _insert_event(
        path, uid="uid-1",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
    )
    _insert_event(
        path, uid="uid-gone", deleted_at=NOW_DT.timestamp(),
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
    )
    repo = MatterRepository(path)
    with repo.connect() as conn:
        assert repo.resource_available(conn, "mailagent", "event", "event:uid-1") is True
        assert repo.resource_available(conn, "mailagent", "event", "uid-1") is True
        assert repo.resource_available(conn, "mailagent", "event", "event:absent") is False
        # 软删行不算在。
        assert repo.resource_available(conn, "mailagent", "event", "event:uid-gone") is False


# ── #2：calendar_event_ended 触发 ─────────────────────────────────────────────


def test_calendar_ended_trigger_fires_once_per_occurrence(tmp_path, calendar_on):
    path, repo, service, matter = _env(tmp_path)
    _insert_event(
        path, uid="uid-1",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
    )
    _confirm_event_resource(service, matter, "uid-1")
    _set_event_trigger(path, matter["id"])
    state, runs = FakeState(), FakeRuns()
    worker = _worker(repo, state, runs)
    assert worker._schedule_tick() == {matter["id"]}
    assert len(runs.calls) == 1
    assert runs.calls[0][1]["trigger_kind"] == "event"
    assert runs.calls[0][1]["source"] == "matter_event"
    # marker 幂等：同一 occurrence 不重复 fire。
    assert worker._schedule_tick() == set()
    assert len(runs.calls) == 1
    # 新的一场结束 = 新证据标识 = 再 fire。
    later = NOW_DT + timedelta(hours=1)
    _insert_event(
        path, uid="uid-1", recurrence_id="20260811T100000Z",
        start=later - timedelta(minutes=30), end=later - timedelta(minutes=5),
    )
    later_worker = _worker(
        repo, state, runs, clock_ms=lambda: int(later.timestamp() * 1000)
    )
    assert later_worker._schedule_tick() == {matter["id"]}
    assert len(runs.calls) == 2


def test_calendar_ended_trigger_gates(tmp_path, calendar_off):
    """日历同步关闭 / 资料未确认 / 迟到超窗，三种都静默不 fire。"""
    path, repo, service, matter = _env(tmp_path)
    _insert_event(
        path, uid="uid-1",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
    )
    _confirm_event_resource(service, matter, "uid-1")
    _set_event_trigger(path, matter["id"])
    runs = FakeRuns()
    assert _worker(repo, runs=runs)._schedule_tick() == set()
    assert runs.calls == []

    from src.config import config
    import pytest as _pytest

    patch = _pytest.MonkeyPatch()
    patch.setattr(config, "calendar_caldav_sync_enabled", True)
    try:
        # 未确认的 agent 建议不驱动跟进 run。
        path2, repo2, service2, matter2 = _env(tmp_path, "unconfirmed.db")
        _insert_event(
            path2, uid="uid-2",
            start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
        )
        _confirm_event_resource(service2, matter2, "uid-2", confirmed=False)
        _set_event_trigger(path2, matter2["id"])
        runs2 = FakeRuns()
        assert _worker(repo2, runs=runs2)._schedule_tick() == set()
        assert runs2.calls == []

        # 结束超过 30 分钟窗口的不补跑。
        path3, repo3, service3, matter3 = _env(tmp_path, "late.db")
        _insert_event(
            path3, uid="uid-3",
            start=NOW_DT - timedelta(hours=2), end=NOW_DT - timedelta(minutes=45),
        )
        _confirm_event_resource(service3, matter3, "uid-3")
        _set_event_trigger(path3, matter3["id"])
        runs3 = FakeRuns()
        assert _worker(repo3, runs=runs3)._schedule_tick() == set()
        assert runs3.calls == []
    finally:
        patch.undo()


def test_event_trigger_enqueues_through_real_run_service(tmp_path, calendar_on):
    """回归：enqueue_run 此前只放行 manual/schedule —— event trigger 一 fire 就被拒，
    被 _schedule_tick 的 per-trigger 兜底吞成 warning（FakeRuns 测不出来）。"""
    path, repo, service, matter = _env(tmp_path)
    _insert_event(
        path, uid="uid-1",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
    )
    _confirm_event_resource(service, matter, "uid-1")
    _set_event_trigger(path, matter["id"])
    worker = _worker(repo, runs=MatterRunService(repo, clock_ms=lambda: NOW))
    assert worker._schedule_tick() == {matter["id"]}
    with repo.connect() as conn:
        row = conn.execute(
            "SELECT trigger_kind FROM matter_run WHERE matter_id=?", (matter["id"],)
        ).fetchone()
    assert row is not None and row["trigger_kind"] == "event"


# ── #3：event→matter 关联提案 ─────────────────────────────────────────────────


def _live_links(repo, matter_id):
    with repo.connect() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT mr.*, r.external_key, r.kind AS resource_kind FROM matter_resource mr "
                "JOIN resource r ON r.id=mr.resource_id "
                "WHERE mr.matter_id=? AND mr.deleted_at IS NULL",
                (matter_id,),
            ).fetchall()
        ]


def test_proposal_end_to_end_idempotent_and_rejection_suppressed(tmp_path, calendar_on):
    path, repo, service, matter = _env(tmp_path)
    _stakeholder(path, matter["id"], email="alice@x.test")
    _insert_event(
        path, uid="uid-1",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
        attendees=[{"email": "Alice@X.test", "name": "Alice", "response": "ACCEPTED"}],
    )
    state = FakeState()
    worker = _worker(repo, state)
    worker._calendar_proposal_tick()

    links = _live_links(repo, matter["id"])
    assert len(links) == 1
    link = links[0]
    assert link["external_key"] == "event:uid-1"
    assert link["resource_kind"] == "event"
    # 🔴 零自动写：恒是未确认的 agent 建议。
    assert link["confirmed_at"] is None
    assert link["added_by_kind"] == "agent"
    provenance = json.loads(link["provenance_json"])
    assert provenance["evidence"] == ["stakeholder:alice@x.test"]
    assert provenance["reason"] == "calendar_event_ended"
    assert state.values[CALENDAR_ENDED_WATERMARK_KEY] == NOW_DT.isoformat()

    # 幂等：重置 watermark 再跑一轮，不产生第二条。
    state.values.pop(CALENDAR_ENDED_WATERMARK_KEY)
    worker._calendar_proposal_tick()
    assert len(_live_links(repo, matter["id"])) == 1

    # 拒绝后同形态（同 durable 证据）不再提案。
    with repo.connect() as conn:
        version = int(
            conn.execute(
                "SELECT version FROM matter WHERE id=?", (matter["id"],)
            ).fetchone()[0]
        )
    service.reject_resource_suggestion(
        matter["public_id"], int(link["resource_id"]),
        expected_version=version, idempotency_key="rej-1", source="desktop_ui",
    )
    assert _live_links(repo, matter["id"]) == []
    state.values.pop(CALENDAR_ENDED_WATERMARK_KEY)
    worker._calendar_proposal_tick()
    assert _live_links(repo, matter["id"]) == [], "拒绝记忆必须抑制同形态提案"
    with repo.connect() as conn:
        rejection = conn.execute(
            "SELECT * FROM matter_resource_rejection WHERE matter_id=?",
            (matter["id"],),
        ).fetchone()
    assert rejection is not None
    assert rejection["resource_key"] == "mailagent:event:uid-1"


def test_proposal_contact_leg_and_no_email_attendees(tmp_path, calendar_on):
    path, repo, service, matter = _env(tmp_path)
    # 无邮箱与会者（会议室 / 老数据兜底形状）不产生任何提案。
    _insert_event(
        path, uid="room-only",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
        attendees=[{"name": "会议室 A"}],
    )
    # contact 腿：干系人行没有 email_normalized，但 contact_id 绑着锚点。
    contact_id = _contact_with_anchor(path, "bob@x.test")
    _stakeholder(path, matter["id"], email=None, contact_id=contact_id)
    _insert_event(
        path, uid="uid-2",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
        attendees=[{"email": "bob@x.test"}],
    )
    worker = _worker(repo)
    worker._calendar_proposal_tick()
    links = _live_links(repo, matter["id"])
    assert [link["external_key"] for link in links] == ["event:uid-2"]
    assert links[0]["confirmed_at"] is None


def test_proposal_respects_backlog_cap(tmp_path, calendar_on):
    """积压守卫：待审建议堆到上限就停手（与 `discover_resource_suggestions` 同一条闸）。

    一天里结束的会议可以远多于 owner 愿意审的条数 —— 没有这道守卫，一个开着的事项
    会被日历刷成一屏未确认建议。
    """
    path, repo, service, matter = _env(tmp_path)
    _stakeholder(path, matter["id"], email="alice@x.test")
    for index in range(RESOURCE_SUGGESTION_BACKLOG_CAP + 3):
        _insert_event(
            path, uid=f"uid-{index}",
            start=NOW_DT - timedelta(minutes=40 - index),
            end=NOW_DT - timedelta(minutes=20 - index),
            attendees=[{"email": "alice@x.test"}],
        )
    _worker(repo)._calendar_proposal_tick()
    assert len(_live_links(repo, matter["id"])) == RESOURCE_SUGGESTION_BACKLOG_CAP


def test_proposal_skips_closed_matters_and_disabled_sync(tmp_path, calendar_off):
    path, repo, service, matter = _env(tmp_path)
    _stakeholder(path, matter["id"], email="alice@x.test")
    _insert_event(
        path, uid="uid-1",
        start=NOW_DT - timedelta(minutes=40), end=NOW_DT - timedelta(minutes=10),
        attendees=[{"email": "alice@x.test"}],
    )
    worker = _worker(repo)
    # 日历同步关闭：整段跳过，watermark 也不动。
    worker._calendar_proposal_tick()
    assert _live_links(repo, matter["id"]) == []

    from src.config import config
    import pytest as _pytest

    patch = _pytest.MonkeyPatch()
    patch.setattr(config, "calendar_caldav_sync_enabled", True)
    try:
        # 终态事项不接提案。
        with sqlite3.connect(str(path)) as conn:
            conn.execute(
                "UPDATE matter SET status='done' WHERE id=?", (matter["id"],)
            )
            conn.commit()
        worker._calendar_proposal_tick()
        assert _live_links(repo, matter["id"]) == []
    finally:
        patch.undo()
