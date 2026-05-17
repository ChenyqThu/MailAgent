"""sleep/wake/restart 后 socket 重连 + backlog flush（REVIEW-LOG H-17）.

设计：
- 全局 deque 存"发送失败 envelope"，maxlen=20 防 OOM
- 主 loop 每 ``PING_ISLAND_RECONNECT_PROBE_INTERVAL`` 秒（默认 300s）探测 socket：
  - 文件不存在 → ping-island 未跑，下次重试
  - 文件存在 → 发轻量 ping envelope；成功后 flush queue
- 指数退避：5s / 30s / 2min / 10min（连续 probe 失败时延长间隔）
- envelope 入队前先 encode 成 bytes，避免持有 ``BridgeEnvelope`` 对象在内存里
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from typing import Deque, Optional

from src.notify import ping_island
from src.notify.island_envelope import build_ping_envelope

log = logging.getLogger(__name__)

_DEFAULT_PROBE_INTERVAL = 300
_DEFAULT_QUEUE_MAX = 20
BACKOFF_SCHEDULE = (5, 30, 120, 600)  # 秒；最后一档循环复用


def _probe_interval() -> int:
    raw = os.environ.get("PING_ISLAND_RECONNECT_PROBE_INTERVAL",
                         str(_DEFAULT_PROBE_INTERVAL))
    try:
        val = int(raw)
        return max(val, 5)
    except ValueError:
        return _DEFAULT_PROBE_INTERVAL


def _queue_max() -> int:
    raw = os.environ.get("PING_ISLAND_QUEUE_MAX", str(_DEFAULT_QUEUE_MAX))
    try:
        return max(int(raw), 1)
    except ValueError:
        return _DEFAULT_QUEUE_MAX


_queue: Deque[bytes] = deque(maxlen=_queue_max())


def enqueue(envelope_bytes: bytes) -> None:
    """发送失败时由 caller 入队（``deque(maxlen=N)`` 自动丢老的）."""
    if not envelope_bytes:
        return
    _queue.append(envelope_bytes)


def queue_len() -> int:
    return len(_queue)


def clear_queue() -> None:
    """单测用."""
    _queue.clear()


async def _flush_queue() -> int:
    """逐条 flush；任一发送失败立即停止后续 flush，整个 batch 留待下次重试."""
    flushed = 0
    while _queue:
        envelope_bytes = _queue[0]
        result = await asyncio.get_running_loop().run_in_executor(
            None, ping_island.send_sync, envelope_bytes
        )
        if not result.ok:
            log.debug("[island] flush stalled (still failing): %s", result.error)
            break
        _queue.popleft()
        flushed += 1
    return flushed


async def reconnect_loop(*, shutdown_event: Optional[asyncio.Event] = None) -> None:
    """主任务：每 probe_interval 秒检查 socket，必要时 flush queue 与做 exponential backoff.

    完全不抛异常 —— 任何 inner 错误只 log.warning 然后继续。
    """
    base_interval = _probe_interval()
    backoff_idx = 0

    def stop_requested() -> bool:
        return shutdown_event is not None and shutdown_event.is_set()

    while not stop_requested():
        try:
            if not ping_island.is_socket_present():
                log.debug("[island] socket missing, sleeping %ds", base_interval)
                await _sleep_with_shutdown(base_interval, shutdown_event)
                continue

            # 探测发 ping envelope；fail-open
            ping_env = build_ping_envelope()
            probe = await ping_island.send_async(ping_env)

            if probe.ok:
                if _queue:
                    flushed = await _flush_queue()
                    if flushed:
                        log.info(
                            "[island] reconnected, flushed %d/%d backlog envelopes",
                            flushed, flushed + len(_queue),
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
            await _sleep_with_shutdown(base_interval, shutdown_event)


async def _sleep_with_shutdown(seconds: float,
                               shutdown_event: Optional[asyncio.Event]) -> None:
    if shutdown_event is None:
        await asyncio.sleep(seconds)
        return
    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
