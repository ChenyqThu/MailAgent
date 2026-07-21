"""单测: daily_digest — fire-window 命中 / 补推 / 不重复推 + run_digest_once 编排.

策略:
- 时间用注入 now (datetime, 北京时区无关 — _current_fire_slot 只看 now.hour/minute)
- sync_store 用轻量 stub (get_state/set_state 内存 dict)
- fetch/summarize/dispatch 全 mock (不烧 token / 不连 socket / 不查 SQLite)
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, List

import pytest

from src.llm_agent.digest_summarizer import DigestBulkAction as SummaryAction
from src.llm_agent.digest_summarizer import DigestSummary
from src.notify import daily_digest, digest_query
from src.notify.island_dispatch import DigestBulkAction

_BJ = timezone(timedelta(hours=8))


class _FakeStore:
    def __init__(self, state: Dict[str, str] = None):
        self._state = dict(state or {})

    def get_state(self, key: str):
        return self._state.get(key)

    def set_state(self, key: str, value: str):
        self._state[key] = value
        return True


# ─────────────────────────────────────────────────────────────────────────────
# _parse_fire_hours
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_fire_hours_basic():
    assert daily_digest._parse_fire_hours("9,18") == [9, 18]


def test_parse_fire_hours_skips_invalid_and_dedups():
    assert daily_digest._parse_fire_hours("9, foo, 18, 99, 9, -1") == [9, 18]


def test_parse_fire_hours_empty():
    assert daily_digest._parse_fire_hours("") == []


# ─────────────────────────────────────────────────────────────────────────────
# _current_fire_slot
# ─────────────────────────────────────────────────────────────────────────────


def test_current_fire_slot_hit_at_hour_start():
    now = datetime(2026, 5, 26, 9, 0, tzinfo=_BJ)
    assert daily_digest._current_fire_slot(now, [9, 18]) == "20260526-09"


def test_current_fire_slot_hit_within_window():
    now = datetime(2026, 5, 26, 18, 29, tzinfo=_BJ)
    assert daily_digest._current_fire_slot(now, [9, 18]) == "20260526-18"


def test_current_fire_slot_miss_after_window():
    now = datetime(2026, 5, 26, 9, 30, tzinfo=_BJ)  # 刚出 window
    assert daily_digest._current_fire_slot(now, [9, 18]) is None


def test_current_fire_slot_miss_wrong_hour():
    now = datetime(2026, 5, 26, 11, 0, tzinfo=_BJ)
    assert daily_digest._current_fire_slot(now, [9, 18]) is None


# ─────────────────────────────────────────────────────────────────────────────
# _already_fired
# ─────────────────────────────────────────────────────────────────────────────


def test_already_fired_true_when_state_matches():
    store = _FakeStore({"last_daily_digest_fire": "20260526-09"})
    assert daily_digest._already_fired(store, "20260526-09") is True


def test_already_fired_false_when_state_differs():
    store = _FakeStore({"last_daily_digest_fire": "20260526-09"})
    assert daily_digest._already_fired(store, "20260526-18") is False


def test_already_fired_false_when_unset():
    assert daily_digest._already_fired(_FakeStore(), "20260526-09") is False


# ─────────────────────────────────────────────────────────────────────────────
# _missed_catchup_slot — 开机补推当天最近一个未推过的 slot
# ─────────────────────────────────────────────────────────────────────────────


def test_missed_catchup_returns_latest_passed_slot():
    # 10:00 开机, 当天 9:00 已过且未推 → 补 09 (不补未来的 18)
    now = datetime(2026, 5, 26, 10, 0, tzinfo=_BJ)
    assert daily_digest._missed_catchup_slot(now, _FakeStore(), [9, 18]) == "20260526-09"


def test_missed_catchup_returns_latest_of_two_passed():
    # 19:00 开机, 9:00 + 18:00 都过了 → 只补最近一个 (18)
    now = datetime(2026, 5, 26, 19, 0, tzinfo=_BJ)
    assert daily_digest._missed_catchup_slot(now, _FakeStore(), [9, 18]) == "20260526-18"


def test_missed_catchup_skips_already_fired():
    # 19:00, 18 已推过 → 退而补 09 (当天更早的未推过的)
    now = datetime(2026, 5, 26, 19, 0, tzinfo=_BJ)
    store = _FakeStore({"last_daily_digest_fire": "20260526-18"})
    assert daily_digest._missed_catchup_slot(now, store, [9, 18]) == "20260526-09"


def test_missed_catchup_none_before_first_hour():
    # 7:00 开机, 当天还没到任何 fire 钟点 → 无补推
    now = datetime(2026, 5, 26, 7, 0, tzinfo=_BJ)
    assert daily_digest._missed_catchup_slot(now, _FakeStore(), [9, 18]) is None


def test_missed_catchup_within_window_still_catches():
    # 9:45 开机 (已过 9:30 window 但在 9 点钟点之后) → 仍补 09
    now = datetime(2026, 5, 26, 9, 45, tzinfo=_BJ)
    assert daily_digest._missed_catchup_slot(now, _FakeStore(), [9, 18]) == "20260526-09"


# ─────────────────────────────────────────────────────────────────────────────
# _should_suppress (决策点 1 钩子默认 False)
# ─────────────────────────────────────────────────────────────────────────────


def test_should_suppress_default_false():
    assert daily_digest._should_suppress() is False


# ─────────────────────────────────────────────────────────────────────────────
# run_digest_once 编排
# ─────────────────────────────────────────────────────────────────────────────


def _brief(iid, **kw):
    return digest_query.DigestEmailBrief(
        internal_id=iid,
        subject=kw.get("subject", f"主题{iid}"),
        sender_name=kw.get("sender_name", "Alice"),
        category=kw.get("category", ""),
        priority=kw.get("priority", "🔴 紧急"),
        action_type=kw.get("action_type", "需要回复"),
        ai_summary=kw.get("ai_summary", ""),
        is_read=kw.get("is_read", False),
        notion_page_id=kw.get("notion_page_id", "page-x"),
    )


@pytest.fixture
def patch_pipeline(monkeypatch):
    """mock fetch/counts/candidates 的产物, 抓 dispatch 调用入参。"""
    state = {
        "briefs": [],
        "counts": {"unread": 0, "urgent": 0, "total": 0, "by_category": {}},
        "candidates": [],
        "dispatched": [],
        "summarize_calls": [],
    }

    monkeypatch.setattr(
        digest_query, "fetch_recent_emails",
        lambda *a, **k: state["briefs"],
    )
    monkeypatch.setattr(
        digest_query, "compute_counts",
        lambda briefs: state["counts"],
    )
    monkeypatch.setattr(
        digest_query, "select_bulk_candidates",
        lambda briefs, **k: state["candidates"],
    )
    # daily_digest 模块 import 时把这俩绑成本地名 → 也 patch 模块上的绑定
    monkeypatch.setattr(daily_digest.digest_query, "fetch_recent_emails",
                        lambda *a, **k: state["briefs"])
    monkeypatch.setattr(daily_digest.digest_query, "compute_counts",
                        lambda briefs: state["counts"])
    monkeypatch.setattr(daily_digest.digest_query, "select_bulk_candidates",
                        lambda briefs, **k: state["candidates"])
    return state


def _dispatch_capture(state):
    def _fn(**kwargs):
        state["dispatched"].append(kwargs)
    return _fn


def test_run_once_orchestrates_and_dispatches(patch_pipeline):
    state = patch_pipeline
    state["counts"] = {"unread": 5, "urgent": 2, "total": 5, "by_category": {}}
    state["candidates"] = [
        digest_query.BulkCandidate(
            action_id="bulk_archive_newsletter",
            internal_ids=[101, 102, 103],
            sample_subjects=["S1"],
        ),
    ]

    async def fake_summarize(**kwargs):
        state["summarize_calls"].append(kwargs)
        return DigestSummary(
            headline="HL",
            summary_md="SM",
            confirmed_actions=[
                SummaryAction(id="bulk_archive_newsletter", title="归档 3 封", detail="d"),
            ],
        )

    store = _FakeStore()
    fired = asyncio.run(daily_digest.run_digest_once(
        sync_store=store, repo=object(), slot="20260526-09",
        dispatch_fn=_dispatch_capture(state), summarize_fn=fake_summarize,
        now=datetime(2026, 5, 26, 9, 0, tzinfo=_BJ),
    ))
    assert fired is True
    assert len(state["dispatched"]) == 1
    d = state["dispatched"][0]
    assert d["digest_date"] == "20260526"
    assert d["unread"] == 5
    assert d["urgent"] == 2
    assert d["headline"] == "HL"
    # action 跟代码候选 ids 配对 (LLM 只挑 id+文案)
    actions: List[DigestBulkAction] = d["confirmed_actions"]
    assert len(actions) == 1
    assert actions[0].id == "bulk_archive_newsletter"
    assert actions[0].internal_ids == [101, 102, 103]
    assert actions[0].title == "归档 3 封"
    # set_state 记 slot
    assert store.get_state("last_daily_digest_fire") == "20260526-09"
    # summarize 收到 dict 形态的 brief/candidates
    sc = state["summarize_calls"][0]
    assert isinstance(sc["emails_brief"], list)
    assert sc["bulk_candidates"][0]["id"] == "bulk_archive_newsletter"
    assert sc["bulk_candidates"][0]["count"] == 3


def test_run_once_skips_when_unread_and_urgent_zero(patch_pipeline):
    """决策点 7: unread+urgent 全 0 → 跳过不推, 但仍 set_state 防重试。"""
    state = patch_pipeline
    state["counts"] = {"unread": 0, "urgent": 0, "total": 3, "by_category": {}}

    async def fake_summarize(**kwargs):
        raise AssertionError("summarize 不该被调")

    store = _FakeStore()
    fired = asyncio.run(daily_digest.run_digest_once(
        sync_store=store, repo=object(), slot="20260526-09",
        dispatch_fn=_dispatch_capture(state), summarize_fn=fake_summarize,
        now=datetime(2026, 5, 26, 9, 0, tzinfo=_BJ),
    ))
    assert fired is False
    assert state["dispatched"] == []
    # 仍记 slot
    assert store.get_state("last_daily_digest_fire") == "20260526-09"


def test_run_once_summarize_failure_degrades(patch_pipeline):
    """summarize 失败降级: headline 模板 + summary_md 空 + 代码候选直接转 actions。"""
    state = patch_pipeline
    state["counts"] = {"unread": 7, "urgent": 1, "total": 7, "by_category": {}}
    state["candidates"] = [
        digest_query.BulkCandidate(
            action_id="bulk_mark_read", internal_ids=[201, 202], sample_subjects=[],
        ),
    ]

    async def boom_summarize(**kwargs):
        raise RuntimeError("LLM down")

    store = _FakeStore()
    fired = asyncio.run(daily_digest.run_digest_once(
        sync_store=store, repo=object(), slot="20260526-18",
        dispatch_fn=_dispatch_capture(state), summarize_fn=boom_summarize,
        now=datetime(2026, 5, 26, 18, 0, tzinfo=_BJ),
    ))
    assert fired is True  # 降级也推
    d = state["dispatched"][0]
    assert d["headline"] == "今日 7 未读 / 1 紧急"
    assert d["summary_md"] == ""
    actions: List[DigestBulkAction] = d["confirmed_actions"]
    assert len(actions) == 1
    assert actions[0].id == "bulk_mark_read"
    assert actions[0].internal_ids == [201, 202]


def test_run_once_llm_action_without_candidate_ids_dropped(patch_pipeline):
    """LLM 挑了 id 但代码候选里没这个 id (无 ids) → 该 action 丢弃。"""
    state = patch_pipeline
    state["counts"] = {"unread": 3, "urgent": 0, "total": 3, "by_category": {}}
    state["candidates"] = [
        digest_query.BulkCandidate(
            action_id="bulk_mark_read", internal_ids=[301], sample_subjects=[],
        ),
    ]

    async def fake_summarize(**kwargs):
        return DigestSummary(
            headline="HL", summary_md="SM",
            confirmed_actions=[
                # LLM 挑了一个候选里没有的 id
                SummaryAction(id="bulk_mark_done", title="标记 9 完成"),
                SummaryAction(id="bulk_mark_read", title="标记 1 已读"),
            ],
        )

    store = _FakeStore()
    asyncio.run(daily_digest.run_digest_once(
        sync_store=store, repo=object(), slot="20260526-09",
        dispatch_fn=_dispatch_capture(state), summarize_fn=fake_summarize,
        now=datetime(2026, 5, 26, 9, 0, tzinfo=_BJ),
    ))
    actions = state["dispatched"][0]["confirmed_actions"]
    # 只有有候选 ids 的 bulk_mark_read 留下
    assert [a.id for a in actions] == ["bulk_mark_read"]


# ─────────────────────────────────────────────────────────────────────────────
# tick_loop — 命中触发 run_once + 不重复推
# ─────────────────────────────────────────────────────────────────────────────


def test_tick_loop_fires_run_once_on_window_hit():
    """tick 落在 fire window 内 → 调一次 run_once(slot)，之后 shutdown 退出。"""
    store = _FakeStore()
    calls: List[str] = []
    shutdown = asyncio.Event()

    async def fake_run_once(slot):
        calls.append(slot)
        # run_once 真实现会 set_state; 这里手动模拟以触发 _already_fired
        store.set_state("last_daily_digest_fire", slot)

    fixed_now = datetime(2026, 5, 26, 9, 0, tzinfo=_BJ)

    async def _go():
        task = asyncio.create_task(daily_digest.tick_loop(
            sync_store=store, run_once=fake_run_once, shutdown_event=shutdown,
            interval_sec=0, fire_hours=[9, 18], now_fn=lambda: fixed_now,
        ))
        # 让第一个 tick 跑 (interval_sec=0 → 立即再 tick)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        shutdown.set()
        await asyncio.wait_for(task, timeout=1)

    asyncio.run(_go())
    # 命中一次后 _already_fired 拦住后续 tick → 只 1 次
    assert calls == ["20260526-09"]


def test_tick_loop_skips_when_already_fired():
    """slot 已 fire 过 → tick 不再调 run_once。

    marker 迁移标记位预置成「已迁移」：本用例测的是去重闸，不是时区迁移（迁移语义见
    tests/notify/test_daily_digest_marker_migration.py）—— 不预置的话 tick_loop 启动时会
    把这个北京日 marker 换算成本地日，去重就不成立了。
    """
    store = _FakeStore({
        "last_daily_digest_fire": "20260526-09",
        daily_digest._MARKER_MIGRATION_STATE_KEY: "1",
    })
    calls: List[str] = []
    shutdown = asyncio.Event()

    async def fake_run_once(slot):
        calls.append(slot)

    fixed_now = datetime(2026, 5, 26, 9, 10, tzinfo=_BJ)

    async def _go():
        task = asyncio.create_task(daily_digest.tick_loop(
            sync_store=store, run_once=fake_run_once, shutdown_event=shutdown,
            interval_sec=0, fire_hours=[9, 18], now_fn=lambda: fixed_now,
        ))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        shutdown.set()
        await asyncio.wait_for(task, timeout=1)

    asyncio.run(_go())
    assert calls == []


def test_tick_loop_no_fire_outside_window():
    """非 window 时段 + 无补推 slot → run_once 不调。"""
    store = _FakeStore()
    calls: List[str] = []
    shutdown = asyncio.Event()

    async def fake_run_once(slot):
        calls.append(slot)

    # 7:00 早于首个 fire 钟点 → 既不命中 window 也无补推
    fixed_now = datetime(2026, 5, 26, 7, 0, tzinfo=_BJ)

    async def _go():
        task = asyncio.create_task(daily_digest.tick_loop(
            sync_store=store, run_once=fake_run_once, shutdown_event=shutdown,
            interval_sec=0, fire_hours=[9, 18], now_fn=lambda: fixed_now,
        ))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        shutdown.set()
        await asyncio.wait_for(task, timeout=1)

    asyncio.run(_go())
    assert calls == []
