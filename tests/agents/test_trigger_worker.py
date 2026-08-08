"""AgentTriggerWorker cron 判定 + tick_loop 单测（S4 W1, ADR D5 rev1）。

_due_fire 纯函数（注入 now_utc + marker）：UTC marker / cron_hash 失效 / 单次 catch-up /
错过窗口不补 / DST 双向。tick_loop：只 fire enabled type='custom' cron 行 → 入队 agent_run。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from src.agents import trigger_worker as tw
from src.agents.trigger import CronTrigger, parse_trigger
from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository

_UTC = timezone.utc


def _marker(occ: datetime, trigger: CronTrigger) -> str:
    return tw._make_marker(occ, tw._cron_hash(trigger))


# ============================================================
# _due_fire — 基本 fire / 去重 / 窗口
# ============================================================

def test_fire_within_window():
    cron = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
    now = datetime(2026, 7, 3, 1, 0, 30, tzinfo=_UTC)  # 09:00:30 CST
    occ = tw._due_fire(cron, now, None)
    assert occ == datetime(2026, 7, 3, 1, 0, 0, tzinfo=_UTC)


def test_no_double_fire_same_occurrence():
    cron = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
    now = datetime(2026, 7, 3, 1, 0, 30, tzinfo=_UTC)
    occ = tw._due_fire(cron, now, None)
    assert tw._due_fire(cron, now, _marker(occ, cron)) is None


def test_missed_window_not_caught_up():
    cron = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
    now = datetime(2026, 7, 3, 1, 45, 0, tzinfo=_UTC)  # 09:45 CST, 45min > 30min 窗
    assert tw._due_fire(cron, now, None) is None


def test_catch_up_within_window():
    # app 20min 后才起 → occurrence 仍在 30min 窗内 → 补一次。
    cron = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
    now = datetime(2026, 7, 3, 1, 20, 0, tzinfo=_UTC)  # 09:20 CST
    assert tw._due_fire(cron, now, None) == datetime(2026, 7, 3, 1, 0, 0, tzinfo=_UTC)


def test_cron_hash_invalidation_refires():
    # marker 的 cron_hash 是旧 schedule 的 → 失配 → 视作从未 fire → 重新判定。
    cur = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
    old = CronTrigger(cron="0 8 * * *", timezone="Asia/Shanghai")
    now = datetime(2026, 7, 3, 1, 0, 30, tzinfo=_UTC)
    occ = tw._due_fire(cur, now, None)
    stale = _marker(occ, old)  # 用旧 cron 的 hash
    assert tw._due_fire(cur, now, stale) == occ


def test_timezone_change_invalidates_marker():
    cst = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
    utc = CronTrigger(cron="0 9 * * *", timezone="UTC")
    # 两者 cron_hash 不同（timezone 进 hash）。
    assert tw._cron_hash(cst) != tw._cron_hash(utc)


def test_next_occurrence_fires_after_prior_marker():
    cron = CronTrigger(cron="0 9 * * *", timezone="UTC")
    day1 = datetime(2026, 7, 3, 9, 0, 30, tzinfo=_UTC)
    occ1 = tw._due_fire(cron, day1, None)
    mk = _marker(occ1, cron)
    # 次日 09:00:30 → 新 occurrence > marker → fire。
    day2 = datetime(2026, 7, 4, 9, 0, 30, tzinfo=_UTC)
    occ2 = tw._due_fire(cron, day2, mk)
    assert occ2 == datetime(2026, 7, 4, 9, 0, 0, tzinfo=_UTC)


# ============================================================
# DST 双向（UTC marker + croniter 双保险）
# ============================================================

def test_dst_spring_forward_fires_once():
    # America/New_York 2026-03-08 spring forward 02:00→03:00。cron 03:00 在切换后（EDT -04:00）
    # = 07:00 UTC。firing 一次，marker 防重。
    cron = CronTrigger(cron="0 3 * * *", timezone="America/New_York")
    now = datetime(2026, 3, 8, 7, 0, 30, tzinfo=_UTC)  # 03:00:30 EDT
    occ = tw._due_fire(cron, now, None)
    assert occ == datetime(2026, 3, 8, 7, 0, 0, tzinfo=_UTC)
    assert tw._due_fire(cron, now, _marker(occ, cron)) is None


def test_dst_spring_forward_missing_hour_no_crash():
    # cron 02:30 在 spring-forward 日不存在；croniter 跳到下一有效 occurrence，不崩。
    cron = CronTrigger(cron="30 2 * * *", timezone="America/New_York")
    now = datetime(2026, 3, 8, 7, 30, 0, tzinfo=_UTC)
    # 只要不抛异常即可（返回 None 或某 occurrence 都可接受，关键是 DST 缺失小时不崩）。
    tw._due_fire(cron, now, None)


def test_dst_fall_back_no_double_fire_via_utc_marker():
    # America/New_York 2026-11-01 fall back 02:00→01:00（01:00 本地重复）。UTC marker 保证
    # 一旦 fire 了某 UTC occurrence，后续 tick 不因本地时间回拨而重复 fire 同一 UTC 时刻。
    cron = CronTrigger(cron="0 1 * * *", timezone="America/New_York")
    # 01:00 EDT = 05:00 UTC（第一次 01:00）。
    now1 = datetime(2026, 11, 1, 5, 0, 30, tzinfo=_UTC)
    occ1 = tw._due_fire(cron, now1, None)
    assert occ1 is not None
    mk = _marker(occ1, cron)
    # 同 UTC 时刻附近再判定 → 不重复。
    assert tw._due_fire(cron, now1, mk) is None


# ============================================================
# _due_fire — kind='schedule'（共享求值器路径；marker/30min 窗语义同 cron）
# ============================================================

def _sched_trigger(**over):
    """weekly interval=2 周一 09:00 Asia/Shanghai，anchor=2026-07-06（周一，on-week 原点）。"""
    payload = {
        "v": 1, "kind": "schedule",
        "rule": {
            "freq": "weekly", "interval": 2, "weekdays": [1], "monthMode": "date",
            "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0, "clamp": False,
        },
        "anchor": "2026-07-06", "timezone": "Asia/Shanghai",
    }
    payload.update(over)
    return parse_trigger(payload)


class TestScheduleDueFire:
    def test_fire_within_window(self):
        trig = _sched_trigger()
        now = datetime(2026, 7, 20, 1, 0, 30, tzinfo=_UTC)   # on-week 周一 09:00:30 CST
        occ = tw._due_fire(trig, now, None)
        assert occ == datetime(2026, 7, 20, 1, 0, 0, tzinfo=_UTC)
        # 同 occurrence 不重复 fire。
        assert tw._due_fire(trig, now, tw._make_marker(occ, tw._trigger_hash(trig))) is None

    def test_off_week_monday_does_not_fire(self):
        # interval=2 相位以 anchor 为准：2026-07-13 是 off-week 周一 → prev occurrence 是
        # 07-06（7 天前，远超 30min 窗）→ 不 fire。相位若从 now 起算这里会误 fire —— 测红。
        trig = _sched_trigger()
        assert tw._due_fire(trig, datetime(2026, 7, 13, 1, 0, 30, tzinfo=_UTC), None) is None

    def test_missed_window_not_caught_up(self):
        trig = _sched_trigger()
        assert tw._due_fire(trig, datetime(2026, 7, 20, 1, 45, 0, tzinfo=_UTC), None) is None

    def test_no_fire_before_first_occurrence(self):
        # anchor 之前无 occurrence（prev=None）→ 不 fire、不崩。
        trig = _sched_trigger()
        assert tw._due_fire(trig, datetime(2026, 7, 5, 1, 0, 30, tzinfo=_UTC), None) is None

    def test_config_change_invalidates_marker(self):
        # anchor（或 rule/timezone 任一）变更 → hash 失配 → 视作从未 fire → 重新判定。
        cur = _sched_trigger()
        old = _sched_trigger(anchor="2026-07-13")
        assert tw._trigger_hash(cur) != tw._trigger_hash(old)
        now = datetime(2026, 7, 20, 1, 0, 30, tzinfo=_UTC)
        occ = tw._due_fire(cur, now, None)
        stale = tw._make_marker(occ, tw._trigger_hash(old))
        assert tw._due_fire(cur, now, stale) == occ

    def test_cron_hash_byte_compat(self):
        # CronTrigger 的 _trigger_hash 必须与历史 _cron_hash 字节一致 —— 升级不重置存量
        # cron marker（否则 30min 窗内的 occurrence 会在升级瞬间重放一次）。
        cron = CronTrigger(cron="0 9 * * *", timezone="Asia/Shanghai")
        assert tw._trigger_hash(cron) == tw._cron_hash(cron)

    def test_dst_wall_clock_semantics(self):
        # LA 每天 9:00 跨 2026-03-08 春季前跳：切换日 occurrence = 16:00 UTC（9:00-07:00），
        # 前一日 = 17:00 UTC（9:00-08:00）—— 墙钟恒 9 点，UTC 漂移由求值器吸收。
        trig = _sched_trigger(
            rule={
                "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                "clamp": False,
            },
            anchor="2026-03-05", timezone="America/Los_Angeles",
        )
        assert tw._due_fire(trig, datetime(2026, 3, 7, 17, 0, 30, tzinfo=_UTC), None) \
            == datetime(2026, 3, 7, 17, 0, 0, tzinfo=_UTC)
        assert tw._due_fire(trig, datetime(2026, 3, 8, 16, 0, 30, tzinfo=_UTC), None) \
            == datetime(2026, 3, 8, 16, 0, 0, tzinfo=_UTC)


# ============================================================
# tick_loop 集成
# ============================================================

class _FakeStore:
    def __init__(self, agents):
        self._agents = agents

    def list_agents(self):
        return list(self._agents)


def _cron_agent(agent_id, *, enabled=1, atype="custom", cron="0 9 * * *", tz="UTC", budget=None):
    return {
        "id": agent_id,
        "type": atype,
        "enabled": enabled,
        "trigger_json": json.dumps({"v": 1, "kind": "cron", "cron": cron, "timezone": tz}),
        "budget_json": budget,
    }


@pytest.mark.asyncio
async def test_tick_loop_fires_only_enabled_custom_cron(tmp_path):
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    store = _FakeStore([
        _cron_agent("a1"),                                   # enabled custom cron → fire
        _cron_agent("a2", enabled=0),                        # disabled → skip
        _cron_agent("r1", atype="report"),                   # 非 custom → skip
        {"id": "e1", "type": "custom", "enabled": 1,         # email_filter → 本 worker 不碰
         "trigger_json": json.dumps({"v": 1, "kind": "email_filter", "subject_pattern": "x"}),
         "budget_json": None},
    ])
    now = datetime(2026, 7, 3, 9, 0, 30, tzinfo=_UTC)  # 09:00:30 UTC，命中 a1
    ev = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=ss, store=store, repo=repo, shutdown_event=ev,
        interval_sec=0.01, now_fn=lambda: now,
    ))
    await asyncio.sleep(0.06)  # 跑几个 tick（marker 去重 → 只 fire 一次）
    ev.set()
    await asyncio.wait_for(task, timeout=2)

    assert repo.count_agent_runs_since("a1", 0) == 1  # 只 fire 一次（marker 去重）
    assert repo.count_agent_runs_since("a2", 0) == 0  # disabled
    assert repo.count_agent_runs_since("r1", 0) == 0  # report
    assert repo.count_agent_runs_since("e1", 0) == 0  # email_filter 不归 cron worker
    assert ss.get_state("agent_trigger_last_fire:a1") is not None


@pytest.mark.asyncio
async def test_v2_triggers_use_independent_markers_and_skip_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(tw, "trigger_v2_enabled", lambda: True)
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    agent = {
        "id": "multi", "type": "custom", "enabled": 1,
        "trigger_json": json.dumps({
            "v": 2,
            "triggers": [
                {"id": "trg_one", "enabled": True, "kind": "cron", "cron": "0 9 * * *", "timezone": "UTC"},
                {"id": "trg_two", "enabled": True, "kind": "cron", "cron": "0 9 * * *", "timezone": "UTC"},
                {"id": "trg_off", "enabled": False, "kind": "cron", "cron": "0 9 * * *", "timezone": "UTC"},
            ],
        }),
        "budget_json": None,
    }
    now = datetime(2026, 8, 8, 9, 0, 30, tzinfo=_UTC)
    ev = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=ss, store=_FakeStore([agent]), repo=repo, shutdown_event=ev,
        interval_sec=0.01, now_fn=lambda: now,
    ))
    await asyncio.sleep(0.05)
    ev.set()
    await asyncio.wait_for(task, timeout=2)
    jobs = repo.list_agent_runs(agent_id="multi")
    assert {job.params.get("trigger_id") for job in jobs} == {"trg_one", "trg_two"}
    assert ss.get_state("agent_trigger_last_fire:multi:trg_one") is not None
    assert ss.get_state("agent_trigger_last_fire:multi:trg_two") is not None
    assert ss.get_state("agent_trigger_last_fire:multi:trg_off") is None


@pytest.mark.asyncio
async def test_flag_off_v2_schedule_trigger_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(tw, "trigger_v2_enabled", lambda: False)
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    agent = {
        "id": "multi", "type": "custom", "enabled": 1,
        "trigger_json": json.dumps({
            "v": 2,
            "triggers": [
                {"id": "trg_one", "enabled": True, "kind": "cron", "cron": "0 9 * * *", "timezone": "UTC"},
            ],
        }),
        "budget_json": None,
    }
    now = datetime(2026, 8, 8, 9, 0, 30, tzinfo=_UTC)
    ev = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=ss, store=_FakeStore([agent]), repo=repo, shutdown_event=ev,
        interval_sec=0.01, now_fn=lambda: now,
    ))
    await asyncio.sleep(0.04)
    ev.set()
    await asyncio.wait_for(task, timeout=2)
    assert repo.count_agent_runs_since("multi", 0) == 0
    assert ss.get_state("agent_trigger_last_fire:multi") is None
    assert ss.get_state("agent_trigger_last_fire:multi:trg_one") is None


@pytest.mark.asyncio
async def test_tick_loop_skips_malformed_trigger(tmp_path):
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    bad = {"id": "bad", "type": "custom", "enabled": 1,
           "trigger_json": '{"v":1,"kind":"cron","cron":"garbage"}', "budget_json": None}
    now = datetime(2026, 7, 3, 9, 0, 30, tzinfo=_UTC)
    ev = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=ss, store=_FakeStore([bad]), repo=repo, shutdown_event=ev,
        interval_sec=0.01, now_fn=lambda: now,
    ))
    await asyncio.sleep(0.04)
    ev.set()
    await asyncio.wait_for(task, timeout=2)
    # 坏 trigger 被 skip，不入队、不崩。
    assert repo.count_agent_runs_since("bad", 0) == 0


@pytest.mark.asyncio
async def test_tick_loop_fires_schedule_agent(tmp_path):
    """kind='schedule' 的 custom agent 与 cron 同走本 worker：入队 + marker 去重。"""
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    agent = {
        "id": "sch1", "type": "custom", "enabled": 1,
        "trigger_json": json.dumps({
            "v": 1, "kind": "schedule",
            "rule": {
                "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                "clamp": False,
            },
            "anchor": "2026-07-01", "timezone": "UTC",
        }),
        "budget_json": None,
    }
    now = datetime(2026, 7, 3, 9, 0, 30, tzinfo=_UTC)
    ev = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=ss, store=_FakeStore([agent]), repo=repo, shutdown_event=ev,
        interval_sec=0.01, now_fn=lambda: now,
    ))
    await asyncio.sleep(0.06)  # 跑几个 tick（marker 去重 → 只 fire 一次）
    ev.set()
    await asyncio.wait_for(task, timeout=2)

    assert repo.count_agent_runs_since("sch1", 0) == 1
    marker = json.loads(ss.get_state("agent_trigger_last_fire:sch1"))
    assert marker["fired_at_utc"].startswith("2026-07-03T09:00:00")
    assert marker["cron_hash"] == tw._trigger_hash(parse_trigger(agent["trigger_json"]))


def _calendar_event(uid: str, start: datetime, *, status: str = "CONFIRMED", rrule: str = "", tzid=None):
    from src.calendar_sync.caldav_reader import CalendarEvent

    return CalendarEvent(
        summary="Planning",
        start=start,
        end=start + timedelta(hours=1),
        ical_uid=uid,
        calendar_name="Work",
        status=status,
        rrule=rrule,
        tzid=tzid,
    )


def test_before_start_due_and_cancelled_and_flag_gates(tmp_path, monkeypatch):
    from src.agents.trigger import CalendarBeforeStartTrigger
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import config

    db = tmp_path / "calendar.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    calendar_repo = CalendarEventRepository(str(db))
    now = datetime(2026, 8, 9, 15, 0, 30, tzinfo=_UTC)
    calendar_repo.upsert_from_caldav_event(
        _calendar_event("due", datetime(2026, 8, 9, 16, tzinfo=_UTC)), source="caldav"
    )
    calendar_repo.upsert_from_caldav_event(
        _calendar_event("cancelled", datetime(2026, 8, 9, 16, tzinfo=_UTC), status="CANCELLED"),
        source="caldav",
    )
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)
    agent = {"id": "cal", "budget_json": None}
    tw._fire_calendar_before_start(
        sync_store=ss, repo=repo, agent=agent,
        trigger=CalendarBeforeStartTrigger(lead_seconds=3600), trigger_id="trg_before", now=now,
    )
    jobs = repo.list_agent_runs(agent_id="cal")
    assert len(jobs) == 1
    assert jobs[0].params["fire_key"] == "due||2026-08-09T16:00:00+00:00|3600"
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: False)
    tw._fire_calendar_before_start(
        sync_store=ss, repo=repo, agent=agent,
        trigger=CalendarBeforeStartTrigger(lead_seconds=7200), trigger_id="trg_off", now=now,
    )
    assert len(repo.list_agent_runs(agent_id="cal")) == 1


@pytest.mark.asyncio
async def test_calendar_entry_does_not_stop_cron_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(tw, "trigger_v2_enabled", lambda: True)
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: False)
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    agent = {
        "id": "mixed", "type": "custom", "enabled": 1,
        "trigger_json": json.dumps({
            "v": 2,
            "triggers": [
                {"id": "trg_cal", "enabled": True, "kind": "calendar_before_start", "lead_seconds": 3600},
                {"id": "trg_cron", "enabled": True, "kind": "cron", "cron": "0 9 * * *", "timezone": "UTC"},
            ],
        }),
        "budget_json": None,
    }
    event = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=ss, store=_FakeStore([agent]), repo=repo, shutdown_event=event,
        interval_sec=0.01, now_fn=lambda: datetime(2026, 8, 8, 9, 0, 30, tzinfo=_UTC),
    ))
    await asyncio.sleep(0.04)
    event.set()
    await asyncio.wait_for(task, timeout=2)
    jobs = repo.list_agent_runs(agent_id="mixed")
    assert len(jobs) == 1
    assert jobs[0].params["trigger_id"] == "trg_cron"


def test_before_start_not_due_is_not_enqueued(tmp_path, monkeypatch):
    from src.agents.trigger import CalendarBeforeStartTrigger
    from src.calendar_sync.repository import CalendarEventOccurrence, CalendarEventRepository
    from src.config import config

    db = tmp_path / "calendar.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    calendar_repo = CalendarEventRepository(str(db))
    now = datetime(2026, 8, 9, 15, tzinfo=_UTC)
    calendar_repo.upsert_from_caldav_event(
        _calendar_event("future", datetime(2026, 8, 9, 16, 0, 1, tzinfo=_UTC)),
        source="caldav",
    )
    row = calendar_repo.get_by_ical_uid("future")
    assert row is not None
    occurrence = CalendarEventOccurrence(
        row=row,
        occurrence_start_utc=row.dtstart_utc,
        occurrence_end_utc=row.dtend_utc,
        is_recurrence_instance=False,
    )
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)
    monkeypatch.setattr(
        CalendarEventRepository,
        "list_event_occurrences",
        lambda self, *args, **kwargs: [occurrence],
    )

    tw._fire_calendar_before_start(
        sync_store=ss,
        repo=repo,
        agent={"id": "not-due", "budget_json": None},
        trigger=CalendarBeforeStartTrigger(lead_seconds=3600),
        trigger_id="trg_before",
        now=now,
    )
    assert repo.list_agent_runs(agent_id="not-due") == []


def test_before_start_skips_beyond_catch_up_window(tmp_path, monkeypatch):
    from src.agents.trigger import CalendarBeforeStartTrigger
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import config

    db = tmp_path / "calendar.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    calendar_repo = CalendarEventRepository(str(db))
    calendar_repo.upsert_from_caldav_event(
        _calendar_event("late", datetime(2026, 8, 9, 16, tzinfo=_UTC)), source="caldav"
    )
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)

    tw._fire_calendar_before_start(
        sync_store=ss,
        repo=repo,
        agent={"id": "late", "budget_json": None},
        trigger=CalendarBeforeStartTrigger(lead_seconds=3600),
        trigger_id="trg_before",
        now=datetime(2026, 8, 9, 15, 31, tzinfo=_UTC),
    )
    assert repo.list_agent_runs(agent_id="late") == []


def test_before_start_skips_soft_deleted_event(tmp_path, monkeypatch):
    from src.agents.trigger import CalendarBeforeStartTrigger
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import config

    db = tmp_path / "calendar.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    calendar_repo = CalendarEventRepository(str(db))
    calendar_repo.upsert_from_caldav_event(
        _calendar_event("deleted", datetime(2026, 8, 9, 16, tzinfo=_UTC)), source="caldav"
    )
    calendar_repo.soft_delete(ical_uid="deleted", source="caldav")
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)

    tw._fire_calendar_before_start(
        sync_store=ss,
        repo=repo,
        agent={"id": "deleted", "budget_json": None},
        trigger=CalendarBeforeStartTrigger(lead_seconds=3600),
        trigger_id="trg_before",
        now=datetime(2026, 8, 9, 15, 0, 30, tzinfo=_UTC),
    )
    assert repo.list_agent_runs(agent_id="deleted") == []


def test_before_start_time_move_creates_new_fire_key(tmp_path, monkeypatch):
    from src.agents.trigger import CalendarBeforeStartTrigger
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import config

    db = tmp_path / "calendar.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    calendar_repo = CalendarEventRepository(str(db))
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)
    trigger = CalendarBeforeStartTrigger(lead_seconds=3600)
    agent = {"id": "moved", "budget_json": None}

    calendar_repo.upsert_from_caldav_event(
        _calendar_event("moved", datetime(2026, 8, 9, 16, tzinfo=_UTC)), source="caldav"
    )
    tw._fire_calendar_before_start(
        sync_store=ss,
        repo=repo,
        agent=agent,
        trigger=trigger,
        trigger_id="trg_before",
        now=datetime(2026, 8, 9, 15, 0, 30, tzinfo=_UTC),
    )

    calendar_repo.upsert_from_caldav_event(
        _calendar_event("moved", datetime(2026, 8, 9, 18, tzinfo=_UTC)), source="caldav"
    )
    tw._fire_calendar_before_start(
        sync_store=ss,
        repo=repo,
        agent=agent,
        trigger=trigger,
        trigger_id="trg_before",
        now=datetime(2026, 8, 9, 17, 0, 30, tzinfo=_UTC),
    )

    keys = {job.params["fire_key"] for job in repo.list_agent_runs(agent_id="moved")}
    assert keys == {
        "moved||2026-08-09T16:00:00+00:00|3600",
        "moved||2026-08-09T18:00:00+00:00|3600",
    }


def test_before_start_daily_recurrence_preserves_wall_clock_across_dst(tmp_path, monkeypatch):
    from src.agents.trigger import CalendarBeforeStartTrigger
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import config

    db = tmp_path / "calendar.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    calendar_repo = CalendarEventRepository(str(db))
    calendar_repo.upsert_from_caldav_event(
        _calendar_event(
            "dst",
            datetime(2026, 3, 7, 9, tzinfo=ZoneInfo("America/Los_Angeles")),
            rrule="FREQ=DAILY",
            tzid="America/Los_Angeles",
        ),
        source="caldav",
    )
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)
    trigger = CalendarBeforeStartTrigger(lead_seconds=3600)
    agent = {"id": "dst", "budget_json": None}

    for fire_at in (
        datetime(2026, 3, 7, 16, tzinfo=_UTC),
        datetime(2026, 3, 9, 15, tzinfo=_UTC),
    ):
        tw._fire_calendar_before_start(
            sync_store=ss,
            repo=repo,
            agent=agent,
            trigger=trigger,
            trigger_id="trg_before",
            now=fire_at,
        )

    keys = {job.params["fire_key"] for job in repo.list_agent_runs(agent_id="dst")}
    assert "dst||2026-03-07T17:00:00+00:00|3600" in keys
    assert "dst||2026-03-09T16:00:00+00:00|3600" in keys
    assert len(keys) == 2


@pytest.mark.asyncio
async def test_calendar_query_failure_does_not_starve_later_cron_agent(tmp_path, monkeypatch):
    from src.calendar_sync.repository import CalendarEventRepository
    from src.config import config

    monkeypatch.setattr(tw, "trigger_v2_enabled", lambda: True)
    monkeypatch.setattr(tw, "calendar_trigger_enabled", lambda: True)
    monkeypatch.setattr(config, "calendar_caldav_sync_enabled", True)
    monkeypatch.setattr(
        CalendarEventRepository,
        "list_event_occurrences",
        lambda self, *args, **kwargs: (_ for _ in ()).throw(RuntimeError("calendar locked")),
    )
    db = tmp_path / "s.db"
    ss = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    agents = [
        {
            "id": "calendar-broken",
            "type": "custom",
            "enabled": 1,
            "trigger_json": json.dumps(
                {
                    "v": 2,
                    "triggers": [
                        {
                            "id": "trg_cal",
                            "enabled": True,
                            "kind": "calendar_before_start",
                            "lead_seconds": 3600,
                        }
                    ],
                }
            ),
            "budget_json": None,
        },
        {
            "id": "cron-after-calendar",
            "type": "custom",
            "enabled": 1,
            "trigger_json": json.dumps(
                {
                    "v": 2,
                    "triggers": [
                        {
                            "id": "trg_cron",
                            "enabled": True,
                            "kind": "cron",
                            "cron": "0 9 * * *",
                            "timezone": "UTC",
                        }
                    ],
                }
            ),
            "budget_json": None,
        },
    ]
    event = asyncio.Event()
    task = asyncio.create_task(
        tw.tick_loop(
            sync_store=ss,
            store=_FakeStore(agents),
            repo=repo,
            shutdown_event=event,
            interval_sec=0.01,
            now_fn=lambda: datetime(2026, 8, 8, 9, 0, 30, tzinfo=_UTC),
        )
    )
    await asyncio.sleep(0.04)
    event.set()
    await asyncio.wait_for(task, timeout=2)

    assert repo.list_agent_runs(agent_id="calendar-broken") == []
    jobs = repo.list_agent_runs(agent_id="cron-after-calendar")
    assert len(jobs) == 1
    assert jobs[0].params["trigger_id"] == "trg_cron"
