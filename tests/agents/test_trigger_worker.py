"""AgentTriggerWorker cron 判定 + tick_loop 单测（S4 W1, ADR D5 rev1）。

_due_fire 纯函数（注入 now_utc + marker）：UTC marker / cron_hash 失效 / 单次 catch-up /
错过窗口不补 / DST 双向。tick_loop：只 fire enabled type='custom' cron 行 → 入队 agent_run。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest

from src.agents import trigger_worker as tw
from src.agents.trigger import CronTrigger
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
