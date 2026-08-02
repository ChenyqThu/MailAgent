"""agent_run 读侧状态推导（S4 W4，ADR D4/Q6）—— paused_handoff 语义的**单源** helper。

🔴 UI/API 纪律（ADR D4，codex P1-4）：``status=succeeded && result.outcome='paused_handoff'``
**永不得渲染为「成功完成」** —— 那是「等审批」（岛 on）或「已作废」（岛 off / 超时），不是成功。
S5 的任何展示面（Settings run 历史 / API 投影）只允许经本 helper 读态，不得各自解读
status/result_json 组合（防第二处解读漂移出「paused 显示成成功」的回归）。

``expired`` 有意**不写库、读侧推导**（ADR D4/Q6）：stash GC 是 gateway 进程内的惰性内存操作，
不可靠作回写触发器；approval_state 停在 'pending' 且 age 超过 stash TTL → 展示层视为已过期
作废（审批无决策面，写没发生）。

纯函数：不接线任何运行时路径（flag-off 字节级不变）；输入是 async_jobs 行的 dict 投影。
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Mapping, Optional

# 岛 stash TTL（秒）—— 跨端对应 gateway ``frontend/src/ai-gateway/approvalStash.ts`` 的
# ``DEFAULT_STASH_TTL_MS = 30 * 60 * 1000``（同值还锚着 island ack pending TTL 与延长版
# ApprovalGuard TTL）。pending 超过此龄 = stash 必已 GC / gateway 已重启 → 审批无决策面，
# fail-closed 方向是「写没发生」→ 读侧视为已过期作废。两端改 TTL 必须同步。
APPROVAL_PENDING_TTL_SEC = 30 * 60

# derive_agent_run_state 的完整值域（有限枚举，UI 按此穷举渲染）。
AGENT_RUN_STATES = frozenset({
    "queued",           # 已入队未认领
    "running",          # AgentRunWorker 已认领, drain 进行中
    "completed",        # succeeded + outcome!='paused_handoff' —— 唯一的「成功完成」
    "skipped",          # succeeded + outcome='skipped' —— 预算门拒绝，未执行 LLM
    "paused_pending",   # 等审批中（岛卡可批, age ≤ TTL）
    "paused_expired",   # 审批已过期作废（age > TTL, 或无时间戳可证明仍可批）
    "paused_approved",  # 岛上已批准（resume 终局回写）
    "paused_rejected",  # 岛上已拒绝
    "failed",           # failed/aborted/E_ORPHANED 等一切非成功终态
})


def _result_dict(row: Mapping[str, Any]) -> dict:
    """行投影里取 result：优先已解析的 ``result``（AsyncJob dataclass / API 投影），
    否则解析原始 ``result_json``。缺失/坏 JSON/非 dict → {}。"""
    parsed = row.get("result")
    if isinstance(parsed, dict):
        return parsed
    raw = row.get("result_json")
    if isinstance(raw, str) and raw:
        try:
            v = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
        return v if isinstance(v, dict) else {}
    return {}


def derive_agent_run_state(
    row: Mapping[str, Any],
    *,
    now_fn: Callable[[], float] = time.time,
) -> str:
    """async_jobs 行 dict → ``AGENT_RUN_STATES`` 中的一个读侧状态。

    映射（ADR D4 终态表 + Q6）：
      - ``queued`` / ``running`` → 原样；
      - 非 succeeded 终态（failed/aborted/partial_failure/未知 status）→ ``failed``
        （fail-closed：解读不了的行绝不落成任何「成功/等审批」形态）；
      - ``succeeded`` 且 outcome != 'paused_handoff'（含缺 result_json —— 无法证明 paused，
        且 worker 对 paused 恒写 outcome，缺失只可能是 completed 老形状）→ ``completed``；
      - ``succeeded`` + outcome='paused_handoff'（🔴 **非**成功完成）：
          approval_state='approved' → ``paused_approved``；'rejected' → ``paused_rejected``；
          'pending'（或缺失 —— worker pause 恒写 pending，缺失按 pending 保守处理）→ 按龄推导：
          ``now - finished_at > APPROVAL_PENDING_TTL_SEC`` → ``paused_expired``，否则
          ``paused_pending``；恰等 TTL 仍算 pending（ADR 措辞 age>TTL 才过期）；无
          finished_at/updated_at 可依 → ``paused_expired``（无法证明 stash 仍活 = 不可批）。
    """
    status = row.get("status")
    if status == "queued":
        return "queued"
    if status == "running":
        return "running"
    if status != "succeeded":
        return "failed"

    result = _result_dict(row)
    if result.get("outcome") == "skipped":
        return "skipped"
    if result.get("outcome") != "paused_handoff":
        return "completed"

    approval = result.get("approval_state")
    if approval == "approved":
        return "paused_approved"
    if approval == "rejected":
        return "paused_rejected"

    # pending（含缺失, 保守按 pending）→ age 推导 expired（D4/Q6: expired 不写库）。
    ts: Optional[Any] = row.get("finished_at") or row.get("updated_at")
    try:
        age = now_fn() - float(ts)
    except (TypeError, ValueError):
        return "paused_expired"  # 无时间戳 → 无法证明可批, fail-closed 视为过期
    return "paused_expired" if age > APPROVAL_PENDING_TTL_SEC else "paused_pending"
