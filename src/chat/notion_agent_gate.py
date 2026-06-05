"""notion-agent 串行 gate —— Python 复刻 frontend ``chat/backends/notion_agent_gate.ts``。

serve-api 在单一 asyncio 进程内 spawn ``notion-agent chat`` 子进程
（``POST /api/chat/notion-agent``）。每次 spawn 都驱动 Notion 内部 ✦ AI endpoint，
server-side 反自动化 "trust rule" 会因 *并发* 调用突增把会话推入 strict mode →
exit 75（E_NOTION_AGENT_RATE_LIMIT）+ 多分钟封禁。跨浏览器标签页 / chat popout 的
并发请求是主要触发源。

本 gate 是 **预防层**（reactive 侧 = exit 75 → 冷却退避，在 backend classify_exit 复刻）：
  - **MUTEX**：同一时刻至多一个 notion-agent 子进程。
  - **RATE LIMIT**：连续 grant *起点* 间隔 ≥ min_interval，从上一个起点测（故长调用天然
    覆盖间隔，只在 back-to-back 突发时加等待）。

镜像 TS ``NotionAgentSerialGate`` 的两条保证。abort 在 Python 用 **asyncio 任务取消** 表达
（对应 TS 的 ``AbortSignal`` —— 语义等价的 Python 习惯用法）：等待 ``acquire()`` 时被取消 →
``CancelledError`` 自然传播，调用方静默 bail（从未持有 gate，无需 release）。``asyncio.Lock``
提供 FIFO 公平的 mutex；min-interval 在拿到 lock 后按需 ``sleep``。

注入 ``now`` / ``sleep`` seam 供测试确定性校验 min-interval（对齐 TS gate 的手动时钟）。
custom-api 后端永不碰本 gate（它打 Anthropic API，无 trust rule）。
"""

from __future__ import annotations

import asyncio
import math
import os
import time
from typing import Awaitable, Callable, Optional


def _read_env_number(name: str, default: float) -> float:
    """读 env 数值，缺失/空/非有限 → default。镜像 config.ts ``readEnvNumber``。"""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) else default


def get_notion_agent_min_interval_ms() -> float:
    """连续 grant 起点最小间隔 ms（NOTION_AGENT_MIN_INTERVAL_MS，默认 30000）。镜像 config.ts。"""
    return max(0.0, _read_env_number("NOTION_AGENT_MIN_INTERVAL_MS", 30_000.0))


class NotionAgentSerialGate:
    """mutex + 从起点测的 min-interval 串行 gate（见模块 docstring）。"""

    def __init__(
        self,
        get_min_interval_ms: Callable[[], float] = get_notion_agent_min_interval_ms,
        *,
        now: Optional[Callable[[], float]] = None,
        sleep: Optional[Callable[[float], Awaitable[None]]] = None,
    ) -> None:
        self._get_min_interval_ms = get_min_interval_ms
        # 时钟以 ms 计（与 min-interval 同单位）；sleep 以秒计（asyncio.sleep 契约）。
        self._now_ms = now or (lambda: time.monotonic() * 1000.0)
        self._sleep = sleep or asyncio.sleep
        self._lock = asyncio.Lock()
        # 从 -∞ 起步，首个 acquire 永不等 min-interval。
        self._last_start_ms = float("-inf")

    async def acquire(self) -> Callable[[], None]:
        """拿到 mutex + 满足 min-interval 后返回 ``release()``。

        等待期间被取消（``CancelledError``）→ 调用方静默 bail：
          - 取消发生在 ``lock.acquire()`` 阶段 → lock 未持有（asyncio.Lock 取消安全），无需 release。
          - 取消发生在 min-interval ``sleep`` 阶段 → 已持有 lock，下方 ``except`` 兜底 release 再 re-raise。

        ``release()`` 幂等；持有方在 ``finally`` 里恰好调一次。
        """
        await self._lock.acquire()
        try:
            min_interval = max(0.0, self._get_min_interval_ms())
            wait_ms = self._last_start_ms + min_interval - self._now_ms()
            if wait_ms > 0:
                await self._sleep(wait_ms / 1000.0)
            self._last_start_ms = self._now_ms()
        except BaseException:
            # sleep 被取消 / get_min_interval_ms 抛 —— 释放已持有的 mutex，避免 wedge。
            self._lock.release()
            raise
        return self._make_release()

    def _make_release(self) -> Callable[[], None]:
        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            self._lock.release()

        return release

    def reset(self) -> None:
        """test-only —— 清 mutex + rate-limit 时钟，下个 acquire 立即放行。"""
        if self._lock.locked():
            self._lock.release()
        self._last_start_ms = float("-inf")

    @property
    def active(self) -> bool:
        """test-only —— 是否有持有方（mutex 被占）。"""
        return self._lock.locked()


# 生产单例 —— serve-api 进程内所有 notion-agent spawn 都过这一个 gate（跨并发请求串行化）。
# min-interval 每次 acquire 从 env 现读（运行时改 / 测试覆盖即时生效）。
notion_agent_gate = NotionAgentSerialGate()
