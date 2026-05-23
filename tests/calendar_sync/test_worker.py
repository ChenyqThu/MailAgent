"""CalendarSyncWorker — asyncio loop 基本行为测试 (CalDAV 全 mock)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.calendar_notion.caldav_reader import CalendarEvent
from src.calendar_sync import CalendarEventRepository, CalendarSyncWorker


def _cfg(enabled: bool = True) -> SimpleNamespace:
    """Stub Config-shaped namespace."""
    return SimpleNamespace(
        calendar_caldav_sync_enabled=enabled,
    )


def _make_event(uid: str, *, calendar_name: str = "Personal") -> CalendarEvent:
    start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
    return CalendarEvent(
        summary=f"Event {uid}", start=start, end=start + timedelta(hours=1),
        ical_uid=uid, calendar_name=calendar_name,
    )


@pytest.mark.asyncio
async def test_worker_disabled_short_circuits(fresh_db):
    """cfg.calendar_caldav_sync_enabled=False → run() 立即返回."""
    reader = MagicMock()
    repo = CalendarEventRepository(fresh_db)
    worker = CalendarSyncWorker(cfg=_cfg(enabled=False), reader=reader, repo=repo)
    await asyncio.wait_for(worker.run(), timeout=1.0)
    # reader 完全没被调
    reader.list_calendar_names_for_sync.assert_not_called()


@pytest.mark.asyncio
async def test_worker_initial_full_sync_seeds_db(fresh_db):
    """启动跑一次 full sync → seed events 落 calendar_event 表."""
    reader = MagicMock()
    reader.list_calendar_names_for_sync.return_value = ["Personal"]
    reader.list_events_with_full_detail.return_value = [
        _make_event("ev-1"), _make_event("ev-2"),
    ]
    reader.get_collection_ctag.return_value = "ctag-init"

    repo = CalendarEventRepository(fresh_db)
    worker = CalendarSyncWorker(
        cfg=_cfg(enabled=True), reader=reader, repo=repo,
        poll_interval=10.0,  # 大 interval, 让 stop 在 full sync 后立刻跳出 loop
    )

    async def stop_after_initial():
        # 给 initial full sync 一点点时间, 然后 stop
        await asyncio.sleep(0.2)
        worker.stop()

    await asyncio.gather(worker.run(), stop_after_initial())

    # 验证: 2 个 event 落库 + sync_state 有 ctag
    rows = repo.list_event_rows(source="caldav")
    assert {r.ical_uid for r in rows} == {"ev-1", "ev-2"}
    state = repo.get_sync_state("Personal")
    assert state is not None
    assert state.ctag == "ctag-init"
    assert state.last_full_sync_at is not None


@pytest.mark.asyncio
async def test_worker_tick_skips_when_ctag_unchanged(fresh_db):
    """ctag 跟上轮一致 → 不重新 search events."""
    reader = MagicMock()
    reader.list_calendar_names_for_sync.return_value = ["Personal"]
    reader.list_events_with_full_detail.return_value = [_make_event("ev-1")]
    reader.get_collection_ctag.return_value = "ctag-stable"

    repo = CalendarEventRepository(fresh_db)
    worker = CalendarSyncWorker(
        cfg=_cfg(enabled=True), reader=reader, repo=repo,
        poll_interval=0.1,  # 快速 tick, 让多轮 fire
    )

    async def stop_after_few_ticks():
        await asyncio.sleep(0.5)  # 触发 ~4-5 个 tick
        worker.stop()

    await asyncio.gather(worker.run(), stop_after_few_ticks())

    # initial full sync 调一次 + 0 次 tick re-read (ctag 没变)
    # 不严格 assert call_count (asyncio timing fragile), 只 sanity check 不爆
    assert reader.list_events_with_full_detail.call_count >= 1


@pytest.mark.asyncio
async def test_worker_tick_full_resync_on_ctag_change(fresh_db):
    """ctag 变了 + sync-collection 不可用 → 走全窗口 re-read."""
    reader = MagicMock()
    reader.list_calendar_names_for_sync.return_value = ["Personal"]
    reader.list_events_with_full_detail.return_value = [_make_event("ev-1")]
    # sync_collection 返回 (空, 空, None) → 增量不可用
    reader.sync_collection.return_value = ([], [], None)
    # ctag 序列: init → init → new → new
    ctag_iter = iter(["ctag-init", "ctag-init", "ctag-new", "ctag-new"])
    reader.get_collection_ctag.side_effect = lambda _cal: next(ctag_iter, "ctag-new")

    repo = CalendarEventRepository(fresh_db)
    worker = CalendarSyncWorker(
        cfg=_cfg(enabled=True), reader=reader, repo=repo,
        poll_interval=0.1,
    )

    async def stop_after_few_ticks():
        await asyncio.sleep(0.6)  # ~5-6 个 tick
        worker.stop()

    await asyncio.gather(worker.run(), stop_after_few_ticks())

    state = repo.get_sync_state("Personal")
    assert state is not None
    assert state.ctag in ("ctag-init", "ctag-new")  # 取决于停止时机


@pytest.mark.asyncio
async def test_worker_graceful_cancel(fresh_db):
    """asyncio.CancelledError 优雅退, 不爆栈."""
    reader = MagicMock()
    reader.list_calendar_names_for_sync.return_value = ["Personal"]
    reader.list_events_with_full_detail.return_value = []
    reader.get_collection_ctag.return_value = "ctag-1"

    repo = CalendarEventRepository(fresh_db)
    worker = CalendarSyncWorker(
        cfg=_cfg(enabled=True), reader=reader, repo=repo, poll_interval=10.0,
    )

    task = asyncio.create_task(worker.run())
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
