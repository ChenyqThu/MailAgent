"""SSE redis 分支: pubsub 底层 socket 报 ETIMEDOUT 后必须重连, 不能空转。

背景 (2026-10 serve 进程 4GB self-heal): redis-py 8 默认开 TCP keepalive, 远端 Redis 网络抖动时
recv() 报 ETIMEDOUT → 内置 TimeoutError 被存进 StreamReader。redis-py 的 read_response 把它当成
「调用方要求的读超时」返回 None 且不断开, 于是 get_message(timeout=15) 每次微秒级返回 None,
_stream_events 把 None 当心跳 → 静默热循环; readuntil 每次 raise 同一个异常对象, traceback 无限增长。

真实 aiohttp server + 真实 redis-py PubSub + 最小 RESP3 假服务端; 只在「注入断线」一步碰 transport 私有方法,
它与 selector transport 收到 recv() 错误时走的是同一条路 (_fatal_error → _force_close → connection_lost)。
"""
from __future__ import annotations

import asyncio
import errno

import pytest
from aiohttp.test_utils import TestClient, TestServer
from redis.asyncio.client import Redis

import src.sse_server as sse

# 健康路径全程只需个位数次调用 (订阅确认 / 断线后重连各一两次)
_MAX_GET_MESSAGE_CALLS = 50


class _FakeRedis:
    """只懂 HELLO / SUBSCRIBE 的 RESP3 服务端, 其余命令一律 +OK。"""

    def __init__(self) -> None:
        self.subscribers: list[asyncio.StreamWriter] = []
        self.subscribe_count = 0
        self._server: asyncio.base_events.Server | None = None

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        return self._server.sockets[0].getsockname()[1]

    async def close(self) -> None:
        for w in self.subscribers:
            w.close()
        self._server.close()

    def publish(self, channel: bytes, data: bytes) -> None:
        frame = b">3\r\n$7\r\nmessage\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n" % (
            len(channel), channel, len(data), data,
        )
        for w in self.subscribers:
            if not w.is_closing():
                w.write(frame)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    return
                if not line.startswith(b"*"):
                    continue
                args = []
                for _ in range(int(line[1:])):
                    await reader.readline()
                    args.append((await reader.readline())[:-2])
                cmd = args[0].upper()
                if cmd == b"HELLO":
                    writer.write(b"%1\r\n+proto\r\n:3\r\n")
                elif cmd == b"SUBSCRIBE":
                    ch = args[1]
                    writer.write(b">3\r\n$9\r\nsubscribe\r\n$%d\r\n%s\r\n:1\r\n" % (len(ch), ch))
                    self.subscribers.append(writer)
                    self.subscribe_count += 1
                else:
                    writer.write(b"+OK\r\n")
                await writer.drain()
        except ConnectionError:
            pass
        finally:
            if writer in self.subscribers:
                self.subscribers.remove(writer)


async def _wait_until(pred, timeout: float = 3.0) -> None:
    for _ in range(int(timeout / 0.02)):
        if pred():
            return
        await asyncio.sleep(0.02)
    assert pred(), "condition not met within timeout"


async def _read_until_data(resp, needle: bytes, timeout: float = 3.0) -> bool:
    """读 SSE 帧直到出现 needle; 流提前结束返回 False。"""
    async with asyncio.timeout(timeout):
        while True:
            try:
                frame = await resp.content.readuntil(b"\n\n")
            except asyncio.IncompleteReadError:
                return False
            if needle in frame:
                return True


@pytest.mark.asyncio
async def test_pubsub_reconnects_after_socket_etimedout(monkeypatch):
    fake = _FakeRedis()
    port = await fake.start()
    channel = sse.SSE_CHANNEL.encode()
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(sse, "_get_redis_url", lambda: f"redis://127.0.0.1:{port}/0")
    # 心跳调大: 健康的循环在本测时长内不会发 ping, 一旦空转就会刷出成串的 ping
    monkeypatch.setattr(sse, "SSE_HEARTBEAT_SEC", 30)

    pubsubs = []
    calls = 0
    orig_pubsub = Redis.pubsub

    def _capture(self, **kwargs):
        ps = orig_pubsub(self, **kwargs)
        pubsubs.append(ps)
        orig_get = ps.get_message

        async def _counted(*args, **kw):
            # 熔断: 空转时 get_message 从不真正挂起, 事件循环被占满, 测试自己的超时都触发不了
            nonlocal calls
            calls += 1
            if calls > _MAX_GET_MESSAGE_CALLS:
                raise asyncio.CancelledError
            return await orig_get(*args, **kw)

        ps.get_message = _counted
        return ps

    monkeypatch.setattr(Redis, "pubsub", _capture)

    client = TestClient(TestServer(sse.make_app()))
    await client.start_server()
    try:
        resp = await client.get("/api/events/stream")
        assert resp.status == 200
        await _wait_until(lambda: fake.subscribe_count == 1)
        fake.publish(channel, b'{"n":"before"}')
        assert await _read_until_data(resp, b'"before"')

        conn = pubsubs[0].connection
        conn._writer.transport._force_close(
            TimeoutError(errno.ETIMEDOUT, "Operation timed out")
        )

        await _wait_until(
            lambda: calls > _MAX_GET_MESSAGE_CALLS or (fake.subscribe_count == 2 and fake.subscribers)
        )
        assert calls <= _MAX_GET_MESSAGE_CALLS, f"断线后 get_message 空转超过 {_MAX_GET_MESSAGE_CALLS} 次"
        fake.publish(channel, b'{"n":"after"}')
        assert await _read_until_data(resp, b'"after"'), "断线后没有重新订阅, 消息没送到"
        resp.close()
    finally:
        await client.close()
        await fake.close()
