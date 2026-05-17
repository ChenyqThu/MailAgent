"""单测：island_reconnect — backlog queue + flush after probe success (H-17)."""

from __future__ import annotations

import asyncio
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
    monkeypatch.setattr(island_reconnect, "_probe_interval", lambda: 1)

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
