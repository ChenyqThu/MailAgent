"""sse_server 无 Redis 进程内总线分支单测 (Y, task #11).

覆盖 architect checklist:
- 无 redis: GET /api/events/stream 返 200 (曾 503) + 收到 bus.publish 的 frame
- 无 redis: 心跳 event: ping (monkeypatch 小 SSE_HEARTBEAT_SEC)
- 无 redis: 多客户端 fanout (一次 publish 两个 client 都收)
- 无 redis: 客户端断连 → bus 退订 (subscriber 清理, 防泄漏)
- redis 在场: 仍走 redis pubsub, 绝不 bus.subscribe (either/or 回归 guard)

aiohttp TestServer/TestClient 真起 server 读流; 全用 wait_for/poll 不用定时 sleep。
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from aiohttp.test_utils import TestClient, TestServer

import src.sse_server as sse
from src.events.inprocess_bus import (
    InProcessEventBus,
    get_inprocess_bus,
    reset_inprocess_bus_for_tests,
)


async def _client(app) -> TestClient:
    c = TestClient(TestServer(app))
    await c.start_server()
    return c


async def _wait_until(pred, timeout: float = 2.0) -> None:
    """poll 到 pred() 为真或超时 (不用定时 sleep 作同步)。"""
    for _ in range(int(timeout / 0.02)):
        if pred():
            return
        await asyncio.sleep(0.02)
    assert pred(), "condition not met within timeout"


@pytest.mark.asyncio
async def test_no_redis_returns_200_and_streams_frame(monkeypatch):
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: None)
    reset_inprocess_bus_for_tests()
    bus = get_inprocess_bus()
    bus.bind_loop(asyncio.get_running_loop())
    c = await _client(sse.make_app())
    try:
        resp = await c.get("/api/events/stream")
        assert resp.status == 200  # 曾是 503
        assert resp.headers["Content-Type"] == "text/event-stream"
        await _wait_until(lambda: len(bus._subscribers) == 1)
        bus.publish('{"event_type": "email.synced", "internal_id": 7}')
        frame = await asyncio.wait_for(resp.content.readuntil(b"\n\n"), 2.0)
        text = frame.decode()
        assert "event: mailagent" in text
        assert '"email.synced"' in text
        assert '"internal_id": 7' in text
        resp.close()
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_no_redis_heartbeat(monkeypatch):
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: None)
    monkeypatch.setattr(sse, "SSE_HEARTBEAT_SEC", 0.1)
    reset_inprocess_bus_for_tests()
    get_inprocess_bus().bind_loop(asyncio.get_running_loop())
    c = await _client(sse.make_app())
    try:
        resp = await c.get("/api/events/stream")
        assert resp.status == 200
        frame = await asyncio.wait_for(resp.content.readuntil(b"\n\n"), 2.0)
        assert b"event: ping" in frame
        resp.close()
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_no_redis_multi_client_fanout(monkeypatch):
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: None)
    reset_inprocess_bus_for_tests()
    bus = get_inprocess_bus()
    bus.bind_loop(asyncio.get_running_loop())
    c = await _client(sse.make_app())
    try:
        r1 = await c.get("/api/events/stream")
        r2 = await c.get("/api/events/stream")
        assert r1.status == 200 and r2.status == 200
        await _wait_until(lambda: len(bus._subscribers) == 2)
        bus.publish('{"event_type": "email.new"}')
        f1 = await asyncio.wait_for(r1.content.readuntil(b"\n\n"), 2.0)
        f2 = await asyncio.wait_for(r2.content.readuntil(b"\n\n"), 2.0)
        assert b"email.new" in f1
        assert b"email.new" in f2
        r1.close()
        r2.close()
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_no_redis_disconnect_unsubscribes(monkeypatch):
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: None)
    monkeypatch.setattr(sse, "SSE_HEARTBEAT_SEC", 0.1)  # 让断连经心跳 write 快速暴露
    reset_inprocess_bus_for_tests()
    bus = get_inprocess_bus()
    bus.bind_loop(asyncio.get_running_loop())
    c = await _client(sse.make_app())
    try:
        resp = await c.get("/api/events/stream")
        assert resp.status == 200
        await _wait_until(lambda: len(bus._subscribers) == 1)
        resp.close()
        await _wait_until(lambda: len(bus._subscribers) == 0, timeout=3.0)
        assert len(bus._subscribers) == 0
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_redis_present_never_subscribes_bus(monkeypatch):
    """redis_url 在场 → 走 redis pubsub, 绝不 bus.subscribe (either/or 回归 guard)."""
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: "redis://localhost:6379/2")
    reset_inprocess_bus_for_tests()
    c = await _client(sse.make_app())
    try:
        with patch.object(InProcessEventBus, "subscribe") as mock_sub:
            resp = await c.get("/api/events/stream")
            # redis 分支 prepare 200 后连 redis (本测环境无 redis → 内部重试),
            # 关键是绝不碰进程内总线
            await asyncio.sleep(0.1)
            resp.close()
            mock_sub.assert_not_called()
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_end_to_end_safe_publish_to_sse(monkeypatch):
    """端到端: safe_publish(redis 空) → 进程内总线 → SSE client 收到 frame.

    复刻 watcher 在无 Redis 时调 safe_publish('email.synced') → 前端 SSE 自动刷新
    的全链路 (Y 的价值闭环)。
    """
    from src.config import config
    from src.events.publisher import safe_publish

    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: None)
    monkeypatch.setattr(config, "redis_url", "")
    reset_inprocess_bus_for_tests()
    get_inprocess_bus().bind_loop(asyncio.get_running_loop())
    c = await _client(sse.make_app())
    try:
        resp = await c.get("/api/events/stream")
        assert resp.status == 200
        await _wait_until(lambda: len(get_inprocess_bus()._subscribers) == 1)
        safe_publish(
            "email.synced",
            internal_id=99,
            data={"mailbox": "发件箱"},
            source="new_watcher",
        )
        frame = await asyncio.wait_for(resp.content.readuntil(b"\n\n"), 2.0)
        text = frame.decode()
        assert "event: mailagent" in text
        assert '"email.synced"' in text
        assert '"internal_id": 99' in text
        assert "发件箱" in text  # ensure_ascii=False, 中文不转义
        resp.close()
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_production_start_sse_server_e2e(monkeypatch):
    """通过 start_sse_server 真实启动 (含 bind_loop), safe_publish → SSE client 收到,
    不手工 bind —— 覆盖 production 启动路径 (codex LOW 1)."""
    import aiohttp

    from src.config import config
    from src.events.publisher import safe_publish

    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: None)
    monkeypatch.setattr(config, "redis_url", "")
    reset_inprocess_bus_for_tests()
    runner = await sse.start_sse_server(host="127.0.0.1", port=19200)
    try:
        assert get_inprocess_bus()._loop is not None  # production 路径已 bind_loop
        async with aiohttp.ClientSession() as sess:
            async with sess.get("http://127.0.0.1:19200/api/events/stream") as resp:
                assert resp.status == 200
                await _wait_until(
                    lambda: len(get_inprocess_bus()._subscribers) == 1
                )
                safe_publish("email.synced", internal_id=5, source="new_watcher")
                frame = await asyncio.wait_for(resp.content.readuntil(b"\n\n"), 2.0)
                assert b"email.synced" in frame
    finally:
        await runner.cleanup()
