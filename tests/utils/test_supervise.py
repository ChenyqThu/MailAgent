"""E4 WP1 — src/utils/supervise.py 单测.

覆盖 D1 语义全集:
  - 异常退出 → 自动重启 (状态跃迁 running→crashed→running 可见)
  - shutdown 未置位时的正常返回 → 同样视为死亡并重启
    (NewWatcher consecutive_errors>=5 自我放弃路径的等价场景)
  - 存活 >= healthy_after_sec → crash 计数重置 (永不进 crash-loop)
  - 连续 max_crashloop 次快速挂 → crashloop_stopped 终态 + critical 告警一次,
    不再重启
  - one_shot=True: 正常返回 completed / 异常 failed + 告警, 均不重启
  - CancelledError 干净放行 (shutdown 的 task.cancel() 路径)
  - shutdown 置位后的正常返回 → 干净退出不重启
  - state_writer / alerter 自身抛异常不影响 supervise 本体
  - 单 worker 死不影响同 loop 其他 worker (隔离性)
"""
from __future__ import annotations

import asyncio

import pytest

from src.utils.supervise import supervise


class _StateRecorder:
    """记录 state_writer 的全部 (key, value) 写入."""

    def __init__(self):
        self.writes: list[tuple[str, str]] = []

    def __call__(self, key: str, value: str):
        self.writes.append((key, value))
        return True

    def values_for(self, suffix: str) -> list[str]:
        return [v for k, v in self.writes if k.endswith(suffix)]


class _RecordingAlerter:
    """记录 alert_worker_crashed / alert_worker_crashloop_stopped 调用."""

    def __init__(self):
        self.crashed: list[tuple] = []
        self.crashloop: list[tuple] = []

    async def alert_worker_crashed(self, name, error, crash_count=1):
        self.crashed.append((name, error, crash_count))

    async def alert_worker_crashloop_stopped(self, name, crash_count):
        self.crashloop.append((name, crash_count))


async def test_exception_restarts_worker():
    """worker 抛异常 → supervise 自动重启, 状态跃迁 sync_state 可见."""
    shutdown = asyncio.Event()
    state = _StateRecorder()
    calls = {"n": 0}

    async def worker():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        await shutdown.wait()

    task = asyncio.create_task(
        supervise(
            worker, "w1",
            shutdown_event=shutdown,
            backoff=(0.01,),
            state_writer=state,
        )
    )
    # 等第二次启动 (重启后 worker 挂在 shutdown.wait 上)
    for _ in range(100):
        if calls["n"] >= 2:
            break
        await asyncio.sleep(0.01)
    assert calls["n"] == 2, "worker 应在异常后被重启一次"

    shutdown.set()
    await asyncio.wait_for(task, timeout=2)

    statuses = state.values_for(".status")
    assert "crashed" in statuses
    assert statuses[-1] == "stopped"
    assert "RuntimeError" in state.values_for(".last_error")[0]
    # restart_count 第二轮启动时应为 1
    assert state.values_for(".restart_count") == ["0", "1"]


async def test_unexpected_return_restarts_worker():
    """shutdown 未置位时的正常返回也视为死亡 → 重启 (自我放弃路径覆盖)."""
    shutdown = asyncio.Event()
    state = _StateRecorder()
    calls = {"n": 0}

    async def worker():
        calls["n"] += 1
        if calls["n"] == 1:
            return  # 静默自我放弃 (如 NewWatcher consecutive_errors>=5)
        await shutdown.wait()

    task = asyncio.create_task(
        supervise(
            worker, "w2",
            shutdown_event=shutdown,
            backoff=(0.01,),
            state_writer=state,
        )
    )
    for _ in range(100):
        if calls["n"] >= 2:
            break
        await asyncio.sleep(0.01)
    assert calls["n"] == 2

    shutdown.set()
    await asyncio.wait_for(task, timeout=2)
    assert any(
        "returned unexpectedly" in v for v in state.values_for(".last_error")
    )


async def test_alive_long_enough_resets_crash_count():
    """存活 >= healthy_after_sec 的挂 → crash 计数重置, 多次也不进 crash-loop."""
    shutdown = asyncio.Event()
    alerter = _RecordingAlerter()
    calls = {"n": 0}

    async def worker():
        calls["n"] += 1
        if calls["n"] <= 6:
            raise RuntimeError(f"crash-{calls['n']}")
        await shutdown.wait()

    task = asyncio.create_task(
        supervise(
            worker, "w3",
            shutdown_event=shutdown,
            backoff=(0.0,),
            max_crashloop=3,
            alerter=alerter,
            healthy_after_sec=0.0,  # 任何存活时长都算健康 → 计数恒重置为 1
        )
    )
    for _ in range(200):
        if calls["n"] >= 7:
            break
        await asyncio.sleep(0.01)
    assert calls["n"] == 7, "6 次挂 (>max_crashloop=3) 都应被重启, 计数被重置"
    assert alerter.crashloop == [], "健康重置下永不触发 crash-loop 停摆"
    # 每次 crash 的 crash_count 都应是 1 (重置生效)
    assert all(c[2] == 1 for c in alerter.crashed)

    shutdown.set()
    await asyncio.wait_for(task, timeout=2)


async def test_crashloop_stops_and_alerts_once():
    """连续 max_crashloop 次快速挂 → crashloop_stopped 终态 + critical 告警一次."""
    shutdown = asyncio.Event()
    state = _StateRecorder()
    alerter = _RecordingAlerter()
    calls = {"n": 0}

    async def worker():
        calls["n"] += 1
        raise RuntimeError("always dead")

    await asyncio.wait_for(
        supervise(
            worker, "w4",
            shutdown_event=shutdown,
            backoff=(0.0,),
            max_crashloop=3,
            alerter=alerter,
            state_writer=state,
        ),
        timeout=2,
    )
    assert calls["n"] == 3, "第 3 次挂后停止重启 (factory 不再被调)"
    assert state.values_for(".status")[-1] == "crashloop_stopped"
    assert alerter.crashloop == [("w4", 3)]
    # 前两次挂发普通 crashed 告警, 第三次直接 crashloop 告警
    assert len(alerter.crashed) == 2


async def test_one_shot_success_and_failure_never_restart():
    """one_shot: 正常返回 completed / 异常 failed + 告警, 都只跑一次."""
    shutdown = asyncio.Event()

    # 成功路径
    state_ok = _StateRecorder()
    alerter_ok = _RecordingAlerter()
    ok_calls = {"n": 0}

    async def ok_worker():
        ok_calls["n"] += 1

    await asyncio.wait_for(
        supervise(
            ok_worker, "os1",
            shutdown_event=shutdown,
            one_shot=True,
            alerter=alerter_ok,
            state_writer=state_ok,
        ),
        timeout=2,
    )
    assert ok_calls["n"] == 1
    assert state_ok.values_for(".status")[-1] == "completed"
    assert alerter_ok.crashed == []

    # 失败路径
    state_fail = _StateRecorder()
    alerter_fail = _RecordingAlerter()
    fail_calls = {"n": 0}

    async def fail_worker():
        fail_calls["n"] += 1
        raise ValueError("backfill exploded")

    await asyncio.wait_for(
        supervise(
            fail_worker, "os2",
            shutdown_event=shutdown,
            one_shot=True,
            alerter=alerter_fail,
            state_writer=state_fail,
        ),
        timeout=2,
    )
    assert fail_calls["n"] == 1, "one-shot 异常不重启"
    assert state_fail.values_for(".status")[-1] == "failed"
    assert len(alerter_fail.crashed) == 1
    assert "ValueError" in state_fail.values_for(".last_error")[0]


async def test_cancelled_error_propagates_cleanly():
    """task.cancel() (服务 shutdown 路径) → CancelledError 放行, 状态 stopped."""
    shutdown = asyncio.Event()
    state = _StateRecorder()

    async def worker():
        await asyncio.sleep(3600)

    task = asyncio.create_task(
        supervise(worker, "w5", shutdown_event=shutdown, state_writer=state)
    )
    await asyncio.sleep(0.05)  # 让 worker 真正挂起
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert state.values_for(".status")[-1] == "stopped"


async def test_clean_exit_when_shutdown_set():
    """shutdown 置位后的正常返回 = 干净退出, 不重启不告警."""
    shutdown = asyncio.Event()
    alerter = _RecordingAlerter()
    calls = {"n": 0}

    async def worker():
        calls["n"] += 1
        await shutdown.wait()

    task = asyncio.create_task(
        supervise(worker, "w6", shutdown_event=shutdown, alerter=alerter)
    )
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.wait_for(task, timeout=2)
    assert calls["n"] == 1
    assert alerter.crashed == []


async def test_state_writer_and_alerter_failures_do_not_kill_supervise():
    """state_writer / alerter 自己抛异常 → supervise 照常重启 worker."""
    shutdown = asyncio.Event()
    calls = {"n": 0}

    def bad_writer(key, value):
        raise sqlite_error_stub()

    class _BadAlerter:
        async def alert_worker_crashed(self, *args):
            raise RuntimeError("feishu down")

        async def alert_worker_crashloop_stopped(self, *args):
            raise RuntimeError("feishu down")

    def sqlite_error_stub():
        return RuntimeError("db locked")

    async def worker():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        await shutdown.wait()

    task = asyncio.create_task(
        supervise(
            worker, "w7",
            shutdown_event=shutdown,
            backoff=(0.01,),
            alerter=_BadAlerter(),
            state_writer=bad_writer,
        )
    )
    for _ in range(100):
        if calls["n"] >= 2:
            break
        await asyncio.sleep(0.01)
    assert calls["n"] == 2, "旁路故障不得阻断重启"
    shutdown.set()
    await asyncio.wait_for(task, timeout=2)


async def test_one_worker_death_does_not_affect_others():
    """隔离性: 同 loop 两个 supervise, 一个 crash-loop 停摆, 另一个照常 tick."""
    shutdown = asyncio.Event()
    ticks = {"n": 0}

    async def dead_worker():
        raise RuntimeError("always dead")

    async def healthy_worker():
        while not shutdown.is_set():
            ticks["n"] += 1
            await asyncio.sleep(0.01)

    dead_task = asyncio.create_task(
        supervise(
            dead_worker, "dead",
            shutdown_event=shutdown,
            backoff=(0.0,),
            max_crashloop=3,
        )
    )
    healthy_task = asyncio.create_task(
        supervise(healthy_worker, "healthy", shutdown_event=shutdown)
    )
    await asyncio.wait_for(dead_task, timeout=2)  # dead worker 已停摆
    before = ticks["n"]
    await asyncio.sleep(0.1)
    assert ticks["n"] > before, "healthy worker 在 dead worker 停摆后仍在 tick"

    shutdown.set()
    await asyncio.wait_for(healthy_task, timeout=2)
