"""IM 侧的后台执行池 —— **daemon 线程 + 有界队列**（08-01 阶段 2 PR-2）。

为什么不用 ``concurrent.futures.ThreadPoolExecutor``：

1. 🔴 **它的线程是非 daemon 的，且自 3.9 起通过 ``threading._register_atexit``
   在解释器退出时被 join**。lark 的 HTTP 段走 ``requests`` 且 SDK 没设 timeout ——
   停机瞬间恰好卡在一个发消息请求上，就会把整个进程的退出挂在那儿（本仓已有
   30s 硬退兜底 Timer，但那是最后一道网，不该常态踩）。daemon 线程不参与 join。
2. 它的队列是**无界**的。而喂它的是飞书事件 handler —— handler 有 3 秒硬预算，
   我们要的是「满了就立刻丢弃并明说」，不是「排到天荒地老」。

``submit`` 永不阻塞、永不抛 —— 它被**直接**从 lark 的 WS 事件线程调用。
"""

from __future__ import annotations

import queue
import threading
from typing import Any, Callable, Optional

from loguru import logger

from src.im.logfmt import describe_error

DEFAULT_WORKERS = 4
# 队列上限：私聊场景下 64 条待处理已经是「明显不对劲」的量级。
DEFAULT_QUEUE_SIZE = 64

_SHUTDOWN = object()


class DaemonExecutor:
    """固定大小的 daemon 线程池。任务是 ``(fn, args)``，异常只记日志不上抛。"""

    def __init__(
        self,
        *,
        workers: int = DEFAULT_WORKERS,
        queue_size: int = DEFAULT_QUEUE_SIZE,
        name: str = "im-feishu-work",
        on_discard: Optional[Callable[[int], None]] = None,
    ) -> None:
        """
        Args:
            on_discard: PR-3 —— ``shutdown()`` 时队列里还压着 N 个没跑的任务时回调一次
                （参数 = 被丢弃的任务数）。echo 时代弃单无所谓；接上 agent run 后弃单
                = owner 发的消息**静默消失**，至少要尽力告知一声。回调自身异常被吞。
        """
        if workers <= 0:
            raise ValueError("DaemonExecutor workers must be positive")
        self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=queue_size)
        self._threads = [
            threading.Thread(target=self._loop, name=f"{name}-{i}", daemon=True)
            for i in range(workers)
        ]
        self._started = False
        self._closed = False
        self._on_discard = on_discard

    def start(self) -> "DaemonExecutor":
        if not self._started:
            self._started = True
            for t in self._threads:
                t.start()
        return self

    def submit(self, fn: Callable[..., Any], *args: Any) -> bool:
        """入队一个任务。返回是否入队成功（**队列满 → False 并明说**，不阻塞）。"""
        if self._closed:
            logger.warning("[im-feishu] 执行池已关闭，丢弃任务")
            return False
        try:
            self._queue.put_nowait((fn, args))
            return True
        except queue.Full:
            logger.error(
                "[im-feishu] 🔴 后台执行队列已满，丢弃这条消息的处理 —— "
                "说明处理速度跟不上消息速度（看看是不是某个投递卡住了）"
            )
            return False

    def shutdown(self) -> None:
        """通知 worker 退出。**不 join** —— 线程是 daemon，停机不等它们。

        PR-3：先把队列里**还没被领走**的任务清点出来（它们永远不会执行了 ——
        对应「owner 发的消息不会有任何回复」），ERROR 明说 + 触发 ``on_discard``
        尽力告知；已在 worker 手里跑着的任务不受影响（daemon 线程自生自灭）。
        """
        if self._closed:
            return
        self._closed = True
        discarded = 0
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                break
            if item is not _SHUTDOWN:
                discarded += 1
        if discarded:
            logger.error(
                f"[im-feishu] 🔴 执行池关闭时丢弃了 {discarded} 个未处理任务 —— "
                "这些消息不会得到回复（连接重启路径）"
            )
            if self._on_discard is not None:
                try:
                    self._on_discard(discarded)
                except Exception as e:  # noqa: BLE001 — 告知是尽力而为
                    logger.warning(f"[im-feishu] on_discard 回调异常: {describe_error(e)}")
        for _ in self._threads:
            try:
                self._queue.put_nowait(_SHUTDOWN)
            except queue.Full:
                pass  # 队列满时 worker 迟早会消费到底并看到 closed 标志

    def _loop(self) -> None:
        while True:
            try:
                # 带超时的 get：``shutdown`` 时若队列恰好满，哨兵入不了队 —— 靠这个
                # 超时让 worker 自己看见 ``_closed`` 退出，不留永远阻塞的僵尸线程
                # （worker 每次 supervise 重启都会新建一个池）。
                item: Optional[Any] = self._queue.get(timeout=1.0)
            except queue.Empty:
                if self._closed:
                    return
                continue
            if item is _SHUTDOWN:
                return
            if self._closed:
                # 关停竞态：shutdown 清点时这个任务恰好被本线程领走 —— 同样是弃单，
                # 至少在日志里明说（不静默消失）。
                logger.error("[im-feishu] 执行池已关闭，丢弃一个刚领到的任务（不会有回复）")
                return
            fn, args = item
            try:
                fn(*args)
            except Exception as e:  # noqa: BLE001 — 线程里逃逸的异常没人接得住
                logger.error(f"[im-feishu] 后台任务异常: {describe_error(e)}")
