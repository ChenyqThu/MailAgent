"""Skill invoke 层的配额闸 —— 只对 ``ToolDef.rate_limit`` 显式声明的 tool 生效。

**范围声明（别把它当通用限流）**：

- 生效面 = ``invoke_skill``（REST ``/api/skills/invoke`` 与 MCP 共用的唯一 chokepoint），
  与 scope gate / confirm gate 同层。
- 计数是 **进程内内存滑窗**：serve-api 是单 uvicorn worker（``src/cli/main.py`` 的
  ``uvicorn.run`` 不传 workers）→ 对外 agent 的所有调用都在同一进程里计数；但**重启即清零**，
  且 in-process ``LocalSkillClient``（selftest / 测试）与 serve-api 各自计数。
- **只有真正跑完的调用计数**：``check``（判定，不计数）→ dispatch → ``record``（成功才计）。
  参数非法 / 后端异常等**没有副作用**的调用不吃额度 —— 否则 20 次拼错的 ``mode`` 就能把一把
  合法的 key 锁死一小时（codex 实测）。代价是并发下可能轻微超发（两个并发调用同时通过
  ``check``）：可接受，因为限流不是安全边界，安全边界是 scope。
- 目的是挡「跑飞的 agent 刷屏」这一类事故（``email_draft`` 会 APPEND 进 Exchange Drafts +
  直写 ``email_metadata``），**不是**抗攻击的安全边界 —— 真正的安全边界是 scope 隔离。
- 未声明 ``rate_limit`` 的 tool **零行为变化**（不进本模块任何路径）。

声明形状（ToolDef.rate_limit）::

    {"limit": 20, "per_seconds": 3600, "scope": "principal"}

``scope`` 目前只支持 ``principal``（按 key_id / owner 身份分桶），未知值按 principal 处理。
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Any, Optional

from src.skills.errors import SkillError

# (principal_key, skill, tool) → 该窗口内的调用时刻（单调时钟）。
_HITS: dict[tuple[str, str, str], deque[float]] = defaultdict(deque)
_LOCK = threading.Lock()


def principal_key(principal: Any) -> str:
    """principal → 分桶键。agent key 按 key_id；owner（human/None）各自一桶。"""
    if principal is None:
        return "internal"
    key_id = getattr(principal, "key_id", None)
    if key_id:
        return f"key:{key_id}"
    return f"{getattr(principal, 'kind', 'owner')}:{getattr(principal, 'auth_method', 'unknown')}"


def _parse(spec: Optional[dict[str, Any]]) -> Optional[tuple[int, float]]:
    if not isinstance(spec, dict):
        return None
    try:
        limit = int(spec.get("limit"))
        per_seconds = float(spec.get("per_seconds"))
    except (TypeError, ValueError):
        return None
    if limit <= 0 or per_seconds <= 0:
        return None
    return limit, per_seconds


def check(
    principal: Any,
    skill_name: str,
    tool_name: str,
    spec: Optional[dict[str, Any]],
    *,
    now: Optional[float] = None,
) -> None:
    """额度还够吗？不够 → ``SkillError('E_RATE_LIMITED', http_status=429)``。**不计数**。

    ``spec`` 为 None / 形状非法 → 直接放行（未声明配额的 tool 走这条，零开销）。
    """
    parsed = _parse(spec)
    if parsed is None:
        return
    limit, window = parsed
    stamp = time.monotonic() if now is None else now
    bucket = (principal_key(principal), skill_name, tool_name)
    with _LOCK:
        hits = _prune(bucket, stamp, window)
        if len(hits) >= limit:
            retry_after = max(1, int(hits[0] + window - stamp) + 1)
            raise SkillError(
                "E_RATE_LIMITED",
                f"tool {skill_name}.{tool_name} rate limit exceeded "
                f"({limit} calls / {int(window)}s)",
                http_status=429,
                hint=f"retry in ~{retry_after}s",
            )


def record(
    principal: Any,
    skill_name: str,
    tool_name: str,
    spec: Optional[dict[str, Any]],
    *,
    now: Optional[float] = None,
) -> None:
    """记一次**已经真正跑起来**的调用（handler 返回之后才调）。"""
    parsed = _parse(spec)
    if parsed is None:
        return
    _limit, window = parsed
    stamp = time.monotonic() if now is None else now
    bucket = (principal_key(principal), skill_name, tool_name)
    with _LOCK:
        _prune(bucket, stamp, window).append(stamp)


def _prune(bucket: tuple[str, str, str], stamp: float, window: float) -> "deque[float]":
    """滑窗内的调用时刻（就地丢弃出窗的）。调用方须持 _LOCK。"""
    hits = _HITS[bucket]
    cutoff = stamp - window
    while hits and hits[0] <= cutoff:
        hits.popleft()
    return hits


def reset() -> None:
    """test-only：清空所有窗口。"""
    with _LOCK:
        _HITS.clear()
