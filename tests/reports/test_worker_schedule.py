"""报告 worker 接入共享排程求值器（schedule-builder 任务，契约 §4/§6）。

覆盖三层：
1. **逐分钟等价 sweep**：老 ``_due_hour``（冻结参考实现，逐字拷贝改前代码）与新
   ``_due_occurrence`` 在老形状行上决策完全一致 —— 生产存量两行（daily 9 点 / weekly
   周一 9 点）升级后触发时刻**逐分钟不变**（AC 锁死项），含 DST 切换日与多 hour 行。
2. **升级形状等价**：同一配置的老形状行 vs ``kind:'schedule'`` 新形状行（时区写实成
   宿主机 IANA）fire 时刻逐分钟相同。
3. **新形状行为**：payload 时区权威、interval 相位、minute 粒度、坏 payload skip、
   ``cadence_of`` 的 freq→cadence 派生。
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import pytest

from src.reports import worker as W
from src.reports.store import agent_with_cadence_override, cadence_of

_UTC = timezone.utc


@pytest.fixture
def tz_la(monkeypatch):
    """把本机系统时区固定成 America/Los_Angeles（镜像 test_worker_timezone 的 fixture）。"""
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


# ============================================================
# 冻结参考实现：改前的 _due_hour（逐字拷贝，锁旧语义 —— 勿随生产代码同步改动）
# ============================================================

def _legacy_fire_hours(sched: Dict[str, Any]) -> List[int]:
    out: List[int] = []
    for h in sched.get("hours") or []:
        try:
            hi = int(h)
        except (TypeError, ValueError):
            continue
        if 0 <= hi <= 23 and hi not in out:
            out.append(hi)
    return out or [9]


def _legacy_due_hour(
    agent: Dict[str, Any], now: datetime, last_marker: Optional[str]
) -> Optional[int]:
    try:
        sched = json.loads(agent.get("schedule_json") or "{}") or {}
    except (json.JSONDecodeError, TypeError):
        sched = {}
    cadence = str(sched.get("cadence") or "daily")
    if cadence == "weekly" and now.weekday() != int(sched.get("weekday", 0) or 0):
        return None
    if cadence == "monthly" and now.day != int(sched.get("day_of_month", 1) or 1):
        return None

    hours = sorted(_legacy_fire_hours(sched))
    today = now.strftime("%Y%m%d")

    for h in hours:
        if now.hour == h and now.minute < W.FIRE_WINDOW_MIN:
            if f"{now.strftime('%Y%m%d')}-{h:02d}" != last_marker:
                return h
            return None  # 当前 window 已 fire
    if not (last_marker or "").startswith(today):
        passed = [h for h in hours if h <= now.hour]
        if passed:
            return max(passed)
    return None


# ============================================================
# sweep 装置：像 tick_loop 一样按 marker 状态机走一遍，逐分钟比对决策
# ============================================================

def _agent(schedule_json: str, agent_id: str = "a", tz: str = "") -> Dict[str, Any]:
    return {"id": agent_id, "type": "report", "enabled": 1,
            "timezone": tz, "schedule_json": schedule_json}


def _walk_new(agent: Dict[str, Any], start: datetime, end: datetime,
              step_min: int) -> List[Tuple[str, str]]:
    """新实现的 stateful 决策序列：[(fire 时刻 UTC iso, marker)]。"""
    marker: Optional[str] = None
    fires: List[Tuple[str, str]] = []
    t = start
    while t <= end:
        local = t.astimezone()  # tick_loop 同款：空 timezone → 宿主机本地
        occ = W._due_occurrence(agent, local, marker)
        if occ is not None:
            marker = W._slot_marker(occ, occ.hour)
            fires.append((t.isoformat(), marker))
        t += timedelta(minutes=step_min)
    return fires


def _walk_both_and_compare(agent: Dict[str, Any], start: datetime, end: datetime,
                           step_min: int = 10) -> List[Tuple[str, str]]:
    """老/新实现各自按状态机走，**每一步**决策必须一致；返回 fire 序列（供非空断言）。"""
    marker_ref: Optional[str] = None
    marker_new: Optional[str] = None
    fires: List[Tuple[str, str]] = []
    t = start
    while t <= end:
        local = t.astimezone()
        h = _legacy_due_hour(agent, local, marker_ref)
        occ = W._due_occurrence(agent, local, marker_new)
        assert (h is None) == (occ is None), (t.isoformat(), h, occ)
        if h is not None:
            ref_marker = f"{local.strftime('%Y%m%d')}-{h:02d}"
            new_marker = W._slot_marker(occ, occ.hour)
            assert occ.hour == h and new_marker == ref_marker, (t.isoformat(), h, occ)
            marker_ref, marker_new = ref_marker, new_marker
            fires.append((t.isoformat(), new_marker))
        t += timedelta(minutes=step_min)
    return fires


class TestLegacyMinuteByMinuteEquivalence:
    # 覆盖 2026-03-08（LA 春季前跳）+ 月界 03-01（monthly 用）。
    START = datetime(2026, 2, 28, 0, 0, tzinfo=_UTC)
    END = datetime(2026, 3, 11, 0, 0, tzinfo=_UTC)

    def test_production_daily_row(self, tz_la):
        """生产存量行 ①：{"cadence":"daily","hours":[9]}，空时区（宿主机本地）。"""
        fires = _walk_both_and_compare(
            _agent('{"cadence":"daily","hours":[9]}'), self.START, self.END)
        assert len(fires) >= 10  # 每天一 fire，sweep 非空（防 vacuous pass）

    def test_production_weekly_row(self, tz_la):
        """生产存量行 ②：{"cadence":"weekly","hours":[9],"weekday":0}（Python 周一）。"""
        fires = _walk_both_and_compare(
            _agent('{"cadence":"weekly","hours":[9],"weekday":0}'), self.START, self.END)
        assert len(fires) == 2  # 03-02 / 03-09 两个周一
        for iso, marker in fires:
            assert datetime.fromisoformat(iso).astimezone().weekday() == 0

    def test_multi_hours_row(self, tz_la):
        fires = _walk_both_and_compare(
            _agent('{"cadence":"daily","hours":[8,18]}'), self.START, self.END)
        assert len(fires) >= 20  # 每天两 fire

    def test_monthly_row(self, tz_la):
        fires = _walk_both_and_compare(
            _agent('{"cadence":"monthly","hours":[9],"day_of_month":1}'),
            self.START, self.END)
        assert len(fires) == 1 and fires[0][1] == "20260301-09"

    def test_agent_timezone_column_row(self, tz_la):
        """列 timezone 显式（tick_loop 会先 _agent_local 成上海时刻再进判定）—— 判定收到
        的 now 就是上海墙钟，新老都以它为准。"""
        agent = _agent('{"cadence":"daily","hours":[9]}', tz="Asia/Shanghai")
        marker_ref = marker_new = None
        fires = 0
        t = self.START
        while t <= self.END:
            local = W._agent_local(agent, t)
            h = _legacy_due_hour(agent, local, marker_ref)
            occ = W._due_occurrence(agent, local, marker_new)
            assert (h is None) == (occ is None), (t.isoformat(), h, occ)
            if h is not None:
                marker_ref = f"{local.strftime('%Y%m%d')}-{h:02d}"
                marker_new = W._slot_marker(occ, occ.hour)
                assert marker_new == marker_ref
                fires += 1
            t += timedelta(minutes=10)
        assert fires >= 10


class TestUpgradedShapeEquivalence:
    """老形状 vs 升级后的 kind:'schedule' 形状（时区写实宿主机 IANA）—— fire 时刻逐分钟相同。"""

    START = datetime(2026, 2, 28, 0, 0, tzinfo=_UTC)
    END = datetime(2026, 3, 11, 0, 0, tzinfo=_UTC)

    @staticmethod
    def _schedule_json(rule_over: Dict[str, Any]) -> str:
        rule = {"freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                "clamp": False}
        rule.update(rule_over)
        return json.dumps({
            "v": 1, "kind": "schedule", "rule": rule,
            # interval=1 → anchor 无相位影响（契约 §4：迁移行随便填合法日期）。
            "anchor": "2026-01-05",
            # 🔴 时区写实：老行空 timezone 语义 = 宿主机本地 → 升级时写成实际 IANA 值。
            "timezone": "America/Los_Angeles",
        })

    def test_daily_9am_unchanged(self, tz_la):
        old = _walk_new(_agent('{"cadence":"daily","hours":[9]}'), self.START, self.END, 10)
        new = _walk_new(_agent(self._schedule_json({})), self.START, self.END, 10)
        assert old == new and len(old) >= 10

    def test_weekly_monday_9am_unchanged(self, tz_la):
        # 🔴 星期编号转换：Python weekday=0（周一）→ 契约 weekdays=[1]。
        old = _walk_new(_agent('{"cadence":"weekly","hours":[9],"weekday":0}'),
                        self.START, self.END, 10)
        new = _walk_new(_agent(self._schedule_json({"freq": "weekly", "weekdays": [1]})),
                        self.START, self.END, 10)
        assert old == new and len(old) == 2


class TestSchedulePayloadBehavior:
    def _agent_sched(self, rule_over: Dict[str, Any], *, tz: str = "Asia/Shanghai",
                     anchor: str = "2026-07-06", **payload_over: Any) -> Dict[str, Any]:
        rule = {"freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                "clamp": False}
        rule.update(rule_over)
        payload: Dict[str, Any] = {"v": 1, "kind": "schedule", "rule": rule,
                                   "anchor": anchor, "timezone": tz}
        payload.update(payload_over)
        return _agent(json.dumps(payload), agent_id="s")

    def _due(self, agent, now_utc: datetime, marker=None):
        # tick_loop 同款入口：先 _agent_local（列 tz 空 → 宿主机），判定内部再按 payload tz。
        return W._due_occurrence(agent, W._agent_local(agent, now_utc), marker)

    def test_payload_timezone_is_authoritative(self, tz_la):
        """列 timezone 空（宿主机 LA）但 payload=Asia/Shanghai → 按上海 9 点 fire。"""
        agent = self._agent_sched({})
        # 上海 09:05 = UTC 01:05（LA 前一天 17:05）→ fire，marker 用上海日。
        occ = self._due(agent, datetime(2026, 7, 20, 1, 5, tzinfo=_UTC))
        assert occ is not None and occ.isoformat() == "2026-07-20T09:00:00+08:00"
        assert W._slot_marker(occ, occ.hour) == "20260720-09"
        # LA 本地 9 点（UTC 16:00）不 fire（已 fire 过当天 slot；catchup 被 marker 挡）。
        assert self._due(agent, datetime(2026, 7, 20, 16, 5, tzinfo=_UTC), "20260720-09") is None

    def test_dedup_and_catchup(self, tz_la):
        agent = self._agent_sched({})
        t = datetime(2026, 7, 20, 1, 5, tzinfo=_UTC)   # 上海 09:05
        assert self._due(agent, t, "20260720-09") is None          # 同 slot 去重
        late = datetime(2026, 7, 20, 7, 0, tzinfo=_UTC)            # 上海 15:00
        occ = self._due(agent, late, "20260719-09")                # 昨天 fire → 今天补
        assert occ is not None and occ.hour == 9
        assert self._due(agent, late, "20260720-09") is None       # 今天已 fire → 不补

    def test_weekly_interval2_phase(self, tz_la):
        agent = self._agent_sched({"freq": "weekly", "interval": 2, "weekdays": [1]})
        on_week = datetime(2026, 7, 20, 1, 5, tzinfo=_UTC)    # anchor+2 周的周一 09:05
        off_week = datetime(2026, 7, 13, 1, 5, tzinfo=_UTC)   # off-week 周一
        occ = self._due(agent, on_week)
        assert occ is not None and occ.isoformat() == "2026-07-20T09:00:00+08:00"
        assert self._due(agent, off_week) is None
        # off-week 也不允许 catchup 误补（prev occurrence 在 7 天前，不是「今天」）。
        assert self._due(agent, datetime(2026, 7, 13, 7, 0, tzinfo=_UTC)) is None

    def test_minute_granularity(self, tz_la):
        agent = self._agent_sched({"minute": 45})
        # 窗口 [09:45, 10:15)：09:50 fire；10:20 过窗 → 当天 catchup；09:30 还没到 → None。
        assert self._due(agent, datetime(2026, 7, 20, 1, 50, tzinfo=_UTC)) is not None
        assert self._due(agent, datetime(2026, 7, 20, 2, 20, tzinfo=_UTC)) is not None
        assert self._due(agent, datetime(2026, 7, 20, 1, 30, tzinfo=_UTC)) is None

    def test_bad_payload_skips_without_fire(self, tz_la):
        # timezone 缺失 / rule 缺键 → skip（warning），绝不回退猜 9 点。
        for over in ({"timezone": ""}, ):
            agent = self._agent_sched({}, **over)
            assert self._due(agent, datetime(2026, 7, 20, 1, 5, tzinfo=_UTC)) is None
        broken = self._agent_sched({})
        payload = json.loads(broken["schedule_json"])
        del payload["rule"]["clamp"]
        broken["schedule_json"] = json.dumps(payload)
        assert self._due(broken, datetime(2026, 7, 20, 1, 5, tzinfo=_UTC)) is None

    def test_additive_shape_with_legacy_mirror_keys(self, tz_la):
        """前端保存的叠加形状：新键（kind/rule/anchor/timezone）与 legacy 镜像键
        （cadence/hours/weekday/day_of_month，供旧版 app 降级读）共存。运行时
        **只认 rule**：镜像键是死数据，就算与 rule 漂移也不影响 fire。"""
        agent = self._agent_sched(
            {"freq": "weekly", "weekdays": [1]},
            # 镜像键刻意与 rule 全面漂移（cadence=daily / hours=[18] / weekday=3）——
            # 若实现偷读任何镜像键即测红。
            cadence="daily", hours=[18], weekday=3,
        )
        occ = self._due(agent, datetime(2026, 7, 20, 1, 5, tzinfo=_UTC))  # 周一 上海 09:05
        assert occ is not None and occ.isoformat() == "2026-07-20T09:00:00+08:00"
        assert self._due(agent, datetime(2026, 7, 22, 10, 5, tzinfo=_UTC)) is None  # 周三 18 点不 fire
        # cadence 派生同样以 rule.freq 为准（镜像 cadence 只喂 wire 层默认 prompt 回退）。
        assert cadence_of(agent) == "weekly"

    def test_monthly_nth_payload(self, tz_la):
        # 每月第 2 个周二 09:00（上海）：2026-07-14。
        agent = self._agent_sched(
            {"freq": "monthly", "monthMode": "nth", "ordinal": 2, "weekday": 2},
            anchor="2026-01-01",
        )
        occ = self._due(agent, datetime(2026, 7, 14, 1, 5, tzinfo=_UTC))
        assert occ is not None and occ.isoformat() == "2026-07-14T09:00:00+08:00"
        assert self._due(agent, datetime(2026, 7, 7, 1, 5, tzinfo=_UTC)) is None  # 第 1 个周二


class TestCadenceOfScheduleShape:
    def _row(self, freq: str) -> Dict[str, Any]:
        return {"schedule_json": json.dumps({
            "v": 1, "kind": "schedule",
            "rule": {"freq": freq, "interval": 1, "weekdays": [1], "monthMode": "date",
                     "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                     "clamp": False},
            "anchor": "2026-07-06", "timezone": "Asia/Shanghai"})}

    def test_freq_derives_cadence(self):
        # 少了这条派生，weekly 的 schedule 形状行会按 daily 排序/聚合（层级聚合口径错）。
        assert cadence_of(self._row("daily")) == "daily"
        assert cadence_of(self._row("weekly")) == "weekly"
        assert cadence_of(self._row("monthly")) == "monthly"

    def test_bad_schedule_shape_falls_back_to_default(self):
        assert cadence_of({"schedule_json": '{"kind":"schedule","rule":null}'}) == "daily"
        assert cadence_of({"schedule_json": '{"kind":"schedule"}'}) == "daily"


class TestCadenceOverrideHelper:
    """manual-run 的 ``--cadence`` 覆盖（CLI ``report run`` / serve-api manual-run /
    skill ``report_run`` 三处共用 ``agent_with_cadence_override``）。

    🔴 回归背景：三处原本各自只改顶层 ``sched["cadence"]``——kind:'schedule' 新形状下
    ``cadence_of`` 以 ``rule.freq`` 为权威，顶层键是死镜像 → 覆盖被静默忽略（manual
    weekly run 实际生成 daily 报告、无任何报错）。helper 必须连 ``rule.freq`` 一起覆写。
    """

    _SCHEDULE_ROW = {
        "schedule_json": json.dumps({
            "v": 1, "kind": "schedule",
            "rule": {"freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                     "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                     "clamp": False},
            "anchor": "2026-07-06", "timezone": "Asia/Shanghai",
            # 降级镜像键也在场（前端保存的叠加形状）
            "cadence": "daily", "hours": [9],
        })
    }

    def test_schedule_shape_override_reaches_cadence_of(self):
        out = agent_with_cadence_override(dict(self._SCHEDULE_ROW), "weekly")
        assert cadence_of(out) == "weekly"   # 只写顶层 cadence 时这里是 "daily" → 测红
        sched = json.loads(out["schedule_json"])
        assert sched["cadence"] == "weekly" and sched["rule"]["freq"] == "weekly"
        # rule 其余字段原样保留（只覆写 freq）。
        assert sched["rule"]["hour"] == 9 and sched["anchor"] == "2026-07-06"

    def test_legacy_shape_top_level_override_unchanged(self):
        agent = {"schedule_json": '{"cadence":"daily","hours":[9]}'}
        out = agent_with_cadence_override(agent, "monthly")
        assert cadence_of(out) == "monthly"
        assert agent["schedule_json"] == '{"cadence":"daily","hours":[9]}'  # 原 dict 不动

    def test_empty_and_bad_schedule_json(self):
        assert cadence_of(agent_with_cadence_override({"schedule_json": None}, "weekly")) \
            == "weekly"
        assert cadence_of(agent_with_cadence_override({"schedule_json": "not-json"}, "weekly")) \
            == "weekly"


class TestTickLoopScheduleIntegration:
    def test_marker_written_from_occurrence(self, tz_la):
        """tick_loop 对 schedule 行：fire 后 marker = occurrence 的本地日+钟点（payload tz）。"""

        class _Sync:
            def __init__(self):
                self.state: Dict[str, str] = {}

            def get_state(self, k):
                return self.state.get(k)

            def set_state(self, k, v):
                self.state[k] = v
                return True

        class _Store:
            def __init__(self, agents):
                self._agents = agents

            def list_agents(self):
                return list(self._agents)

            def reclaim_stale_generating(self):
                return 0

        rule = {"freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                "clamp": False}
        agent = _agent(json.dumps({"v": 1, "kind": "schedule", "rule": rule,
                                   "anchor": "2026-07-01", "timezone": "Asia/Shanghai"}),
                       agent_id="s1")
        sync = _Sync()
        sync.state[W._MARKER_MIGRATION_STATE_KEY] = "1"
        fired: List[str] = []

        async def spy(a, now):
            fired.append(a["id"])

        async def _go():
            ev = asyncio.Event()
            task = asyncio.create_task(W.tick_loop(
                sync_store=sync, store=_Store([agent]), db_path=":memory:",
                shutdown_event=ev, interval_sec=0,
                now_fn=lambda: datetime(2026, 7, 20, 1, 5, tzinfo=_UTC),  # 上海 09:05
                run_once=spy,
            ))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            ev.set()
            await asyncio.wait_for(task, timeout=2)

        asyncio.run(_go())
        assert fired == ["s1"]  # marker 去重 → 只 fire 一次
        assert sync.state[W._fire_state_key("s1")] == "20260720-09"  # 上海日，不是 LA 日
