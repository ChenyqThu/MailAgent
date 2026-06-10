"""单测: island_dispatch._fire background task 强引用 (task 06-10, prd Fix 2d)."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List

from src.notify import island_dispatch, ping_island
from src.notify.island_envelope import BridgeEnvelope


class _FakeSyncStore:
    def __init__(self):
        self.rows: List[Dict[str, Any]] = []

    def record_island_dispatch(self, **kwargs):
        self.rows.append(kwargs)
        return len(self.rows)


def test_fire_tracks_task_and_discards_on_done(monkeypatch):
    captured: List[Any] = []

    async def fake_send_async(envelope, **kwargs):
        captured.append(envelope)
        return ping_island.SendResult(ok=True, response=None, latency_ms=5)

    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)
    # 模块级状态跨 test 隔离 (同 test_island_dispatch.py 的做法)
    island_dispatch._dedup_seen.clear()
    island_dispatch._bg_tasks.clear()
    island_dispatch.init(enabled=True, sync_store=_FakeSyncStore())

    env = BridgeEnvelope(
        event_type="MailReceived",
        session_key="mailagent:test:bg-task-refs",
        title="t",
    )

    async def _scenario():
        island_dispatch._fire(env, internal_id=None)
        assert len(island_dispatch._bg_tasks) == 1, "_fire 的 task 未进强引用集合"
        task = next(iter(island_dispatch._bg_tasks))
        await task
        await asyncio.sleep(0)  # 让 done_callback (discard) 跑完
        assert len(island_dispatch._bg_tasks) == 0, "task 完成后未自动移除"

    asyncio.run(_scenario())
    assert len(captured) == 1
