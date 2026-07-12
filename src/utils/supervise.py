"""通用 worker 监督包装器 (E4 WP1).

src/service.py 的顶层 worker task 此前是裸 ``asyncio.create_task`` —— worker
协程在 tick 外抛未捕获异常 (或在 shutdown 未置位时静默返回, 如 NewWatcher
consecutive_errors>=5 的自我放弃路径) 会让 task 悄悄死掉、功能停摆, 但进程
不退, PM2/BackendLifecycle 均不会重启 (它们只看进程级存活)。

``supervise()`` 把 worker 协程包一层:

- **异常退出** 或 **shutdown 未置位时的正常返回** → logger.error 全栈 +
  (注入 alerter 时) 飞书告警 + 按 backoff 指数退避重启;
- 存活 ≥ ``healthy_after_sec`` (默认 300s) 后再挂 → 视为新一轮独立故障,
  crash 计数重置 (不算 crash-loop);
- 连续 ``max_crashloop`` 次快速挂 → critical 告警一次 + 状态置
  ``crashloop_stopped``, 停止重启 (不拖垮进程, 其余 worker 不受影响);
- shutdown_event 置位后的正常返回 / ``CancelledError`` → 干净退出;
- ``one_shot=True`` (如 uid_backfill): 只观测不重启 —— 正常返回记
  ``completed``, 异常记 ``failed`` + 告警一次。

心跳/状态经注入的 ``state_writer`` 在**状态跃迁时**写
``worker.<name>.{status,last_started_at,restart_count,last_error}`` 键
(落 sync_state → 跨进程可见, ``mailagent admin health`` / ``/api/admin/health``
双面直读), 不做逐 tick 心跳。

命名注: 仓库里 "watchdog" 已被两种语义占用 (davmail_watchdog = 巡检+告警
循环; parent_watchdog = 父进程存活探测), 本模块统一叫 supervise 避免第三种
语义混入。
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, Sequence

from loguru import logger

# 默认退避表 — 与 island_reconnect.BACKOFF_SCHEDULE 同量级 (仓库唯一既有先例)。
DEFAULT_BACKOFF: tuple[float, ...] = (5.0, 30.0, 120.0, 600.0)

# worker 存活 ≥ 该秒数后再挂 → 视为新一轮独立故障, crash 计数重置。
HEALTHY_AFTER_SEC = 300.0

# last_error 写 sync_state 时的截断长度 (状态表不是日志, 全栈在 loguru 里)。
_LAST_ERROR_MAX_LEN = 500


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def supervise(
    coro_factory: Callable[[], Awaitable[object]],
    name: str,
    *,
    shutdown_event: asyncio.Event,
    backoff: Sequence[float] = DEFAULT_BACKOFF,
    max_crashloop: int = 5,
    alerter=None,
    state_writer: Optional[Callable[[str, str], object]] = None,
    one_shot: bool = False,
    healthy_after_sec: float = HEALTHY_AFTER_SEC,
) -> None:
    """监督一个 worker 协程: 挂了重启, crash-loop 停摆, 状态跃迁落 state_writer.

    Args:
        coro_factory: 零参 callable, 每次 (重) 启动时调用产生一个新的 worker
            协程。**重启可重入性由调用方保证** (实例状态位如 ``_running``
            残留会让重启变 no-op, 需在 factory 里复位)。
        name: 稳定 snake 名, 用作 sync_state 键前缀 ``worker.<name>.``。
        shutdown_event: 置位后 worker 的正常返回视为干净退出, 不再重启。
        backoff: 指数退避表 (秒); 第 N 次连续 crash 用 ``backoff[min(N-1, len-1)]``。
        max_crashloop: 连续快速 crash 达该次数 → critical 告警一次 +
            ``crashloop_stopped`` 终态, 停止重启。
        alerter: FeishuAlertNotifier (可 None = 降级纯日志)。
        state_writer: ``(key, value) -> Any``, 通常是 sync_store.set_state;
            写失败绝不影响 worker 本体。
        one_shot: True = 只跑一次 (uid_backfill 类), 异常只记日志 + 告警 +
            终态, 不重启。
        healthy_after_sec: 存活超过该秒数视为健康, 重置 crash 计数。
    """
    crash_count = 0
    restart_count = 0

    def _write(field: str, value: object) -> None:
        if state_writer is None:
            return
        try:
            state_writer(f"worker.{name}.{field}", str(value))
        except Exception as e:  # noqa: BLE001 — 心跳写失败绝不影响 worker 本体
            logger.debug(f"[supervise:{name}] state write failed ({field}): {e}")

    async def _safe_alert(method_name: str, *args) -> None:
        if alerter is None:
            return
        try:
            await getattr(alerter, method_name)(*args)
        except Exception as e:  # noqa: BLE001 — 告警失败绝不影响重启流程
            logger.warning(f"[supervise:{name}] alert {method_name} failed: {e}")

    while True:
        _write("status", "running")
        _write("last_started_at", _utcnow_iso())
        _write("restart_count", restart_count)
        started = time.monotonic()
        error: Optional[BaseException] = None
        try:
            await coro_factory()
        except asyncio.CancelledError:
            # 服务 shutdown 的 task.cancel() 路径 — 干净放行。
            _write("status", "stopped")
            raise
        except Exception as e:  # noqa: BLE001 — supervise 的全部意义就是接住一切
            error = e

        if error is None and one_shot:
            # one-shot 正常跑完 (不论 shutdown 与否) = 任务完成, 非死亡。
            _write("status", "completed")
            logger.info(f"[supervise:{name}] one-shot task completed")
            return

        if shutdown_event.is_set():
            # shutdown 置位后的返回 (含 teardown 期异常) = 干净退出, 不重启。
            if error is not None:
                logger.warning(
                    f"[supervise:{name}] exception during shutdown (not restarting): {error!r}"
                )
                _write("last_error", repr(error)[:_LAST_ERROR_MAX_LEN])
            _write("status", "stopped")
            return

        # ── 到这里 = 非预期死亡: 异常退出, 或 shutdown 未置位时的正常返回 ──
        if error is not None:
            reason = repr(error)
            logger.opt(exception=error).error(
                f"[supervise:{name}] worker crashed: {error!r}"
            )
        else:
            reason = "returned unexpectedly (shutdown not set)"
            logger.error(
                f"[supervise:{name}] worker returned while shutdown not set — "
                "treating as death (e.g. self-giving-up loop)"
            )
        _write("last_error", reason[:_LAST_ERROR_MAX_LEN])

        if one_shot:
            # one-shot 异常: 只观测不重启 (重启对一次性任务没有意义)。
            _write("status", "failed")
            await _safe_alert("alert_worker_crashed", name, reason, 1)
            return

        alive = time.monotonic() - started
        if alive >= healthy_after_sec:
            crash_count = 1  # 存活够久 → 新一轮独立故障, 重置计数
        else:
            crash_count += 1

        if crash_count >= max_crashloop:
            _write("status", "crashloop_stopped")
            logger.critical(
                f"[supervise:{name}] crash-loop: {crash_count} consecutive fast "
                f"crashes — stopping restarts (worker down until service restart)"
            )
            await _safe_alert("alert_worker_crashloop_stopped", name, crash_count)
            return

        delay = float(backoff[min(crash_count - 1, len(backoff) - 1)])
        _write("status", "crashed")
        await _safe_alert("alert_worker_crashed", name, reason, crash_count)
        logger.warning(
            f"[supervise:{name}] restarting in {delay:.0f}s "
            f"(crash #{crash_count}/{max_crashloop})"
        )
        restart_count += 1
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=delay)
            _write("status", "stopped")
            return  # backoff 等待期间 shutdown → 干净退出
        except asyncio.TimeoutError:
            pass  # 正常退避结束 → 重启
