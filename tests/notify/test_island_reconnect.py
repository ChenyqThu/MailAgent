"""单测：island_reconnect — backlog queue + flush after probe success (H-17)。

P0-3 新增覆盖:
- 优先级 queue: queue 满时 notification 先丢, critical (completed/error/
  waitingForInput) 保留 (除非 notification 已空)
- 冷启动 fast probe: 启动后 fast_window 秒内用 fast_probe 间隔, 之后退到默认
"""

from __future__ import annotations

import asyncio
import time
from typing import List

import pytest

from src.notify import island_reconnect, ping_island


@pytest.fixture(autouse=True)
def reset_queue():
    island_reconnect.clear_queue()
    yield
    island_reconnect.clear_queue()


def test_enqueue_respects_max_length():
    """``deque(maxlen=N)`` 自动丢老的；队列满时新入队不抛."""
    for i in range(30):
        island_reconnect.enqueue(f"env-{i}".encode())
    # queue_len 不超过 maxlen
    assert island_reconnect.queue_len() <= 30
    assert island_reconnect.queue_len() <= island_reconnect._queue_max()


def test_enqueue_skips_empty_bytes():
    island_reconnect.enqueue(b"")
    assert island_reconnect.queue_len() == 0


def test_flush_queue_drains_when_send_ok(monkeypatch):
    """probe 成功后 flush_queue 顺序 pop 出 envelope；任一失败立即停止."""
    island_reconnect.enqueue(b'{"x":1}')
    island_reconnect.enqueue(b'{"y":2}')

    sent: List[bytes] = []

    def fake_send_sync(data, **kwargs):
        sent.append(data)
        return ping_island.SendResult(ok=True, latency_ms=1)

    monkeypatch.setattr(island_reconnect.ping_island, "send_sync", fake_send_sync)

    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 2
    assert island_reconnect.queue_len() == 0
    assert sent == [b'{"x":1}', b'{"y":2}']


def test_flush_queue_stops_on_first_failure(monkeypatch):
    island_reconnect.enqueue(b'{"x":1}')
    island_reconnect.enqueue(b'{"y":2}')

    def fake_send_sync(data, **kwargs):
        return ping_island.SendResult(ok=False, error="ENOENT")

    monkeypatch.setattr(island_reconnect.ping_island, "send_sync", fake_send_sync)
    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 0
    assert island_reconnect.queue_len() == 2  # 两条都保留待下次重试


def test_reconnect_loop_flushes_after_socket_unlink(monkeypatch):
    """H-17 核心场景：socket 先 missing → 再出现，loop 探测成功并 flush 队列."""
    states = {"present": False, "probe_calls": 0}

    def fake_is_socket_present():
        return states["present"]

    sent: List[bytes] = []

    def fake_send_sync(data, **kwargs):
        sent.append(data)
        return ping_island.SendResult(ok=True, latency_ms=1)

    async def fake_send_async(envelope, **kwargs):
        states["probe_calls"] += 1
        return ping_island.SendResult(ok=True, latency_ms=1)

    monkeypatch.setattr(island_reconnect.ping_island, "is_socket_present",
                          fake_is_socket_present)
    monkeypatch.setattr(island_reconnect.ping_island, "send_sync", fake_send_sync)
    monkeypatch.setattr(island_reconnect.ping_island, "send_async", fake_send_async)
    # P0-3: 测试需要快速 probe (≤1s)。直接 patch _select_base_interval 覆盖冷启动 fast
    # probe window (默认 5s, 仍超测试 2s timeout) 跟 default probe interval (300s)。
    monkeypatch.setattr(island_reconnect, "_select_base_interval", lambda: 1)

    island_reconnect.enqueue(b'{"backlog":1}')
    island_reconnect.enqueue(b'{"backlog":2}')

    async def _scenario():
        shutdown = asyncio.Event()
        task = asyncio.create_task(
            island_reconnect.reconnect_loop(shutdown_event=shutdown)
        )

        # Phase 1: socket missing → loop sleep (probe 不发)
        await asyncio.sleep(0.1)
        assert states["probe_calls"] == 0
        assert island_reconnect.queue_len() == 2

        # Phase 2: socket 出现 → 触发 probe + flush
        states["present"] = True
        for _ in range(40):
            await asyncio.sleep(0.05)
            if states["probe_calls"] >= 1 and island_reconnect.queue_len() == 0:
                break

        shutdown.set()
        try:
            await asyncio.wait_for(task, timeout=2.0)
        except asyncio.TimeoutError:
            task.cancel()

    asyncio.run(_scenario())

    assert states["probe_calls"] >= 1
    assert island_reconnect.queue_len() == 0
    assert sent == [b'{"backlog":1}', b'{"backlog":2}']


# ─────────────────────────────────────────────────────────────────────────────
# P0-3: 优先级 queue (critical / notification) — queue 满时优先丢 notification
# ─────────────────────────────────────────────────────────────────────────────


class _RecheckStore:
    """stub SyncStore.get(internal_id) → 邮件状态 dict (or None = 已删)。"""

    def __init__(self, mapping):
        self._m = mapping

    def get(self, iid):
        return self._m.get(iid)


def _capture_send(monkeypatch):
    sent: List[bytes] = []

    def fake_send_sync(data, **kwargs):
        sent.append(data)
        return ping_island.SendResult(ok=True)

    monkeypatch.setattr(island_reconnect.ping_island, "send_sync", fake_send_sync)
    return sent


def test_flush_drops_stale_completed_or_deleted(monkeypatch):
    """契约 §9-3: flush 前 re-check — 邮件已完成/已删的待办通知直接丢弃 (不发)。"""
    from src.notify import island_dispatch

    store = _RecheckStore({
        500: {"processing_status": "已完成"},   # 已完成 → drop
        501: {"processing_status": None},        # 未处理 → send
        # 502 缺失 → get None (已删) → drop
    })
    monkeypatch.setattr(island_dispatch._state, "sync_store", store)
    sent = _capture_send(monkeypatch)

    island_reconnect.enqueue(b'{"done":1}', status_kind="waitingForInput",
                             internal_id=500, event_type="LLMReviewedUrgent")
    island_reconnect.enqueue(b'{"live":1}', status_kind="waitingForInput",
                             internal_id=501, event_type="LLMReviewedUrgent")
    island_reconnect.enqueue(b'{"gone":1}', status_kind="waitingForInput",
                             internal_id=502, event_type="LLMReviewedUrgent")
    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 1                 # 只有 501 真发
    assert sent == [b'{"live":1}']
    assert island_reconnect.queue_len() == 0  # stale 丢 + live 发, 队列清空


def test_flush_terminal_envelope_always_sent_even_if_done(monkeypatch):
    """终态 envelope (completed/error, 如 MailCompleted) 即使邮件已完成也照发 (清 dock)。"""
    from src.notify import island_dispatch

    monkeypatch.setattr(island_dispatch._state, "sync_store",
                        _RecheckStore({500: {"processing_status": "已完成"}}))
    sent = _capture_send(monkeypatch)
    island_reconnect.enqueue(b'{"complete":1}', status_kind="completed",
                             internal_id=500, event_type="MailCompleted")
    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 1
    assert sent == [b'{"complete":1}']


def test_flush_no_internal_id_always_sent(monkeypatch):
    """无 internal_id (系统事件 / 向后兼容老调用) → re-check 放行, 照常 flush。"""
    sent = _capture_send(monkeypatch)
    island_reconnect.enqueue(b'{"sys":1}', status_kind="error")  # internal_id=None 默认
    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 1
    assert sent == [b'{"sys":1}']


def test_enqueue_routes_status_kind_to_bucket():
    """status_kind ∈ {completed,error,waitingForInput} → critical; 其他 → notification."""
    island_reconnect.enqueue(b'{"a":1}', status_kind="notification")
    island_reconnect.enqueue(b'{"b":1}', status_kind="completed")
    island_reconnect.enqueue(b'{"c":1}', status_kind="error")
    island_reconnect.enqueue(b'{"d":1}', status_kind="waitingForInput")
    island_reconnect.enqueue(b'{"e":1}')  # default → notification
    assert island_reconnect.queue_len_critical() == 3
    assert island_reconnect.queue_len_notification() == 2
    assert island_reconnect.queue_len() == 5


def test_queue_full_drops_notification_first(monkeypatch):
    """P0-3 核心: cap=5, 入 3 critical + 5 notification → 应保留 3 critical + 2 notification (丢 3 老 notification)."""
    monkeypatch.setenv("PING_ISLAND_QUEUE_MAX", "5")
    island_reconnect.clear_queue()
    for i in range(3):
        island_reconnect.enqueue(f"crit-{i}".encode(), status_kind="completed")
    for i in range(5):
        island_reconnect.enqueue(f"notif-{i}".encode(), status_kind="notification")
    assert island_reconnect.queue_len() == 5
    assert island_reconnect.queue_len_critical() == 3
    assert island_reconnect.queue_len_notification() == 2
    # 老 notification (0,1,2) 被丢, 留 notif-3, notif-4 (队列元素现为 _Queued 记录)
    assert [q.data for q in island_reconnect._notification] == [b"notif-3", b"notif-4"]
    assert [q.data for q in island_reconnect._critical] == [b"crit-0", b"crit-1", b"crit-2"]


def test_queue_full_drops_critical_only_when_notification_empty(monkeypatch):
    """notification 已空时, 才开始淘汰 critical 头部 (兜底, 避免老 critical 留太久)。"""
    monkeypatch.setenv("PING_ISLAND_QUEUE_MAX", "3")
    island_reconnect.clear_queue()
    for i in range(5):
        island_reconnect.enqueue(f"crit-{i}".encode(), status_kind="error")
    # cap=3 → 留最新 3 个 critical (老的被丢)
    assert island_reconnect.queue_len() == 3
    assert [q.data for q in island_reconnect._critical] == [b"crit-2", b"crit-3", b"crit-4"]
    assert island_reconnect.queue_len_notification() == 0


def test_flush_critical_before_notification(monkeypatch):
    """flush 顺序: 全部 critical (FIFO) 先, 之后 notification (FIFO)。"""
    island_reconnect.clear_queue()
    island_reconnect.enqueue(b"notif-1", status_kind="notification")
    island_reconnect.enqueue(b"crit-1", status_kind="completed")
    island_reconnect.enqueue(b"notif-2", status_kind="notification")
    island_reconnect.enqueue(b"crit-2", status_kind="waitingForInput")

    sent: List[bytes] = []

    def fake_send_sync(data, **kwargs):
        sent.append(data)
        return ping_island.SendResult(ok=True, latency_ms=1)

    monkeypatch.setattr(island_reconnect.ping_island, "send_sync", fake_send_sync)
    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 4
    # critical 先 (按入队顺序), 再 notification (按入队顺序)
    assert sent == [b"crit-1", b"crit-2", b"notif-1", b"notif-2"]


def test_flush_partial_keeps_remaining_in_order(monkeypatch):
    """flush 到 critical 第二条失败 → 该条 + 后续全部留下次 retry."""
    island_reconnect.clear_queue()
    island_reconnect.enqueue(b"crit-1", status_kind="completed")
    island_reconnect.enqueue(b"crit-2", status_kind="error")
    island_reconnect.enqueue(b"notif-1", status_kind="notification")

    sent: List[bytes] = []

    def fake_send_sync(data, **kwargs):
        sent.append(data)
        if data == b"crit-1":
            return ping_island.SendResult(ok=True, latency_ms=1)
        return ping_island.SendResult(ok=False, error="ENOENT")

    monkeypatch.setattr(island_reconnect.ping_island, "send_sync", fake_send_sync)
    flushed = asyncio.run(island_reconnect._flush_queue())
    assert flushed == 1
    assert sent == [b"crit-1", b"crit-2"]  # crit-2 试了但失败, stop
    # crit-2 + notif-1 留下次
    assert island_reconnect.queue_len_critical() == 1
    assert island_reconnect.queue_len_notification() == 1


def test_enqueue_default_status_kind_is_notification():
    """向后兼容: 不传 status_kind → notification bucket。"""
    island_reconnect.enqueue(b"legacy")
    assert island_reconnect.queue_len_notification() == 1
    assert island_reconnect.queue_len_critical() == 0


# ─────────────────────────────────────────────────────────────────────────────
# P0-3: 冷启动 fast probe — 启动后 window 秒内用 fast probe, 之后退到 default
# ─────────────────────────────────────────────────────────────────────────────


def test_select_base_interval_fast_probe_during_startup_window(monkeypatch):
    """启动 window 内 → fast probe 秒数。"""
    monkeypatch.delenv("PING_ISLAND_RECONNECT_PROBE_INTERVAL", raising=False)
    monkeypatch.delenv("PING_ISLAND_RECONNECT_STARTUP_FAST_WINDOW_SECONDS", raising=False)
    monkeypatch.delenv("PING_ISLAND_RECONNECT_STARTUP_FAST_PROBE_SECONDS", raising=False)
    island_reconnect.reset_startup_window_for_tests()
    # 默认 fast probe = 5s
    assert island_reconnect._select_base_interval() == 5


def test_select_base_interval_defaults_after_startup_window(monkeypatch):
    """启动 window 过期 → 退到 default probe interval (300s)。"""
    monkeypatch.delenv("PING_ISLAND_RECONNECT_PROBE_INTERVAL", raising=False)
    monkeypatch.delenv("PING_ISLAND_RECONNECT_STARTUP_FAST_WINDOW_SECONDS", raising=False)
    # 把进程启动时间设到 1 小时前 → window (默认 300s) 已过
    past = time.monotonic() - 3600
    island_reconnect.set_startup_window_origin_for_tests(past)
    assert island_reconnect._select_base_interval() == 300


def test_select_base_interval_respects_env_overrides(monkeypatch):
    """env 可覆盖 fast window 长度 + fast probe 间隔。"""
    monkeypatch.setenv("PING_ISLAND_RECONNECT_STARTUP_FAST_WINDOW_SECONDS", "60")
    monkeypatch.setenv("PING_ISLAND_RECONNECT_STARTUP_FAST_PROBE_SECONDS", "2")
    monkeypatch.setenv("PING_ISLAND_RECONNECT_PROBE_INTERVAL", "120")
    # window 内 → fast probe = 2s
    island_reconnect.reset_startup_window_for_tests()
    assert island_reconnect._select_base_interval() == 2
    # window 已过 → default = 120s
    past = time.monotonic() - 120  # 60s 之外
    island_reconnect.set_startup_window_origin_for_tests(past)
    assert island_reconnect._select_base_interval() == 120


def test_select_base_interval_zero_window_disables_fast_probe(monkeypatch):
    """window=0 → fast probe 立即停用, 直接走 default probe interval。"""
    monkeypatch.setenv("PING_ISLAND_RECONNECT_STARTUP_FAST_WINDOW_SECONDS", "0")
    monkeypatch.delenv("PING_ISLAND_RECONNECT_PROBE_INTERVAL", raising=False)
    island_reconnect.reset_startup_window_for_tests()
    assert island_reconnect._select_base_interval() == 300


def test_startup_fast_probe_seconds_min_clamps_to_one(monkeypatch):
    """fast probe < 1 → clamp 到 1 (防 busy loop)。"""
    monkeypatch.setenv("PING_ISLAND_RECONNECT_STARTUP_FAST_PROBE_SECONDS", "0")
    assert island_reconnect._startup_fast_probe_seconds() == 1
    monkeypatch.setenv("PING_ISLAND_RECONNECT_STARTUP_FAST_PROBE_SECONDS", "-5")
    assert island_reconnect._startup_fast_probe_seconds() == 1
