"""daemon 执行池 + sync_state 门面（src/im/executor.py, src/im/state.py）。"""

from __future__ import annotations

import threading
import time

import pytest

from src.im.executor import DaemonExecutor
from src.im.state import (
    ImFeishuState,
    STATE_BOUND_OPEN_ID,
    STATE_CONNECTION_STATUS,
    STATE_LAST_ERROR,
    STATUS_CONNECTED,
    STATUS_CONFLICT,
)
from tests.im.conftest import FakeStateStore


class TestDaemonExecutor:
    def test_runs_submitted_work(self):
        ex = DaemonExecutor(workers=1, queue_size=4).start()
        done = threading.Event()
        assert ex.submit(lambda: done.set()) is True
        assert done.wait(timeout=2)
        ex.shutdown()

    def test_threads_are_daemon(self):
        """🔴 非 daemon 线程会被解释器退出时 join —— 卡在 HTTP 上就拖住整个停机。"""
        ex = DaemonExecutor(workers=2).start()
        assert all(t.daemon for t in ex._threads)
        ex.shutdown()

    def test_full_queue_drops_and_never_blocks(self):
        """🔴 submit 从飞书 handler 里直接调 —— 3 秒预算下绝不能阻塞。"""
        block = threading.Event()
        ex = DaemonExecutor(workers=1, queue_size=1).start()
        ex.submit(block.wait)          # 占住唯一 worker
        time.sleep(0.05)
        ex.submit(lambda: None)        # 填满队列(size=1)
        t0 = time.monotonic()
        accepted = ex.submit(lambda: None)  # 满了
        elapsed = time.monotonic() - t0
        assert accepted is False
        assert elapsed < 0.5           # 立刻返回，没有阻塞等待
        block.set()
        ex.shutdown()

    def test_task_exception_does_not_kill_the_worker(self):
        ex = DaemonExecutor(workers=1).start()
        ok = threading.Event()

        def boom():
            raise RuntimeError("boom")

        ex.submit(boom)
        ex.submit(ok.set)
        assert ok.wait(timeout=2)  # 池子还活着
        ex.shutdown()

    def test_submit_after_shutdown_is_refused(self):
        ex = DaemonExecutor(workers=1).start()
        ex.shutdown()
        assert ex.submit(lambda: None) is False

    def test_workers_must_be_positive(self):
        with pytest.raises(ValueError):
            DaemonExecutor(workers=0)


class TestState:
    def test_mark_connected_clears_last_error(self):
        store = FakeStateStore({STATE_LAST_ERROR: "old failure"})
        state = ImFeishuState(store)
        state.mark_connected()
        assert store.data[STATE_CONNECTION_STATUS] == STATUS_CONNECTED
        assert store.data[STATE_LAST_ERROR] == ""
        assert store.data["im.feishu.connected_at"]

    def test_conflict_roundtrip(self):
        store = FakeStateStore()
        state = ImFeishuState(store)
        state.mark_conflict("pm2 在跑")
        assert state.in_conflict() is True
        assert store.data[STATE_CONNECTION_STATUS] == STATUS_CONFLICT
        state.clear_conflict()
        assert state.in_conflict() is False

    def test_binding_roundtrip_and_unbind(self):
        store = FakeStateStore()
        state = ImFeishuState(store)
        assert state.get_bound_open_id() == ""
        state.set_bound_open_id("ou_owner")
        assert state.get_bound_open_id() == "ou_owner"
        assert store.data["im.feishu.bound_at"]
        state.set_bound_open_id("")
        assert state.get_bound_open_id() == ""
        assert store.data["im.feishu.bound_at"] == ""

    def test_reads_and_writes_are_fail_soft(self):
        """可观测性挂掉绝不能把长连接带崩。"""
        store = FakeStateStore()
        store.read_fail = True
        store.write_fail = True
        state = ImFeishuState(store)
        assert state.get(STATE_BOUND_OPEN_ID) is None
        state.set_status("whatever")  # 不抛
        assert state.get_bound_open_id() == ""

    def test_snapshot_never_exposes_the_pair_code(self):
        store = FakeStateStore(
            {"im.feishu.pair_code": "123456", STATE_BOUND_OPEN_ID: "ou_owner"}
        )
        snap = ImFeishuState(store).snapshot()
        assert "123456" not in str(snap)
        assert snap["bound_open_id"] == "ou_owner"
