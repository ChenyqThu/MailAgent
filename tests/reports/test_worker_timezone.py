"""报告 worker 时区化 + 周报聚合窗口口径（issue #50 批，主题 A）。

覆盖：
- fire 判定跟随本机系统时区（改前恒按硬编码 UTC+8 → LA 下「9 点日报」落在 18 点）；
- agent.timezone 显式填值时覆盖本机；
- weekly 的 weekday 判定在本地口径下正确（改前「周一 9 点」= LA 周日 18 点，周几错一天）；
- report_last_fire:* marker 的北京日 → 本地日一次性迁移（幂等）；
- 周 / 月报选子报告改按内容窗口中点，消除 rolling_24h 日报带来的「整体前移一天」。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from loguru import logger

from src.mail.sync_store import SyncStore
from src.reports import worker as W
from src.reports.store import ReportStore
from src.reports.summarizer import ReportDraft

_UTC = timezone.utc
_SH = timezone(timedelta(hours=8))


@pytest.fixture
def tz_la(monkeypatch):
    """把本机系统时区固定成 America/Los_Angeles（datetime.astimezone() 无参会读它）。"""
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


class _FakeSyncStore:
    def __init__(self, state: Optional[Dict[str, str]] = None):
        self.state: Dict[str, str] = dict(state or {})

    def get_state(self, key: str) -> Optional[str]:
        return self.state.get(key)

    def set_state(self, key: str, value: str) -> bool:
        self.state[key] = value
        return True


class _FakeReportStore:
    def __init__(self, agents: List[Dict[str, Any]]):
        self._agents = agents

    def list_agents(self) -> List[Dict[str, Any]]:
        return list(self._agents)

    def reclaim_stale_generating(self) -> int:
        return 0


def _agent(agent_id: str = "daily_email_digest", **over: Any) -> Dict[str, Any]:
    row = {
        "id": agent_id,
        "type": "report",
        "enabled": 1,
        "timezone": "",
        "schedule_json": '{"cadence":"daily","hours":[9]}',
    }
    row.update(over)
    return row


def _run_tick(sync_store: _FakeSyncStore, agents: List[Dict[str, Any]], now: datetime) -> List[str]:
    """跑几轮 tick_loop（now 固定），返回真正 fire 的 slot marker 列表。"""
    fired: List[str] = []

    async def spy(agent, tick_now):
        fired.append(agent["id"])

    async def _go():
        shutdown = asyncio.Event()
        task = asyncio.create_task(W.tick_loop(
            sync_store=sync_store, store=_FakeReportStore(agents), db_path=":memory:",
            shutdown_event=shutdown, interval_sec=0, now_fn=lambda: now, run_once=spy,
        ))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        shutdown.set()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(_go())
    # marker 由 tick_loop 在 run_once 之后落库（spy 里还读不到）→ 跑完再取
    return [sync_store.get_state(W._fire_state_key(aid)) or "" for aid in fired]


# ============================================================
# R1: fire 判定跟随时区
# ============================================================

class TestFireFollowsLocalTimezone:
    # 迁移已跑过（tick_loop 启动会调 _migrate_fire_markers）—— 这些用例只测 fire 判定。
    MIGRATED = {W._MARKER_MIGRATION_STATE_KEY: "1"}

    def test_fires_at_local_9am_not_beijing_9am(self, tz_la):
        """LA：本地 09:05 触发；北京 09:05（= LA 前一天 18:05）不触发。"""
        agents = [_agent()]
        # UTC 2026-07-21 01:05 = 北京 09:05 = LA 07-20 18:05（改前就是在这个点跑的）
        beijing_9am = datetime(2026, 7, 21, 1, 5, tzinfo=_UTC)
        store = _FakeSyncStore({**self.MIGRATED,
                                W._fire_state_key("daily_email_digest"): "20260720-09"})
        assert _run_tick(store, agents, beijing_9am) == []

        # UTC 2026-07-21 16:05 = LA 07-21 09:05 → 该 fire，marker 用本地日
        la_9am = datetime(2026, 7, 21, 16, 5, tzinfo=_UTC)
        assert _run_tick(store, agents, la_9am) == ["20260721-09"]

    def test_fires_at_local_9am_in_shanghai(self, monkeypatch):
        """同一配置换到 Asia/Shanghai：北京 09:05 触发（跟随语义成立）。"""
        monkeypatch.setenv("TZ", "Asia/Shanghai")
        time.tzset()
        try:
            store = _FakeSyncStore({**self.MIGRATED,
                                    W._fire_state_key("daily_email_digest"): "20260720-09"})
            now = datetime(2026, 7, 21, 1, 5, tzinfo=_UTC)  # 上海 09:05
            assert _run_tick(store, [_agent()], now) == ["20260721-09"]
        finally:
            monkeypatch.undo()
            time.tzset()

    def test_agent_timezone_overrides_local(self, tz_la):
        """agent.timezone 显式填 IANA → 以它为准（本机 LA 被覆盖）。"""
        agents = [_agent(timezone="Asia/Shanghai")]
        store = _FakeSyncStore({**self.MIGRATED,
                                W._fire_state_key("daily_email_digest"): "20260720-09"})
        now = datetime(2026, 7, 21, 1, 5, tzinfo=_UTC)  # 上海 09:05 / LA 07-20 18:05
        assert _run_tick(store, agents, now) == ["20260721-09"]

    def test_weekly_weekday_uses_local_day(self, tz_la):
        """weekly weekday=0（周一）：LA 周一 09:05 触发；LA 周日 18:05（北京周一 09:05）不触发。"""
        wk = _agent("weekly_email_digest",
                    schedule_json='{"cadence":"weekly","hours":[9],"weekday":0}')
        key = W._fire_state_key("weekly_email_digest")
        # UTC 2026-07-20 01:05 = 北京 周一 09:05 = LA 周日 07-19 18:05 → 不该 fire
        store = _FakeSyncStore({**self.MIGRATED, key: "20260719-09"})
        assert _run_tick(store, [wk], datetime(2026, 7, 20, 1, 5, tzinfo=_UTC)) == []
        # UTC 2026-07-20 16:05 = LA 周一 07-20 09:05 → fire
        assert _run_tick(store, [wk], datetime(2026, 7, 20, 16, 5, tzinfo=_UTC)) \
            == ["20260720-09"]


# ============================================================
# R2: marker 迁移
# ============================================================

class TestMarkerMigration:
    def test_rewrites_beijing_day_to_local_day_once(self, tz_la):
        key = W._fire_state_key("daily_email_digest")
        sync = _FakeSyncStore({key: "20260721-09"})   # owner 活库现值
        store = _FakeReportStore([_agent()])

        W._migrate_fire_markers(sync, store)
        # 北京 2026-07-21 09:00 = LA 2026-07-20 18:00 → 本地日 07-20
        assert sync.state[key] == "20260720-09"
        assert sync.state[W._MARKER_MIGRATION_STATE_KEY] == "1"

        # 幂等：再跑（含多次）不再改写，否则会每次往前漂一天
        W._migrate_fire_markers(sync, store)
        W._migrate_fire_markers(sync, store)
        assert sync.state[key] == "20260720-09"

    def test_noop_when_same_day_or_missing(self, monkeypatch):
        monkeypatch.setenv("TZ", "Asia/Shanghai")
        time.tzset()
        try:
            key = W._fire_state_key("daily_email_digest")
            sync = _FakeSyncStore({key: "20260721-09"})
            W._migrate_fire_markers(sync, _FakeReportStore([_agent()]))
            assert sync.state[key] == "20260721-09"   # 上海 = 旧口径，原样不动
        finally:
            monkeypatch.undo()
            time.tzset()

        sync2 = _FakeSyncStore({W._fire_state_key("daily_email_digest"): ""})
        W._migrate_fire_markers(sync2, _FakeReportStore([_agent()]))
        assert sync2.state[W._fire_state_key("daily_email_digest")] == ""  # 空值不碰

    def test_aborts_when_flag_write_fails(self, tz_la):
        """🔴 真 SyncStore.set_state 吞 sqlite3.Error 返回 **False**（不抛异常）——
        标记位没落库还照改 marker 的话，下次启动会再换算一次、每次重启往前漂一天。"""
        class _FlagWriteFails(_FakeSyncStore):
            def set_state(self, key: str, value: str) -> bool:
                if key == W._MARKER_MIGRATION_STATE_KEY:
                    return False
                return super().set_state(key, value)

        key = W._fire_state_key("daily_email_digest")
        sync = _FlagWriteFails({key: "20260721-09"})
        W._migrate_fire_markers(sync, _FakeReportStore([_agent()]))
        assert sync.state[key] == "20260721-09"                   # 一个 marker 都没动
        assert W._MARKER_MIGRATION_STATE_KEY not in sync.state    # 下次启动会重试

    def test_marker_write_failure_keeps_old_value(self, tz_la):
        """单个 marker 写失败（同样是返回 False）→ 保持旧值，不假装迁移成功。"""
        class _MarkerWriteFails(_FakeSyncStore):
            def set_state(self, key: str, value: str) -> bool:
                if key.startswith("report_last_fire:"):
                    return False
                return super().set_state(key, value)

        key = W._fire_state_key("daily_email_digest")
        sync = _MarkerWriteFails({key: "20260721-09"})
        W._migrate_fire_markers(sync, _FakeReportStore([_agent()]))
        assert sync.state[key] == "20260721-09"
        assert sync.state[W._MARKER_MIGRATION_STATE_KEY] == "1"   # 标记位已落，不重试

    def test_migration_prevents_extra_run_on_upgrade_day(self, tz_la):
        """升级当天不该多跑：迁移后 LA 19:05（当天 09:00 早已跑过）不再 catchup。"""
        key = W._fire_state_key("daily_email_digest")
        sync = _FakeSyncStore({key: "20260721-09"})   # 实际 fire 于 LA 07-20 18:00
        agents = [_agent()]
        # 不迁移的话：本地今天=07-20，marker 以 "20260721" 开头 → catchup 误判 → 多跑
        assert W._due_hour(agents[0],
                           datetime(2026, 7, 21, 2, 5, tzinfo=_UTC).astimezone(),
                           sync.state[key]) == 9
        W._migrate_fire_markers(sync, _FakeReportStore(agents))
        assert _run_tick(sync, agents, datetime(2026, 7, 21, 2, 5, tzinfo=_UTC)) == []


# ============================================================
# R4: 周 / 月报选子报告按内容窗口中点
# ============================================================

@pytest.fixture
def db(tmp_path: Path) -> Path:
    p = tmp_path / "t.db"
    SyncStore(str(p))
    return p


def _seed_dailies(store: ReportStore, days: List[str], *, fire_hour: int = 9) -> None:
    """按 rolling_24h 语义种日报：report_date=生成当天，窗口 [当天-24h, 当天)（+08:00）。"""
    for d in days:
        end = datetime.fromisoformat(f"{d}T{fire_hour:02d}:00:00").replace(tzinfo=_SH)
        rid = f"daily_email_digest:daily:{d}"
        store.create_report(
            report_id=rid, agent_id="daily_email_digest", cadence="daily",
            report_date=d, window_start=(end - timedelta(hours=24)).isoformat(),
            window_end=end.isoformat(),
        )
        store.finish_report(rid, status="ready", blocks_json="[]",
                            counts_json=json.dumps({"total": 1}), headline=d)


def _dates(days_from: str, days_to: str) -> List[str]:
    d0 = datetime.fromisoformat(days_from).date()
    d1 = datetime.fromisoformat(days_to).date()
    out: List[str] = []
    while d0 <= d1:
        out.append(d0.isoformat())
        d0 += timedelta(days=1)
    return out


class TestAggregateSelection:
    def _spy(self, seen: Dict[str, Any]):
        async def agg(**kw):
            seen["dates"] = [s["report_date"] for s in kw["sub_reports"]]
            seen["missing_note"] = kw.get("missing_note", "")
            return ReportDraft(headline="H", overview="ov", model="mk")
        return agg

    def test_weekly_picks_last_7x24h_not_shifted_by_one_day(self, db: Path):
        """周一 09:05 跑周报 → 取的 7 份日报覆盖「往前 7×24h」，不再整体前移一天。"""
        store = ReportStore(str(db))
        _seed_dailies(store, _dates("2026-06-15", "2026-06-22"))
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: Dict[str, Any] = {}
        now = datetime(2026, 6, 22, 9, 5, tzinfo=_SH)   # 周一

        rid = asyncio.run(W.run_report_once(
            store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
            now=now, aggregate_fn=self._spy(seen),
        ))
        # 06-16 那份的窗口是 [06-15 09:00, 06-16 09:00) …… 06-22 那份是 [06-21 09:00, 06-22 09:00)
        # → 合起来 = 06-15 09:00 → 06-22 09:00 = 跑的时刻往前 7×24h
        assert seen["dates"] == _dates("2026-06-16", "2026-06-22")
        assert "2026-06-15" not in seen["dates"]   # 旧口径会取它（内容主体在 06-14）
        assert seen["missing_note"] == ""          # 7 份齐 → 不标缺失
        assert json.loads(store.get_report(rid)["counts_json"])["total"] == 7  # 不重复计数

    def test_weekly_falls_back_to_report_date_when_window_unparseable(self, db: Path):
        """历史行 window_start 不是 ISO（早期占位）→ 退回 report_date 判据，不丢子报告。"""
        store = ReportStore(str(db))
        for d in ["2026-06-16", "2026-06-17"]:
            rid = f"daily_email_digest:daily:{d}"
            store.create_report(report_id=rid, agent_id="daily_email_digest",
                                cadence="daily", report_date=d,
                                window_start="s", window_end="e")
            store.finish_report(rid, status="ready", blocks_json="[]",
                                counts_json='{"total":1}', headline=d)
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: Dict[str, Any] = {}
        asyncio.run(W.run_report_once(
            store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
            now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=self._spy(seen),
        ))
        assert seen["dates"] == ["2026-06-16", "2026-06-17"]

    def test_monthly_covers_whole_previous_month(self, db: Path):
        """月报回归：上一自然月的 31 份日报（05-02…06-01 的窗口即 5 月整月），无缺失标注。"""
        store = ReportStore(str(db))
        _seed_dailies(store, _dates("2026-05-01", "2026-06-01"))
        store.create_agent("monthly_email_digest", type="report", title="月报", enabled=False)
        store.update_agent("monthly_email_digest", {
            "schedule_json": '{"cadence": "monthly", "hours": [9], "day_of_month": 1}',
            "timezone": "Asia/Shanghai",
        })
        seen: Dict[str, Any] = {}
        rid = asyncio.run(W.run_report_once(
            store=store, db_path=str(db), agent=store.get_agent("monthly_email_digest"),
            now=datetime(2026, 6, 1, 9, 5, tzinfo=_SH), aggregate_fn=self._spy(seen),
        ))
        assert seen["dates"] == _dates("2026-05-02", "2026-06-01")   # 31 份
        assert seen["missing_note"] == ""
        assert json.loads(store.get_report(rid)["counts_json"])["total"] == 31

    def test_natural_day_dailies_also_land_in_the_right_week(self, db: Path):
        """natural_day 日报（窗口 = 整个自然日、report_date = 昨天）同样按中点归属，取 7 份。"""
        store = ReportStore(str(db))
        for d in _dates("2026-06-14", "2026-06-21"):
            day0 = datetime.fromisoformat(f"{d}T00:00:00").replace(tzinfo=_SH)
            rid = f"daily_email_digest:daily:{d}"
            store.create_report(report_id=rid, agent_id="daily_email_digest", cadence="daily",
                                report_date=d, window_start=day0.isoformat(),
                                window_end=(day0 + timedelta(days=1)).isoformat())
            store.finish_report(rid, status="ready", blocks_json="[]",
                                counts_json='{"total":1}', headline=d)
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: Dict[str, Any] = {}
        asyncio.run(W.run_report_once(
            store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
            now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=self._spy(seen),
        ))
        assert seen["dates"] == _dates("2026-06-15", "2026-06-21")   # 上周一~周日整 7 天


# ============================================================
# codex review ②：周报对「当天那份日报」的依赖必须被显式表达
# ============================================================

class TestAggregateOrderingAndWarnings:
    def test_list_agents_puts_daily_before_weekly_regardless_of_id(self, db: Path):
        """改前「daily 先跑」只靠 id 字母序巧合（daily_* < weekly_*）—— 换个 id 就静默失效。

        tick_loop 在同一 tick 里按 list_agents 顺序串行 await，周 / 月报要读当天已生成的
        日报，所以顺序必须是显式的 cadence 序。
        """
        store = ReportStore(str(db))
        # 故意让 id 字母序与 cadence 序相反
        for aid, cadence in [("a_weekly", "weekly"), ("m_monthly", "monthly"), ("z_daily", "daily")]:
            store.create_agent(aid, type="report", title=aid, enabled=False)
            store.update_agent(aid, {"schedule_json": json.dumps({"cadence": cadence, "hours": [9]})})
        order = [a["id"] for a in store.list_agents() if a["id"] in {"a_weekly", "m_monthly", "z_daily"}]
        assert order == ["z_daily", "a_weekly", "m_monthly"]

    @pytest.mark.parametrize(
        "schedule",
        [None, "", "{}", "{bad json", '{"hours": [9]}'],
        ids=["null", "empty", "no_cadence_key", "unparseable", "hours_only"],
    )
    def test_report_agent_without_cadence_sorts_as_daily(self, db: Path, schedule):
        """schedule_json 解析不出 cadence（CLI 新建 report agent 的默认形态）→ worker 按
        **daily** 执行（`_due_hour` / `run_report_once` 的默认），所以排序也必须按 daily。

        改前排序给它 rank 3（排到 weekly / monthly **之后**）→ 上一条「daily 必先于 weekly
        跑」的保证对这类 agent 直接失效，周报又会少综合一份且不会重算。
        """
        store = ReportStore(str(db))
        # id 字母序刻意让「无 cadence」的排在 weekly 之后
        store.create_agent("n_nocadence", type="report", title="n", enabled=False)
        if schedule is not None:
            store.update_agent("n_nocadence", {"schedule_json": schedule})
        store.create_agent("a_weekly", type="report", title="w", enabled=False)
        store.update_agent(
            "a_weekly", {"schedule_json": json.dumps({"cadence": "weekly", "hours": [9]})}
        )
        order = [a["id"] for a in store.list_agents() if a["id"] in {"n_nocadence", "a_weekly"}]
        assert order == ["n_nocadence", "a_weekly"]

    def test_non_report_agents_do_not_jump_ahead_of_dailies(self, db: Path):
        """非报告型 agent（custom / search / …）的 schedule_json 同样是空的，但它们**不参与
        报告调度**（worker 里 type != 'report' 直接 continue）→ 不能因为「默认 daily」被排到
        真 daily 前面造成无谓扰动。"""
        store = ReportStore(str(db))
        store.create_agent("a_custom", type="custom", title="c", enabled=False)
        store.create_agent("b_search", type="search", title="s", enabled=False)
        store.create_agent("z_daily", type="report", title="d", enabled=False)
        store.update_agent(
            "z_daily", {"schedule_json": json.dumps({"cadence": "daily", "hours": [9]})}
        )
        order = [
            a["id"] for a in store.list_agents()
            if a["id"] in {"a_custom", "b_search", "z_daily"}
        ]
        assert order == ["z_daily", "a_custom", "b_search"]

    def test_incomplete_period_is_not_published_silently(self, db: Path):
        """周期里缺子报告 → 用户/运营者必须被告知：正文带缺失说明 + 缺席 warning。

        codex 复现：周报 08:00 + 日报 09:00 时，周报每次都稳定少 1 份且不会重算 —— 这是
        钟点配置问题，运营者得能从日志分辨。

        断言的是**诚实标注**，不是「status=ready 且只综合 6 份」这种实现形状：owner 拍板
        保持「照发 + 标注」的现状语义，但将来若有人改成「缺份不发布」，本用例不该成为阻碍；
        而「悄悄发一份不完整报告且不告诉用户」必须仍然测红。
        """
        store = ReportStore(str(db))
        _seed_dailies(store, _dates("2026-06-16", "2026-06-21"))   # 缺 06-22 那份（当天的）
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: Dict[str, Any] = {}
        records: List[Any] = []
        sink = logger.add(lambda m: records.append(m.record), level="WARNING")
        try:
            asyncio.run(W.run_report_once(
                store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
                now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=self._spy_dates(seen),
            ))
        finally:
            logger.remove(sink)

        msgs = [r["message"] for r in records]
        assert any("2026-06-21" in m and "缺席" in m for m in msgs), msgs
        # 走到了综合（= 这份报告会发出去）→ 递给摘要层的缺失说明必须点名缺了几份
        # （summarizer 的 prompt 要求「请在 overview 里如实提及覆盖不完整」，见
        # _build_user_aggregate）。没走到（未来若改成「缺份不发布」）则无此要求。
        note = seen.get("missing_note")
        assert note is None or ("缺失" in note and "1 份" in note), seen

    def test_incomplete_period_note_reaches_the_report_body(self, db: Path):
        """LLM 不可用降级时缺失说明**逐字**进正文 —— 用户可见的诚实标注，不只是日志。"""
        store = ReportStore(str(db))
        _seed_dailies(store, _dates("2026-06-16", "2026-06-21"))   # 缺当天那份
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})

        async def boom(**kw):
            raise RuntimeError("LLM down")

        rid = asyncio.run(W.run_report_once(
            store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
            now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=boom,
        ))
        # 有正文 = 报告发出去了 → 正文必须自己说清覆盖不完整；未来若改成「缺份不发布」
        # （无正文）则本断言自动放行，但「有正文却不提缺失」恒红。
        body = (store.get_report(rid)["blocks_json"] or "").strip()
        assert not body or "1 份日报缺失" in body, body

    def test_no_warning_when_the_period_is_complete(self, db: Path):
        store = ReportStore(str(db))
        _seed_dailies(store, _dates("2026-06-16", "2026-06-22"))
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        records: List[Any] = []
        sink = logger.add(lambda m: records.append(m.record), level="WARNING")
        try:
            asyncio.run(W.run_report_once(
                store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
                now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=self._spy_dates({}),
            ))
        finally:
            logger.remove(sink)
        assert not [r["message"] for r in records if "缺席" in r["message"]]

    def _spy_dates(self, seen: Dict[str, Any]):
        async def agg(**kw):
            seen["dates"] = [s["report_date"] for s in kw["sub_reports"]]
            seen["missing_note"] = kw.get("missing_note", "")
            return ReportDraft(headline="H", overview="ov", model="mk")
        return agg


# ============================================================
# codex review ③：窗口判据与 report_date 判据必须互斥（不是并集）
# ============================================================

class TestSelectionCriteriaAreMutuallyExclusive:
    def _spy(self, seen: Dict[str, Any]):
        async def agg(**kw):
            seen["dates"] = [s["report_date"] for s in kw["sub_reports"]]
            seen["missing_note"] = kw.get("missing_note", "")
            return ReportDraft(headline="H", overview="ov", model="mk")
        return agg

    def test_legacy_row_does_not_inflate_a_full_week(self, db: Path):
        """codex 复现：7 份正常 + 1 份「窗口不可解析但 report_date 落在期内」的历史行。

        并集判据会选出 8 份 → _sum_counts 多算一天，而 missing 被 max(0, …) 压成 0 →
        静默输出错误总数。互斥后只取 7 份可解析行，被排除的行进日志。
        """
        store = ReportStore(str(db))
        _seed_dailies(store, _dates("2026-06-16", "2026-06-22"))
        rid_legacy = "daily_email_digest:daily:2026-06-15"
        store.create_report(report_id=rid_legacy, agent_id="daily_email_digest", cadence="daily",
                            report_date="2026-06-15", window_start="s", window_end="e")
        store.finish_report(rid_legacy, status="ready", blocks_json="[]",
                            counts_json='{"total":1}', headline="legacy")
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: Dict[str, Any] = {}
        records: List[Any] = []
        sink = logger.add(lambda m: records.append(m.record), level="WARNING")
        try:
            rid = asyncio.run(W.run_report_once(
                store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
                now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=self._spy(seen),
            ))
        finally:
            logger.remove(sink)
        assert seen["dates"] == _dates("2026-06-16", "2026-06-22")       # 7 份，不是 8
        assert json.loads(store.get_report(rid)["counts_json"])["total"] == 7
        assert seen["missing_note"] == ""
        assert any("排除 1 份" in r["message"] for r in records), [r["message"] for r in records]

    def test_pure_legacy_period_still_falls_back(self, db: Path):
        """本周期一份可解析窗口的行都没有（纯历史库）→ report_date 判据仍然兜底。"""
        store = ReportStore(str(db))
        for d in ["2026-06-16", "2026-06-17"]:
            rid = f"daily_email_digest:daily:{d}"
            store.create_report(report_id=rid, agent_id="daily_email_digest", cadence="daily",
                                report_date=d, window_start="s", window_end="e")
            store.finish_report(rid, status="ready", blocks_json="[]",
                                counts_json='{"total":1}', headline=d)
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: Dict[str, Any] = {}
        asyncio.run(W.run_report_once(
            store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
            now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH), aggregate_fn=self._spy(seen),
        ))
        assert seen["dates"] == ["2026-06-16", "2026-06-17"]

    def test_overcount_is_flagged_not_silently_clamped(self, db: Path):
        """len(subs) > expected 是异常信号（改前被 max(0, …) 吞掉）→ 必须可诊断。

        断言的是「异常被如实点名（实收 8 / 期望 7）」，不是当前「照发 + 只打日志」的形状：
        将来若改成拒发或在正文里标注，本用例照样绿；但把异常压回 0 静默发出去恒红。
        """
        records: List[Any] = []
        sink = logger.add(lambda m: records.append(m.record), level="WARNING")
        try:
            store = ReportStore(str(db))
            # weekly 期望 7 份；塞 8 份中点都落在期内的日报（每 12h 一份的假想配置）
            base = datetime(2026, 6, 15, 9, 0, tzinfo=_SH)
            for i in range(8):
                end = base + timedelta(hours=12 * i)
                rid = f"daily_email_digest:daily:x{i}"
                store.create_report(report_id=rid, agent_id="daily_email_digest", cadence="daily",
                                    report_date=end.strftime("%Y-%m-%d"),
                                    window_start=(end - timedelta(hours=12)).isoformat(),
                                    window_end=end.isoformat())
                store.finish_report(rid, status="ready", blocks_json="[]",
                                    counts_json='{"total":1}', headline=str(i))
            store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
            asyncio.run(W.run_report_once(
                store=store, db_path=str(db), agent=store.get_agent("weekly_email_digest"),
                now=datetime(2026, 6, 22, 9, 5, tzinfo=_SH),
                aggregate_fn=self._spy({}),
            ))
        finally:
            logger.remove(sink)
        msgs = [r["message"] for r in records]
        # 点名实收与期望两个数字 —— 只说「有异常」而不说数字，运营者无从判断偏高多少。
        assert any("超出本周期期望" in m and "8 份" in m and "7 份" in m for m in msgs), msgs


def test_env_tz_fixture_actually_applies(tz_la):
    """守卫：TZ fixture 真的改到了 astimezone() 的本机口径（否则上面用例是假绿）。"""
    assert datetime(2026, 7, 21, 1, 0, tzinfo=_UTC).astimezone().hour == 18
    assert os.environ["TZ"] == "America/Los_Angeles"
