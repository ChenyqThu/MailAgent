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

告警有**两个出口**且互不依赖 (task 08-20-notification-center M2-B2): 飞书
``alerter`` (需 ALERT_ENABLED + webhook, 默认安装是 None) 与 ``notify_center``
(通知中心, 恒在场)。🔴 默认安装下 worker crash-loop 此前**完全不可见** ——
20 个顶层 worker 共用本模块, 停摆意味着整个功能面静默死掉。两个出口都可为
None (老调用方 / 单测 = 行为零变化)。

crash 条目的**恢复信号** = (重) 启动后连续存活满 ``healthy_after_sec`` (每轮
一个独立计时 task, 见 ``_resolve_crash_when_healthy``) → 条目转 resolved, 通知
面不留自愈完的脏条目; crashloop 条目的恢复信号是服务重启 (挂
``service._spawn_supervised``, 因为 crash-loop 后本函数直接 return 不再跑)。

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
import contextlib
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
    notify_center=None,
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
        notify_center: ``NotifyCenter`` (可 None = 不写通知中心)。与 alerter 并列
            的第二个出口, 落库失败绝不影响重启流程。
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

    async def _safe_notify(
        sub: str, *, title: str, body: str, severity: str
    ) -> None:
        """worker 死亡 → 通知中心 (task 08-20-notification-center)。

        与 ``_safe_alert`` 并列的第二个出口, 两者互不 gate: 默认安装没有飞书,
        这里就是 crash-loop 唯一能被看见的地方。落库失败只 warning ——
        通知路径绝不影响重启逻辑。
        """
        if notify_center is None:
            return
        try:
            await asyncio.to_thread(
                notify_center.publish,
                category="system",
                source="worker",
                title=title,
                body=body,
                severity=severity,
                # 同一 worker 连崩计次 (不刷屏); crash 与 crashloop 是两条独立
                # 条目 —— 前者「挂了但会自愈」, 后者「已放弃, 需人工」。
                dedupe_key=f"alert:worker_{sub}:{name}",
                payload={"link": {"type": "route", "to": "/admin/kanban"}},
            )
        except Exception as e:  # noqa: BLE001 — 通知落库失败绝不影响重启流程
            logger.warning(f"[supervise:{name}] notify {sub} failed: {e}")

    async def _resolve_crash_when_healthy() -> None:
        """连续存活 ≥ healthy_after_sec → 收掉这个 worker 的 crash 条目。

        🔴 挂点只能在这里 (每轮启动后的独立计时), **不能**挂下方「crash 计数
        重置」那处 (alive >= healthy_after_sec 分支): 执行到那里意味着 worker
        刚又死了一次, 那一刻收条目等于把活跃故障标成已解决。
        crash-loop 条目不在此收 —— 那条的语义是「已放弃重启」, 恢复信号是服务
        重启 (挂点在 service._spawn_supervised)。
        """
        await asyncio.sleep(healthy_after_sec)
        try:
            await asyncio.to_thread(
                notify_center.resolve_by_dedupe, f"alert:worker_crash:{name}"
            )
        except Exception as e:  # noqa: BLE001 — 同 _safe_notify: 通知路径不影响本体
            logger.warning(f"[supervise:{name}] notify resolve crash failed: {e}")

    async def _stop_health_timer(timer: "Optional[asyncio.Task]") -> None:
        """三条退出路径 (worker 返回 / 抛异常 / supervise 自身被 cancel) 共用的
        清理: cancel 后**等它真的结束**, 否则 loop 立刻关闭会留下
        "Task was destroyed but it is pending" 噪音。"""
        if timer is None or timer.done():
            return
        timer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await timer

    while True:
        _write("status", "running")
        _write("last_started_at", _utcnow_iso())
        _write("restart_count", restart_count)
        started = time.monotonic()
        error: Optional[BaseException] = None
        health_timer = (
            asyncio.create_task(_resolve_crash_when_healthy())
            if notify_center is not None
            else None
        )
        try:
            await coro_factory()
        except asyncio.CancelledError:
            # 服务 shutdown 的 task.cancel() 路径 — 干净放行。
            _write("status", "stopped")
            raise
        except Exception as e:  # noqa: BLE001 — supervise 的全部意义就是接住一切
            error = e
        finally:
            # 本轮已结束 (含 shutdown 早退与 CancelledError 传播) → 计时不再作数。
            await _stop_health_timer(health_timer)

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
            await _safe_notify(
                "crash",
                title=f"一次性任务 {name} 执行失败",
                body=f"任务不会自动重试, 需人工处理。错误: {reason}",
                severity="warn",
            )
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
            await _safe_notify(
                "crashloop",
                title=f"后台 worker {name} 已停止重启",
                body=(
                    f"连续 {crash_count} 次快速崩溃, 已放弃重启 —— 该功能面将"
                    f"停摆到服务重启为止。最近错误: {reason}"
                ),
                severity="critical",
            )
            return

        delay = float(backoff[min(crash_count - 1, len(backoff) - 1)])
        _write("status", "crashed")
        await _safe_alert("alert_worker_crashed", name, reason, crash_count)
        await _safe_notify(
            "crash",
            title=f"后台 worker {name} 异常退出",
            body=(
                f"第 {crash_count} 次崩溃 (上限 {max_crashloop}), "
                f"{delay:.0f}s 后自动重启。最近错误: {reason}"
            ),
            severity="warn",
        )
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
