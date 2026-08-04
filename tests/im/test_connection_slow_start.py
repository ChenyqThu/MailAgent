"""``FeishuConnection`` 慢启动 / 弃置线程自杀线（2026-08-04 真机事故回归）。

🔴 事故形态：packaged 首启的 lark 冷 import 耗时 2min17s，``start()`` 的 30s
ready 窗口超时 → worker 弃置重建 → 弃置线程醒来抢跑 ``ws.start()`` 占死 lark
的模块级全局 event loop → 之后每条新线程都撞 ``_run`` 的 fail-closed 检查，
永久踢皮球。本文件在 connection 层钉两条防线：

1. **慢 ≠ 死**：ready 超时后线程活着、没 fatal、就绪后照常可用；
2. **自杀线**：``_stopping`` 置位后线程醒来**绝不**调 ``ws.start()``。

不 import lark：``_prepare`` 是专门留的打桩 seam（模拟「卡在冷 import」），
fake ws 用真 event loop 跑 ``run_forever``（镜像 lark 的
``run_until_complete(_select())`` 形态），让 stop() 的跨线程断开真的走通。
"""

from __future__ import annotations

import asyncio
import threading
from typing import Optional

from src.im import connection as connection_mod
from src.im.connection import FeishuConnection


class _FakeWs:
    """跑真 event loop 的 ws 替身：``start()`` 阻塞在 ``run_forever``，
    ``_disconnect`` 可被 stop() 跨线程调度（与真 lark 同形态）。"""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._conn: Optional[object] = None
        self.start_calls = 0
        self.started = threading.Event()

    def start(self) -> None:
        self.start_calls += 1
        self._conn = object()  # 假装握手成功（is_connected 判据 = _conn 非 None）
        self.started.set()
        self._loop.run_forever()

    async def _disconnect(self) -> None:
        self._conn = None


class _StubPrepareConnection(FeishuConnection):
    """``_prepare`` 打桩：用事件模拟「卡在冷 import」，释放后装配 fake ws。

    🔴 刻意**不**在 ``_prepare`` 里检查 ``_stopping``（真实现有查）——
    让测试打到 ``_run`` 自杀线这**最后一道**防线上。
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.release = threading.Event()
        self.fake_ws: Optional[_FakeWs] = None

    def _prepare(self):
        self.release.wait(timeout=10)  # 「冷 import」——测试里由 release 控制时长
        loop = asyncio.new_event_loop()
        self._loop = loop
        ws = _FakeWs(loop)
        self.fake_ws = ws
        # 🔴 与真 _prepare 一样**只 return、不写 self._ws** —— 发布权归 _run 且必须
        # 在自杀线之后（见 connection._run 注释）。这里若抢先发布，就复现了那个
        # 「_ws 已公布但 loop 永不转」的窗口，下面的 _ws is None 断言也就失了效。
        return ws


class _ExplodingPrepareConnection(FeishuConnection):
    """``_prepare`` 抛错 = 真 fatal（凭证错 / 非自建应用等价形态）。"""

    def _prepare(self):
        raise RuntimeError("boom-prepare")


def _stub_conn() -> _StubPrepareConnection:
    return _StubPrepareConnection("cli_x", "secret", message_handler=lambda _d: None)


def test_ready_timeout_leaves_a_usable_live_thread():
    """慢 ≠ 死：ready 超时返回 False，但线程活着、没 fatal —— 就绪后照常可用。"""
    conn = _stub_conn()
    try:
        assert conn.start(ready_timeout_sec=0.05) is False  # 事故里的「30s 超时」
        assert conn.is_alive()
        assert conn.fatal_error is None
        assert not conn.is_ready()

        conn.release.set()  # 「冷 import」结束
        assert conn._ready.wait(timeout=2)
        assert conn.is_ready(), "线程就绪后 is_ready 必须翻 True（worker 靠它续等）"
        assert conn.fake_ws is not None
        assert conn.fake_ws.started.wait(timeout=2), "就绪后没有进入 ws.start()"
        assert conn.is_connected()
    finally:
        conn.stop()
        if conn._thread is not None:
            conn._thread.join(timeout=2)
        assert not conn.is_alive()
        if conn._loop is not None:
            conn._loop.close()


def test_abandoned_thread_never_calls_ws_start(monkeypatch):
    """🔴 弃置线程自杀线（事故核心）：stop() 置位 ``_stopping`` 后线程才醒来 ——
    绝不调 ``ws.start()``（不碰全局 loop），直接退出且不算 fatal。"""
    monkeypatch.setattr(connection_mod, "THREAD_JOIN_TIMEOUT_SEC", 0.05)
    conn = _stub_conn()
    assert conn.start(ready_timeout_sec=0.05) is False
    conn.stop()  # join 0.05s 超时：线程还「卡在冷 import」里，杀不死
    assert conn.is_alive(), "前置不成立：线程应当还卡在 _prepare 里"

    conn.release.set()  # 线程醒来 —— 必须发现 _stopping 并自杀
    assert conn._thread is not None
    conn._thread.join(timeout=2)
    assert not conn.is_alive(), "弃置线程醒来后没有退出"
    assert conn.fake_ws is not None
    assert conn.fake_ws.start_calls == 0, (
        "弃置线程调了 ws.start() —— 它会抢占 lark 的模块级全局 loop，"
        "把之后所有新连接线程永久钉死（2026-08-04 事故形态）"
    )
    assert conn.fatal_error is None, "停机退出不是 fatal"
    # 🔴 自杀的线程**不许发布 _ws**：stop() 拿「_ws 非 None + 线程活着」当判据把
    # ws._disconnect() 调度到这条线程的 loop 上、再 fut.result(3s) 等 —— 而自杀路径
    # 上那条 loop 永远不会转。发布了就是 3 秒同步冻结在 serve 的 event loop 线程上
    # （test_connection_stop.py 盯的同一个形态，只是换了个入口）。
    assert conn._ws is None, "弃置线程发布了 _ws —— stop() 会去等一个永不完成的 future"
    assert not conn.is_ready(), "自杀退出的连接不该自称 ready"
    if conn._loop is not None:
        conn._loop.close()


def test_prepare_failure_is_fatal_and_thread_dies():
    """真 fatal（构造抛错）→ 线程死 + fatal_error 有详情（worker 据此走退避重建）。"""
    conn = _ExplodingPrepareConnection("cli_x", "secret", message_handler=lambda _d: None)
    assert conn.start(ready_timeout_sec=2.0) is False
    assert conn._thread is not None
    conn._thread.join(timeout=2)
    assert not conn.is_alive()
    assert conn.fatal_error is not None and "boom-prepare" in conn.fatal_error
    assert not conn.is_ready()
