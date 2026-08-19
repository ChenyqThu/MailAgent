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
- per-subscriber 有界 ``Queue`` fanout; 满则 drop。这是一条 **lossy bus**: 丢事件不阻塞
  loop。当前事件 (email.synced / llm.* / job.*) 要么是 invalidation hint (前端宽 invalidate),
  要么有查询/轮询兜底 (如 job 走 ``/jobs/{id}`` 轮询)。**新增状态类事件必须自带查询/轮询
  兜底**, 不能假设 bus 不丢。

跨进程盲区 (E4 §6.4 注记 2026-07-11 记录 → **2026-08-18 S1 已消除**, 走候选①):
- 投递前提是 publisher 与 sse_server 同进程同 loop (serve 进程)。**serve-api 进程**没有
  sse_server, 其 InProcessEventBus 实例从未 ``bind_loop()``。曾经的后果: serve-api
  进程内代码调 ``publisher.safe_publish`` (无 Redis 的打包态) 落到本总线即
  ``bus._loop=None`` → 连"丢弃"都算不上, 是从未真正投递。
- **现在的行为**: ``safe_publish`` 先用 ``has_loop()`` 探本进程有没有 sse_server;
  没有 → 回落 ``src/events/loopback.py`` 的 POST ``127.0.0.1:9200/api/events/publish``,
  由 serve 侧重新 publish 进本总线。改的是 ``safe_publish`` 内部而非各调用方, 所以
  下面列的**全部**受影响调用点一次性复活, 无需逐点改造。
- 曾受影响、现已复活的调用点 (2026-07-11 全量 grep 逐点判定运行进程):
  ① ``src/api/routers/jobs.py:87`` (job.enqueued, serve-api 原生); ②
  ``src/services/mail_write.py`` set_flags / set_pin / delete_draft 三处 —— 服务层
  in-process, 写经 serve-api HTTP 适配器时落 serve-api 进程 (CLI fork 适配器同理落
  CLI 进程); ③ ``src/sync/outbox.py`` enqueue (outbox.queued) —— 经 outbox_intents
  被②的写路径同进程调到; ④ ``src/llm_agent/store.py`` mark_success / mark_failed ——
  serve-api ``/api/llm/run`` 走 in-process LlmService 时同进程调到。其余调用面
  (new_watcher / sync_store mark_synced_* / mailapp_fanout / notion_fanout /
  outbox mark_done·mark_failed / job_worker —— JobWorker 只在 service.py 实例化)
  本来就只跑在 serve 进程, 一直正常。
- 🔴 **lossy 纪律不变**: loopback 是 fire-and-forget + 有界队列, serve 没起 / 队列满
  都会静默丢。上面那条「新增状态类事件必须自带查询/轮询兜底」依然成立 —— 复活的是
  「大多数时候能实时刷新」, 不是「保证送达」。
- 未选的另外两个候选: ② SSE server 迁 serve-api 进程 (回归面太大); ③ 正式化
  「乐观回显 + invalidate」为契约 (对事项这类有乐观锁的域会和 CAS 打架)。
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
        """由 ``start_sse_server()`` 在 serve loop 上调, 捕获投递目标 loop。

        幂等 (相同 loop 重复调无副作用)。若重绑到**不同** loop 且仍有 subscriber:
        说明 SSE server 在同进程被重启到新 loop —— 旧 subscriber 的 ``asyncio.Queue``
        绑在旧 loop 上, 继续向其投递会跨 loop 唤醒 (不安全), 故清空它们 + warning
        (旧连接由其自身 handler 的 finally 收尾)。
        """
        if self._loop is loop:
            return
        if self._loop is not None and self._subscribers:
            logger.warning(
                f"[inprocess-bus] rebind to a new loop, clearing "
                f"{len(self._subscribers)} stale subscriber(s) bound to the old loop"
            )
            self._subscribers.clear()
        self._loop = loop

    def has_loop(self) -> bool:
        """本进程是否有 SSE server (loop 已 bind) —— ``publisher.safe_publish`` 据此决定
        走进程内投递还是 loopback 回落 (S1)。

        比让 publisher 摸 ``_loop`` 私有属性干净; 判据与 ``publish()`` 的第一道
        early-return 同源, 不会漂开。
        """
        return self._loop is not None

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
