"""sleep/wake/restart 后 socket 重连 + backlog flush（REVIEW-LOG H-17）.

设计：
- 全局两段优先级 queue (critical / notification), 总容量 ``PING_ISLAND_QUEUE_MAX``,
  满时优先淘汰 ``notification`` 头部 (普通 FYI 丢了无害); ``critical`` 头部
  仅在 notification 已空时才淘汰
- 主 loop 探测 socket:
  - 文件不存在 → ping-island 未跑，下次重试
  - 文件存在 → 发轻量 ping envelope；成功后 flush queue (先 critical 再 notification)
- 冷启动 fast probe (P0-3): 进程启动后 ``PING_ISLAND_RECONNECT_STARTUP_FAST_WINDOW_SECONDS``
  内 (默认 300s) 用 ``PING_ISLAND_RECONNECT_STARTUP_FAST_PROBE_SECONDS`` (默认 5s) 间隔
  探测；之后退到 ``PING_ISLAND_RECONNECT_PROBE_INTERVAL`` (默认 300s)
- 指数退避：5s / 30s / 2min / 10min（连续 probe 失败时延长间隔）
- envelope 入队前先 encode 成 bytes，避免持有 ``BridgeEnvelope`` 对象在内存里
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from typing import Deque, NamedTuple, Optional

from src.notify import ping_island
from src.notify.island_envelope import build_ping_envelope

log = logging.getLogger(__name__)

_DEFAULT_PROBE_INTERVAL = 300
_DEFAULT_QUEUE_MAX = 20
_DEFAULT_STARTUP_FAST_WINDOW_SECONDS = 300
_DEFAULT_STARTUP_FAST_PROBE_SECONDS = 5
BACKOFF_SCHEDULE = (5, 30, 120, 600)  # 秒；最后一档循环复用

# P0-3: status_kind → priority bucket. critical 不在 queue 满时被丢弃 (除非
# notification 已空); notification 是 FYI, 丢了也没事。
_CRITICAL_KINDS = frozenset({"completed", "error", "waitingForInput"})


# 进程启动时刻 (monotonic), 用于冷启动 fast probe 窗口判定。
_PROCESS_START_MONOTONIC: float = time.monotonic()


def _probe_interval() -> int:
    raw = os.environ.get("PING_ISLAND_RECONNECT_PROBE_INTERVAL",
                         str(_DEFAULT_PROBE_INTERVAL))
    try:
        val = int(raw)
        return max(val, 5)
    except ValueError:
        return _DEFAULT_PROBE_INTERVAL


def _startup_fast_window_seconds() -> int:
    raw = os.environ.get("PING_ISLAND_RECONNECT_STARTUP_FAST_WINDOW_SECONDS",
                         str(_DEFAULT_STARTUP_FAST_WINDOW_SECONDS))
    try:
        return max(int(raw), 0)
    except ValueError:
        return _DEFAULT_STARTUP_FAST_WINDOW_SECONDS


def _startup_fast_probe_seconds() -> int:
    raw = os.environ.get("PING_ISLAND_RECONNECT_STARTUP_FAST_PROBE_SECONDS",
                         str(_DEFAULT_STARTUP_FAST_PROBE_SECONDS))
    try:
        return max(int(raw), 1)
    except ValueError:
        return _DEFAULT_STARTUP_FAST_PROBE_SECONDS


def _queue_max() -> int:
    raw = os.environ.get("PING_ISLAND_QUEUE_MAX", str(_DEFAULT_QUEUE_MAX))
    try:
        return max(int(raw), 1)
    except ValueError:
        return _DEFAULT_QUEUE_MAX


class _Queued(NamedTuple):
    """入队条目：编码后 bytes + 契约 §9-3 re-check 所需的邮件坐标。

    ``internal_id`` / ``event_type`` 让 flush 前能反查邮件当前状态（现在只存 bytes
    无法反序列化）；``status_kind`` 供 bucket 归类 + re-check 区分终态 envelope。
    """

    data: bytes
    internal_id: Optional[int]
    event_type: str
    status_kind: str


# 两段 deque (无 maxlen — 总容量手工管理), 见 _enforce_capacity。
_critical: Deque[_Queued] = deque()
_notification: Deque[_Queued] = deque()


def _enforce_capacity() -> int:
    """当 total > cap 时, 优先丢 notification 头部; 全空后才丢 critical 头部。

    返回丢弃的条数。
    """
    cap = _queue_max()
    dropped = 0
    while len(_critical) + len(_notification) > cap:
        if _notification:
            _notification.popleft()
        else:
            _critical.popleft()
        dropped += 1
    return dropped


def enqueue(
    envelope_bytes: bytes,
    *,
    status_kind: str = "notification",
    internal_id: Optional[int] = None,
    event_type: str = "",
) -> None:
    """发送失败时由 caller 入队。

    ``status_kind`` 来自 envelope ``status.kind``: ``completed`` / ``error`` /
    ``waitingForInput`` → critical bucket (清 dock 信号 / 错误 / attention 类,
    queue 满时不被淘汰除非 notification 已空); 其他 (含默认 ``notification``)
    → notification bucket (queue 满时优先淘汰)。

    ``internal_id`` / ``event_type``（契约 §9-3）：flush 前 re-check 邮件状态用；
    未传时 re-check 直接放行（向后兼容 / 系统事件）。
    """
    if not envelope_bytes:
        return
    item = _Queued(
        data=envelope_bytes,
        internal_id=internal_id,
        event_type=event_type,
        status_kind=status_kind,
    )
    if status_kind in _CRITICAL_KINDS:
        _critical.append(item)
    else:
        _notification.append(item)
    dropped = _enforce_capacity()
    if dropped:
        log.debug(
            "[island] reconnect queue at cap, dropped %d notification(s); "
            "critical=%d notification=%d",
            dropped, len(_critical), len(_notification),
        )


def queue_len() -> int:
    return len(_critical) + len(_notification)


def queue_len_critical() -> int:
    return len(_critical)


def queue_len_notification() -> int:
    return len(_notification)


def clear_queue() -> None:
    """单测用."""
    _critical.clear()
    _notification.clear()


def _peek_next() -> Optional[_Queued]:
    """先 critical 后 notification (FIFO within each tier)。"""
    if _critical:
        return _critical[0]
    if _notification:
        return _notification[0]
    return None


def _pop_next() -> None:
    if _critical:
        _critical.popleft()
    elif _notification:
        _notification.popleft()


def _should_skip_stale(item: _Queued) -> bool:
    """契约 §9-3: 重发前 re-check —— 邮件在 outage 期间已被处理 → 丢弃过期通知。

    仅对**有 internal_id 的非终态** envelope 检查（``completed`` / ``error`` 是
    MailCompleted / ActionAcked 等终态信号，必须照常 flush）；邮件已被删除或
    ``processing_status='已完成'`` → 返回 True（丢弃，不再弹已处理邮件的旧待办）。

    任何异常 / 无 sync_store → False（fail-open：不因 re-check bug 丢通知）。
    """
    if item.internal_id is None:
        return False
    if item.status_kind in ("completed", "error"):
        return False  # 终态 envelope always flush
    # lazy import 避 island_dispatch ↔ island_reconnect 循环依赖
    from src.notify import island_dispatch

    store = island_dispatch._state.sync_store
    if store is None:
        return False
    try:
        email = store.get(item.internal_id)
    except Exception as e:  # noqa: BLE001
        log.debug("[island] reconnect re-check failed (fail-open): %s", e)
        return False
    if email is None:
        return True  # 邮件已删除 → 过期通知
    if (email.get("processing_status") or "") == "已完成":
        return True  # 已完成 → 过期通知
    return False


async def _flush_queue() -> int:
    """逐条 flush；任一发送失败立即停止后续 flush，整个 batch 留待下次重试。

    顺序: critical 先 (按入队顺序), 全清后再 notification。
    契约 §9-3: 每条 flush 前 re-check, 邮件已处理的过期通知直接丢弃 (不计入 flushed)。
    """
    flushed = 0
    while True:
        item = _peek_next()
        if item is None:
            break
        if _should_skip_stale(item):
            log.info(
                "[island] reconnect: drop stale envelope internal_id=%s event=%s "
                "(email done/deleted during outage)",
                item.internal_id, item.event_type,
            )
            _pop_next()
            continue
        result = await asyncio.get_running_loop().run_in_executor(
            None, ping_island.send_sync, item.data
        )
        if not result.ok:
            log.debug("[island] flush stalled (still failing): %s", result.error)
            break
        _pop_next()
        flushed += 1
    return flushed


def _select_base_interval() -> int:
    """P0-3: 启动后 fast_window 秒内用 fast_probe 间隔, 之后退到默认 probe interval。

    用 ``time.monotonic()`` 算 startup elapsed; window=0 时 fast probe 立即停用。
    """
    window = _startup_fast_window_seconds()
    if window <= 0:
        return _probe_interval()
    elapsed = time.monotonic() - _PROCESS_START_MONOTONIC
    if elapsed < window:
        return _startup_fast_probe_seconds()
    return _probe_interval()


async def reconnect_loop(*, shutdown_event: Optional[asyncio.Event] = None) -> None:
    """主任务：动态 base_interval (冷启动短 / 之后长), 必要时 flush queue + exponential backoff.

    完全不抛异常 —— 任何 inner 错误只 log.warning 然后继续。
    """
    backoff_idx = 0

    def stop_requested() -> bool:
        return shutdown_event is not None and shutdown_event.is_set()

    while not stop_requested():
        try:
            # P0-3: 每轮重算 base_interval, 冷启动 fast window 一过自动退化到默认
            base_interval = _select_base_interval()

            if not ping_island.is_socket_present():
                log.debug("[island] socket missing, sleeping %ds", base_interval)
                await _sleep_with_shutdown(base_interval, shutdown_event)
                continue

            # 探测发 ping envelope；fail-open
            ping_env = build_ping_envelope()
            probe = await ping_island.send_async(ping_env)

            if probe.ok:
                if queue_len() > 0:
                    flushed = await _flush_queue()
                    if flushed:
                        log.info(
                            "[island] reconnected, flushed %d/%d backlog envelopes "
                            "(critical=%d notification=%d remaining)",
                            flushed, flushed + queue_len(),
                            queue_len_critical(), queue_len_notification(),
                        )
                backoff_idx = 0
                await _sleep_with_shutdown(base_interval, shutdown_event)
            else:
                wait = BACKOFF_SCHEDULE[min(backoff_idx, len(BACKOFF_SCHEDULE) - 1)]
                backoff_idx += 1
                log.debug(
                    "[island] probe failed (%s); backoff %ds (idx=%d)",
                    probe.error, wait, backoff_idx,
                )
                await _sleep_with_shutdown(wait, shutdown_event)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("[island] reconnect loop error: %s", e)
            await _sleep_with_shutdown(_select_base_interval(), shutdown_event)


async def _sleep_with_shutdown(seconds: float,
                               shutdown_event: Optional[asyncio.Event]) -> None:
    if shutdown_event is None:
        await asyncio.sleep(seconds)
        return
    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Test helpers (单测可 monkeypatch _PROCESS_START_MONOTONIC 模拟启动窗口已过)
# ─────────────────────────────────────────────────────────────────────────────


def reset_startup_window_for_tests() -> None:
    """单测用: 把启动时间设到当前 monotonic, 等价于"刚启动"。"""
    global _PROCESS_START_MONOTONIC
    _PROCESS_START_MONOTONIC = time.monotonic()


def set_startup_window_origin_for_tests(monotonic_value: float) -> None:
    """单测用: 直接设进程启动时间 (可设过去时刻模拟 window 已过)。"""
    global _PROCESS_START_MONOTONIC
    _PROCESS_START_MONOTONIC = monotonic_value
