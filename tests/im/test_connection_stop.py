"""``FeishuConnection.stop()`` 的停机路径 —— 不许阻塞调用者（src/im/connection.py）。

🔴 本文件盯的是一个**具体的阻塞事故形态**：``stop()`` 的优雅断开走
``asyncio.run_coroutine_threadsafe(ws._disconnect(), loop)`` + ``fut.result(3s)``。
那个 ``loop`` 是 lark 连接线程在跑的 loop —— **线程一旦死了（凭证错 / 非自建应用 /
握手失败让 ``ws.start()`` 抛出），loop 就不再转，future 永远不会完成，
``fut.result`` 就是实打实的 3 秒同步阻塞**。

而 ``stop()`` 的两个调用点都在 **serve 的 event loop 线程**上
（``FeishuImWorker._serve_connection`` 的 finally / 服务停机路径），所以那 3 秒是把
**整个服务主循环**冻住 —— 每轮 fatal 重连一次（镜像 CLAUDE.md 对「锁等待发生在 event
loop 线程上会冻住所有 worker」的红线）。判据用「线程还活着吗」：线程死了 = WS 早随它
一起没了，本来也无可断。

不 import lark：用最小替身喂 ``_ws`` / ``_loop`` / ``_thread``（``src/im`` 顶层无 lark
import 这件事由 test_import_discipline.py 单独盯着）。
"""

from __future__ import annotations

import asyncio
import threading
import time

from src.im.connection import FeishuConnection


class _FakeWs:
    """只提供 ``_disconnect`` 协程；被调用即记账（本用例里**不该**被调用）。"""

    def __init__(self) -> None:
        self.disconnect_calls = 0

    async def _disconnect(self) -> None:  # pragma: no cover - 被调用即用例失败
        self.disconnect_calls += 1


def _conn() -> FeishuConnection:
    return FeishuConnection("cli_x", "secret", message_handler=lambda _d: None)


def test_stop_with_dead_thread_returns_immediately():
    """连接线程已死（fatal 退出）→ stop() 立刻返回，不去 3 秒等一个永不完成的 future。"""
    conn = _conn()
    ws = _FakeWs()
    # 线程跑完就退出的形态：loop 建了但**没在转**（run_until_complete 已抛出退出）
    loop = asyncio.new_event_loop()
    dead = threading.Thread(target=lambda: None)
    dead.start()
    dead.join()
    try:
        conn._ws = ws
        conn._loop = loop
        conn._thread = dead

        started = time.monotonic()
        conn.stop()
        elapsed = time.monotonic() - started
    finally:
        loop.close()

    assert elapsed < 1.0, (
        f"stop() 阻塞了 {elapsed:.2f}s —— 线程已死时又去 run_coroutine_threadsafe 了？"
        "那个 future 永远不会完成，这 3 秒是冻在 serve 的 event loop 线程上的"
    )
    assert ws.disconnect_calls == 0, "线程都没了还调 _disconnect：调度到一个不转的 loop 上"


def test_stop_before_start_is_a_noop():
    """从没 start 过 → stop() 幂等且不抛（服务启动失败的清理路径会这么调）。"""
    conn = _conn()
    conn.stop()
    conn.stop()
