"""serial_executor 单测 — 单线程 backend-io executor 串行保序 + 不阻塞事件循环.

WP3 (E4 第一批 §2): 把阻塞的 backend 调用 (new_watcher 4 处 fetch + mailapp_fanout
2 处写) 移出事件循环线程 (to_thread 化) 后必须显式单线程保序 —— AppleScript 与单条
IMAP/davmail 连接均非并发安全 (无锁, EWS throttling 历史真实发生)。本文件锚死不变量:

1. run_backend_io 里的 fn 跑在独立的 backend-io 线程 (非事件循环线程);
2. 多个 run_backend_io 严格串行 (单线程, 峰值并发恒 1, 不并发命中 backend);
3. 慢 fetch 注入: 阻塞的 backend 调用期间, 同 loop 的其他协程持续推进 (loop 未阻塞)。
"""
from __future__ import annotations

import asyncio
import threading
import time

from src.mail.backend.serial_executor import run_backend_io


def test_runs_off_event_loop_thread():
    """run_backend_io 里的 fn 跑在名为 backend-io 的独立线程, 非主/事件循环线程."""
    main_thread = threading.current_thread()
    captured = {}

    def _capture():
        captured["thread"] = threading.current_thread()
        return "ok"

    async def _run():
        return await run_backend_io(_capture)

    result = asyncio.run(_run())
    assert result == "ok"
    assert captured["thread"] is not main_thread
    assert captured["thread"].name.startswith("backend-io")


def test_passes_args_and_kwargs():
    """位置参数 + 关键字参数原样透传 (functools.partial)."""

    def _fn(a, b, *, c):
        return (a, b, c)

    async def _run():
        return await run_backend_io(_fn, 1, 2, c=3)

    assert asyncio.run(_run()) == (1, 2, 3)


def test_concurrent_calls_serialized():
    """两个并发 run_backend_io (各自同步 sleep) 严格串行: 执行区间不重叠."""
    active = {"count": 0, "max_overlap": 0}
    lock = threading.Lock()

    def _slow():
        with lock:
            active["count"] += 1
            active["max_overlap"] = max(active["max_overlap"], active["count"])
        time.sleep(0.2)
        with lock:
            active["count"] -= 1
        return "done"

    async def _run():
        return await asyncio.gather(
            run_backend_io(_slow),
            run_backend_io(_slow),
        )

    t0 = time.monotonic()
    results = asyncio.run(_run())
    elapsed = time.monotonic() - t0

    assert results == ["done", "done"]
    # 单线程串行: 峰值并发恒为 1 (若是多线程池两段 sleep 会重叠 → max_overlap==2)。
    assert active["max_overlap"] == 1
    # 两段各 0.2s 串行 → 总耗时 ≥ 0.4s (留裕度防 flaky)。
    assert elapsed >= 0.38


def test_slow_backend_fetch_does_not_block_event_loop():
    """慢 fetch 注入: backend.fetch_email_content_by_id = time.sleep 阻塞, 经
    run_backend_io 收编 (同 new_watcher 4 处 fetch 的调用路径) 后, 同 loop 的计数
    协程在 fetch 期间持续推进 —— 证明事件循环没被慢 fetch 卡住。
    """

    class _SlowBackend:
        def fetch_email_content_by_id(self, internal_id, mailbox):
            time.sleep(0.5)  # 模拟 davmail IMAP 慢 fetch
            return {"internal_id": internal_id, "message_id": "<m>", "mailbox": mailbox}

    backend = _SlowBackend()

    async def _run():
        stop = asyncio.Event()
        ticks = {"n": 0}

        async def _ticker():
            while not stop.is_set():
                ticks["n"] += 1
                await asyncio.sleep(0.02)

        ticker = asyncio.create_task(_ticker())
        # 收编后的调用路径 (与 new_watcher._sync_single_email_v3 一致)
        result = await run_backend_io(
            backend.fetch_email_content_by_id, 42, "收件箱"
        )
        stop.set()
        await ticker
        return result, ticks["n"]

    result, n_ticks = asyncio.run(_run())
    assert result["internal_id"] == 42
    assert result["mailbox"] == "收件箱"
    # 慢 fetch 0.5s / tick 间隔 0.02s → loop 未阻塞时应 ~20+ 次; 若 loop 被 fetch
    # 卡住, ticker 完全不推进 (停在个位数)。保守断言 ≥ 5 已能清晰区分两态。
    assert n_ticks >= 5
