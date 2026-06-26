"""InProcessEventBus — 无 Redis 时的进程内 SSE 事件总线 (Y, task #11).

定位 (docs/archive/2026-06/06-26-realtime-refresh-sse-prd.md §Y):
- 一体化 app 无 Redis 时, ``publisher.safe_publish`` 投递本总线, ``sse_server`` 订阅本
  总线, 替代 Redis pubsub, 让 watcher (serve 进程) 的异步更新实时推到前端。
- ``redis_url`` 在场时本总线完全不参与 (either/or, 见 ``safe_publish`` / ``sse_server``)。

设计 (architect 复核 2026-06-26):
- publisher 和 sse_server 同在 serve 进程、同一 asyncio event loop
  (``service.py`` 的 ``create_task(watcher.start())`` + ``await start_sse_server()`` 在
  同一个 ``asyncio.run``)。watcher 的 ``safe_publish`` 与 SSE handler 同 loop。
- ``publish()`` 是同步函数 (``safe_publish`` 本身 sync), 可能从 loop 线程 / 别的线程 /
  serve-api 进程调。``asyncio.Queue`` 非线程安全 → 统一走 ``loop.call_soon_threadsafe``
  投递, 对所有边界 (无 loop / 跨线程 / loop 关闭) 都安全。
- per-subscriber 有界 ``Queue`` fanout; 满则 drop —— 事件是 invalidation hint
  (前端对 ``email.synced`` 宽 invalidate), 丢了下次事件或 60s poll 补, 绝不阻塞 loop。
"""
from __future__ import annotations

import asyncio
from typing import Optional

from loguru import logger


class InProcessEventBus:
    """进程内 SSE 事件总线: 同步 publish, async 订阅, 跨线程安全, 绝不抛。"""

    def __init__(self, *, max_queue: int = 1000) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._max_queue = max_queue

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """由 ``start_sse_server()`` 在 serve loop 上调一次, 捕获投递目标 loop。"""
        self._loop = loop

    def subscribe(self) -> "asyncio.Queue[str]":
        """新 SSE 连接订阅 → 拿独立有界 queue; 调用方必须在 finally 里 unsubscribe。"""
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=self._max_queue)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: "asyncio.Queue[str]") -> None:
        """SSE 连接断开时移除其 queue (幂等)。漏掉会让事件无限堆积 → 内存泄漏。"""
        self._subscribers.discard(q)

    def publish(self, frame_data: str) -> None:
        """同步投递一条已序列化的 SSE data 行。任意线程 / 有无 loop 都安全, 绝不抛。

        - loop 未 bind (SSE server 没起) 或无 subscriber → 静默 drop (cheap return)
        - 否则经 ``call_soon_threadsafe`` 把 fanout 调度回 serve loop 线程 (唯一线程安全
          的把事件送进 ``asyncio.Queue`` 的方式; 同 loop 调亦安全, 近 noop)
        - loop 已关闭 (serve 退出中) → 吞 ``RuntimeError`` (与 publisher silent 失败一致)
        """
        loop = self._loop
        if loop is None or not self._subscribers:
            return
        try:
            loop.call_soon_threadsafe(self._fanout, frame_data)
        except RuntimeError:
            # Event loop is closed — serve 退出中, 丢弃即可
            logger.debug("[inprocess-bus] publish on closed loop, dropped")

    def _fanout(self, frame_data: str) -> None:
        """在 serve loop 线程上运行: 把 frame put 到每个 subscriber queue。

        ``list(...)`` 取快照, 使 fanout 期间的 subscribe/unsubscribe 安全。
        某个 queue 满 → 仅丢它这一条 + warn, 不影响其他 subscriber (背压隔离)。
        """
        for q in list(self._subscribers):
            try:
                q.put_nowait(frame_data)
            except asyncio.QueueFull:
                logger.warning(
                    f"[inprocess-bus] subscriber queue full (max={self._max_queue}), "
                    "dropping event"
                )


# ============================================================
# Module-level singleton (lazy)
# ============================================================

_bus_singleton: Optional[InProcessEventBus] = None


def get_inprocess_bus() -> InProcessEventBus:
    """进程内单例。producer (``publisher.safe_publish``) 与 consumer (``sse_server``)
    共享同一实例 —— 二者无对象传递路径, 故走模块单例 (镜像 ``get_publisher()`` 约定)。"""
    global _bus_singleton
    if _bus_singleton is None:
        _bus_singleton = InProcessEventBus()
    return _bus_singleton


def reset_inprocess_bus_for_tests() -> None:
    """测试用; 不写入 __all__。"""
    global _bus_singleton
    _bus_singleton = None
