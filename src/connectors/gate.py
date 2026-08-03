"""按 namespace 的 connector 单飞闸（照 ``src/chat/notion_agent_gate.py`` 的 mutex 形状，keyed）。

🔴 **闸的落层选择（排雷报告风险 3，PR1 必做）**：Notion 的 refresh token **每次刷新即轮换**
（旧的立即作废）——两个并发调用同时发现 access token 过期、同时用同一个 refresh token 去刷，
后到的那个必被拒 → 整条连接掉线须重授权。而刷新发生在 httpx2 ``Auth`` 流（``OAuthClientProvider.
async_auth_flow``）**内部**，没有独立的「刷新入口」可以单独上锁。故把闸放在
**整个 connector 会话（``ConnectorClient.session``）级、按 namespace 串行**：

  - 同一 connector 同时至多一个会话在跑 ⇒ 同时至多一个 auth flow ⇒ 刷新天然单飞；
  - tool-call 层的串行（issue #69 形状）同一把锁顺带成立；
  - 不同 connector 各自一把锁，互不阻塞。

代价 = 同 connector 的并发 tool-call 排队（MVP 单 owner 场景可接受；将来要并发时改成
「会话内共享 provider + 刷新单独上锁」——那要求侵入 SDK auth flow，不在 PR1 做）。

SDK 自身的 ``OAuthContext.lock`` 是 per-provider 实例锁，罩不住「两个请求各建一个 provider」
的进程内并发 —— 本闸在 provider 之上按 namespace 收敛，正是补这个洞。
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict, Optional


class ConnectorBusy(Exception):
    """acquire 超时（同 connector 已有会话在跑，例如交互式授权挂着等浏览器回调）。"""

    def __init__(self, namespace: str, waited_seconds: float) -> None:
        super().__init__(
            f"connector {namespace} is busy (another session held the gate for "
            f">{waited_seconds:.1f}s — an interactive authorization may be in progress)"
        )
        self.namespace = namespace


class ConnectorGate:
    """keyed mutex：``async with gate.hold(namespace, timeout=…)``。

    锁按 namespace 惰性建、永不删（已知 connector 是有限小集合，无泄漏面）。
    ``timeout=None`` = 无限等（交互式授权流自己用）；有限值超时 → ``ConnectorBusy``
    （API 请求用 —— 别让一个挂着等浏览器的授权流把 sync 端点吊死）。
    """

    def __init__(self) -> None:
        self._locks: Dict[str, asyncio.Lock] = {}

    def _lock(self, namespace: str) -> asyncio.Lock:
        lock = self._locks.get(namespace)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[namespace] = lock
        return lock

    @asynccontextmanager
    async def hold(
        self, namespace: str, *, timeout: Optional[float] = None
    ) -> AsyncIterator[None]:
        lock = self._lock(namespace)
        if timeout is None:
            await lock.acquire()
        else:
            try:
                await asyncio.wait_for(lock.acquire(), timeout)
            except asyncio.TimeoutError:
                # wait_for 取消了 acquire —— asyncio.Lock 取消安全，未持有无需 release。
                raise ConnectorBusy(namespace, timeout) from None
        try:
            yield
        finally:
            lock.release()

    def locked(self, namespace: str) -> bool:
        """test-only —— 该 namespace 是否有持有方。"""
        return self._lock(namespace).locked()


# 生产单例 —— serve-api 进程内所有 connector 会话过同一个 gate（跨并发请求串行化）。
connector_gate = ConnectorGate()
