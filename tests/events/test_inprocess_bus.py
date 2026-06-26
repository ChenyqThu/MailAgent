"""InProcessEventBus 单测 (Y: 无 Redis 进程内 SSE 总线, task #11).

覆盖 architect 设计 checklist (06-26-realtime-refresh-sse-prd.md §Y):
- subscribe 返回独立 queue; publish fanout 到所有; unsubscribe 移除
- 跨线程 publish 经 call_soon_threadsafe 投递到 async 等待点 (load-bearing)
- 同 loop publish 投递 (watcher 常路径)
- publish 在 bind_loop 前 / 无 subscriber → 静默 drop 不抛
- QueueFull → 该 subscriber drop, 其他 subscriber 仍收到 (背压不互相影响)
- loop closed → publish 静默吞
- 模块单例 get_inprocess_bus / reset_inprocess_bus_for_tests

全部用 wait_for / sleep(0) yield 同步, 不用定时 sleep → 零 flaky。
"""
from __future__ import annotations

import asyncio
import threading

import pytest

from src.events.inprocess_bus import (
    InProcessEventBus,
    get_inprocess_bus,
    reset_inprocess_bus_for_tests,
)


# ============================================================
# fanout / subscribe / unsubscribe
# ============================================================

class TestFanout:
    @pytest.mark.asyncio
    async def test_subscribe_returns_distinct_queues(self):
        bus = InProcessEventBus()
        q1 = bus.subscribe()
        q2 = bus.subscribe()
        assert q1 is not q2

    @pytest.mark.asyncio
    async def test_same_loop_publish_delivered(self):
        """watcher 常路径: 同 loop sync publish → async q.get() 收到."""
        bus = InProcessEventBus()
        bus.bind_loop(asyncio.get_running_loop())
        q = bus.subscribe()
        bus.publish("x")
        assert await asyncio.wait_for(q.get(), 1.0) == "x"

    @pytest.mark.asyncio
    async def test_fanout_to_all_subscribers(self):
        bus = InProcessEventBus()
        bus.bind_loop(asyncio.get_running_loop())
        q1 = bus.subscribe()
        q2 = bus.subscribe()
        bus.publish("hi")
        assert await asyncio.wait_for(q1.get(), 1.0) == "hi"
        assert await asyncio.wait_for(q2.get(), 1.0) == "hi"

    @pytest.mark.asyncio
    async def test_unsubscribe_removes(self):
        bus = InProcessEventBus()
        bus.bind_loop(asyncio.get_running_loop())
        q = bus.subscribe()
        bus.unsubscribe(q)
        bus.publish("x")
        # 已退订 → 不应收到 (短 timeout 验证空)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), 0.1)


# ============================================================
# cross-thread (load-bearing: call_soon_threadsafe)
# ============================================================

class TestCrossThread:
    @pytest.mark.asyncio
    async def test_cross_thread_publish_delivered(self):
        """真实 threading.Thread 调 sync publish → async q.get() 收到.

        asyncio.Queue 非线程安全, publish 必须经 call_soon_threadsafe 把 fanout
        调度回 serve loop 线程; 这是 Y 的命门正确性测。
        """
        bus = InProcessEventBus()
        bus.bind_loop(asyncio.get_running_loop())
        q = bus.subscribe()
        threading.Thread(target=lambda: bus.publish("from-thread")).start()
        assert await asyncio.wait_for(q.get(), 1.0) == "from-thread"


# ============================================================
# 边界条件
# ============================================================

class TestBoundaries:
    def test_publish_before_bind_loop_drops(self):
        """loop 未 bind (SSE server 没起) → publish 不抛, 无投递."""
        bus = InProcessEventBus()
        q = bus.subscribe()
        bus.publish("x")  # 不抛
        assert q.empty()

    def test_publish_no_subscribers_noop(self):
        """无 subscriber → 早返回不抛 (不进 call_soon)."""
        loop = asyncio.new_event_loop()
        try:
            bus = InProcessEventBus()
            bus.bind_loop(loop)
            bus.publish("x")  # 不抛
        finally:
            loop.close()

    def test_publish_after_loop_closed_swallowed(self):
        """loop 已关闭 (serve 退出中) → call_soon_threadsafe RuntimeError 被吞."""
        loop = asyncio.new_event_loop()
        bus = InProcessEventBus()
        q = bus.subscribe()  # 有 subscriber 才会走到 call_soon
        _ = q
        bus.bind_loop(loop)
        loop.close()
        bus.publish("x")  # 不抛

    @pytest.mark.asyncio
    async def test_queue_full_one_drops_other_receives(self):
        """一个 subscriber queue 满 → 它 drop, 其他 subscriber 仍收到."""
        bus = InProcessEventBus(max_queue=1)
        bus.bind_loop(asyncio.get_running_loop())
        q_slow = bus.subscribe()
        q_fast = bus.subscribe()

        bus.publish("a")
        await asyncio.sleep(0)  # yield 让 fanout(a) 跑 → 两 queue 各 [a] 满
        # q_fast 取出 a 空出来; q_slow 保持满
        assert await asyncio.wait_for(q_fast.get(), 1.0) == "a"

        bus.publish("b")
        await asyncio.sleep(0)  # fanout(b): q_slow 满→drop; q_fast 空→put b
        assert await asyncio.wait_for(q_fast.get(), 1.0) == "b"
        # q_slow 仍是 a (b 被 drop), 背压不污染其他 subscriber
        assert await asyncio.wait_for(q_slow.get(), 1.0) == "a"
        assert q_slow.empty()


# ============================================================
# 单例
# ============================================================

class TestSingleton:
    def setup_method(self):
        reset_inprocess_bus_for_tests()

    def teardown_method(self):
        reset_inprocess_bus_for_tests()

    def test_get_inprocess_bus_singleton(self):
        assert get_inprocess_bus() is get_inprocess_bus()

    def test_reset_returns_new_instance(self):
        a = get_inprocess_bus()
        reset_inprocess_bus_for_tests()
        assert get_inprocess_bus() is not a


# ============================================================
# bind_loop 幂等 / rebind 安全 (codex MEDIUM 1)
# ============================================================

class TestBindLoop:
    def test_bind_loop_idempotent_same_loop(self):
        """相同 loop 重复 bind → 幂等, 不清 subscriber."""
        loop = asyncio.new_event_loop()
        try:
            bus = InProcessEventBus()
            bus.bind_loop(loop)
            bus.subscribe()
            bus.bind_loop(loop)  # 幂等
            assert len(bus._subscribers) == 1
        finally:
            loop.close()

    def test_bind_loop_rebind_clears_stale_subscribers(self):
        """重绑到不同 loop + 有 subscriber → 清旧 subscriber (防跨 loop 投递)."""
        l1 = asyncio.new_event_loop()
        l2 = asyncio.new_event_loop()
        try:
            bus = InProcessEventBus()
            bus.bind_loop(l1)
            bus.subscribe()
            assert len(bus._subscribers) == 1
            bus.bind_loop(l2)  # 重绑新 loop → 清旧 subscriber
            assert len(bus._subscribers) == 0
            assert bus._loop is l2
        finally:
            l1.close()
            l2.close()
