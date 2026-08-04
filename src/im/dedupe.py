"""飞书事件去重 —— 按 ``event_id`` 的有界 LRU（08-01 阶段 2 PR-2）。

**为什么必须有**：飞书要求 handler **3 秒内返回且不抛异常**，否则判超时并**重推同一
事件**。重推带的是**同一个 ``event_id``**。没有去重 = 一次超时就跑两遍 agent、发两条
回复（PRD「重推去重：飞书超时重推时不得重复触发一次 agent run」）。

**为什么有界**：进程长驻数月，裸 ``set`` 是无上限内存增长。LRU 上限取 2048 —— 私聊
量级下远超「一次超时重推窗口」需要的记忆长度，几十 KB 内存。

线程安全：``on_message`` 跑在 lark 的 WS 事件循环线程上，投递/绑定跑在 executor
线程上，都可能碰它 → 用锁。
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Optional

DEFAULT_CAPACITY = 2048


class EventDeduper:
    """``seen(event_id)`` → 之前见过则 True（并把它挪到 LRU 队尾）。"""

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        if capacity <= 0:
            raise ValueError("EventDeduper capacity must be positive")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._seen: "OrderedDict[str, None]" = OrderedDict()

    def seen(self, event_id: Optional[str]) -> bool:
        """记录并判重。``event_id`` 为空 → **不判重**（宁可重复也不误吞真事件）。"""
        if not event_id:
            return False
        with self._lock:
            if event_id in self._seen:
                self._seen.move_to_end(event_id)
                return True
            self._seen[event_id] = None
            while len(self._seen) > self._capacity:
                self._seen.popitem(last=False)
            return False

    def __len__(self) -> int:  # pragma: no cover - 诊断用
        with self._lock:
            return len(self._seen)
