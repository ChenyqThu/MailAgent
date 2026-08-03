"""ConnectorGate：同 namespace 串行（两个并发只放行一个在场）/ 跨 namespace 互不阻塞 /
acquire 超时 → ConnectorBusy。

单飞闸罩刷新的论证见 ``src/connectors/gate.py`` docstring：刷新发生在 httpx2 Auth 流内部、
无独立入口可锁，故按 namespace 串行整个会话 —— 本测试钉「同 namespace 并发度恒 ≤1」这个
不变量（= 两个并发刷新只可能有一个在跑）。
"""

from __future__ import annotations

import asyncio

import pytest

from src.connectors.gate import ConnectorBusy, ConnectorGate


def test_same_namespace_serializes():
    gate = ConnectorGate()
    active = {"n": 0, "max": 0}
    order: list[str] = []

    async def worker(tag: str):
        async with gate.hold("connector:notion"):
            active["n"] += 1
            active["max"] = max(active["max"], active["n"])
            order.append(f"{tag}-in")
            await asyncio.sleep(0.02)
            active["n"] -= 1
            order.append(f"{tag}-out")

    async def _():
        await asyncio.gather(worker("a"), worker("b"))

    asyncio.run(_())
    assert active["max"] == 1  # 🔴 并发度恒 1 = 两个并发「刷新」只放行一个
    assert order in (["a-in", "a-out", "b-in", "b-out"], ["b-in", "b-out", "a-in", "a-out"])


def test_different_namespaces_do_not_block():
    gate = ConnectorGate()
    active = {"n": 0, "max": 0}

    async def worker(ns: str):
        async with gate.hold(ns):
            active["n"] += 1
            active["max"] = max(active["max"], active["n"])
            await asyncio.sleep(0.02)
            active["n"] -= 1

    async def _():
        await asyncio.gather(worker("connector:notion"), worker("connector:atlassian"))

    asyncio.run(_())
    assert active["max"] == 2


def test_acquire_timeout_raises_busy():
    gate = ConnectorGate()

    async def _():
        async with gate.hold("connector:notion"):
            with pytest.raises(ConnectorBusy):
                async with gate.hold("connector:notion", timeout=0.05):
                    raise AssertionError("must not enter")
        # 释放后可再入（release 未被超时路径破坏）。
        async with gate.hold("connector:notion", timeout=0.05):
            pass

    asyncio.run(_())


def test_exception_inside_hold_releases():
    gate = ConnectorGate()

    async def _():
        with pytest.raises(ValueError):
            async with gate.hold("connector:notion"):
                raise ValueError("boom")
        assert gate.locked("connector:notion") is False

    asyncio.run(_())
