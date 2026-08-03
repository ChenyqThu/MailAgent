"""OAuth rendezvous：单次消费 + TTL + error 投递 + wait 语义（回调端点的鉴权本体）。"""

from __future__ import annotations

import asyncio

import pytest

from src.connectors.oauth_flow import OAuthCallbackDenied, OAuthRendezvous


def test_deliver_unknown_state_rejected():
    rv = OAuthRendezvous()
    assert rv.deliver("never-registered", code="c") is False


def test_single_consumption():
    rv = OAuthRendezvous()
    rv.register("s1")
    assert rv.deliver("s1", code="code-1") is True
    # 重放同一 state —— 已消费，拒（回调端点转 404 不泄因）。
    assert rv.deliver("s1", code="code-2") is False


def test_ttl_expiry():
    clock = {"t": 0.0}
    rv = OAuthRendezvous(ttl_seconds=10.0, now=lambda: clock["t"])
    rv.register("s1")
    clock["t"] = 5.0
    rv.register("s2")
    clock["t"] = 11.0  # s1 过期（>10s），s2 还活着
    assert rv.deliver("s1", code="late") is False
    assert rv.deliver("s2", code="ok") is True


def test_wait_receives_delivery_and_discards():
    rv = OAuthRendezvous()
    rv.register("s1")

    async def _():
        waiter = asyncio.create_task(rv.wait("s1", timeout=5.0))
        await asyncio.sleep(0)  # 让 waiter 挂上 event
        assert rv.deliver("s1", code="the-code", iss="https://as.example") is True
        return await waiter

    result = asyncio.run(_())
    assert result.code == "the-code"
    assert result.state == "s1"
    assert result.iss == "https://as.example"
    # wait 收梢后条目已丢弃 —— 再投递（重放）拒。
    assert rv.deliver("s1", code="replay") is False


def test_wait_error_delivery_raises_denied():
    rv = OAuthRendezvous()
    rv.register("s1")

    async def _():
        waiter = asyncio.create_task(rv.wait("s1", timeout=5.0))
        await asyncio.sleep(0)
        assert rv.deliver("s1", error="access_denied") is True
        with pytest.raises(OAuthCallbackDenied) as ei:
            await waiter
        assert "access_denied" in str(ei.value)

    asyncio.run(_())


def test_wait_timeout():
    rv = OAuthRendezvous()
    rv.register("s1")

    async def _():
        with pytest.raises(asyncio.TimeoutError):
            await rv.wait("s1", timeout=0.05)

    asyncio.run(_())
    # 超时也丢条目：之后的迟到回调是 404，不是幽灵唤醒。
    assert rv.deliver("s1", code="late") is False


def test_wait_unregistered_state_is_a_bug():
    rv = OAuthRendezvous()

    async def _():
        with pytest.raises(RuntimeError):
            await rv.wait("nope", timeout=0.1)

    asyncio.run(_())
