"""单测: NewWatcher fire-and-forget hook task 强引用 (task 06-10, prd Fix 2d).

Python 3.11 asyncio loop 只弱引用 task — 无强引用的 pending task 可能被 GC
中途回收 (生产实证见 new_watcher.start() 里 _rollout_flush_task 注释)。
修后 hook 派发的 task 进 ``self._bg_tasks`` 强引用集合, 完成自动 discard。

async def 测试由 tests/mail/conftest.py 的 pytest_pyfunc_call hook 自动
asyncio.run 包裹。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from src.mail.new_watcher import NewWatcher


async def test_llm_hook_tracks_task_and_discards_on_done():
    # 最小构造 (__new__ 不走 __init__) — 同时覆盖 _track_bg_task 的 lazy init 路径
    w = NewWatcher.__new__(NewWatcher)
    ran = asyncio.Event()

    async def fake_run(internal_id, **kwargs):
        ran.set()
        return {"ok": False, "error": "test", "retry_count": 0}

    w._llm_runner = SimpleNamespace(run_for_internal_id=fake_run)
    email = SimpleNamespace(mailbox="收件箱", subject="Test subject", sender="a@b.c")

    w._maybe_trigger_llm_hook(email, 1, "page-id")

    assert len(w._bg_tasks) == 1, "hook 派发的 task 未进强引用集合"
    task = next(iter(w._bg_tasks))
    await task
    await asyncio.sleep(0)  # 让 done_callback (discard) 跑完
    assert ran.is_set()
    assert len(w._bg_tasks) == 0, "task 完成后未自动移除"


async def test_track_bg_task_lazy_init_and_discard():
    w = NewWatcher.__new__(NewWatcher)

    async def _noop():
        return None

    t = asyncio.create_task(_noop())
    w._track_bg_task(t)
    assert t in w._bg_tasks

    await t
    await asyncio.sleep(0)
    assert len(w._bg_tasks) == 0


async def test_track_bg_task_holds_multiple_inflight():
    w = NewWatcher.__new__(NewWatcher)
    gate = asyncio.Event()

    async def _wait():
        await gate.wait()

    tasks = [asyncio.create_task(_wait()) for _ in range(3)]
    for t in tasks:
        w._track_bg_task(t)
    assert len(w._bg_tasks) == 3  # in-flight 数可观测

    gate.set()
    await asyncio.gather(*tasks)
    await asyncio.sleep(0)
    assert len(w._bg_tasks) == 0
