"""agent_run enqueue helper —— cron worker 与 email hook 共用入队路径（S4 W1, D4/D7）。

单一入队入口，两处触发方（``AgentTriggerWorker`` cron / new_watcher 第 5 hook email）都经它：
  - runs/day 门（D7-1）：enqueue 前查当日已入队数, 超 budget.max_runs_per_day → skip；
  - 幂等键（D4）：``agent_run:{agent_id}:{fire_key}``（cron=fire_window_utc, email=internal_id）
    → async_jobs partial unique 挡重复入队 (弱网重发 / 同 occurrence 双 tick 去重)；
  - target_kind='agent' / target_key=agent_id（runs/day count 与 spec 端点按 agent_id 检索）。

W1 只入队（外壳）；执行走 AgentRunWorker（W2）+ gateway drain（W3）。
"""

from __future__ import annotations

import time
from datetime import datetime, time as _dtime
from typing import Any, Callable, Dict, Optional, Tuple

from loguru import logger

from src.agents.trigger import Budget
from src.sync.async_jobs import AsyncJobRepository


def _local_day_start(now_epoch: float) -> float:
    """本地时区当日 0 点的 epoch（runs/day 门的窗口下界，D7-1「本地时区」）。"""
    local = datetime.fromtimestamp(now_epoch).astimezone()
    midnight = datetime.combine(local.date(), _dtime.min, tzinfo=local.tzinfo)
    return midnight.timestamp()


def enqueue_agent_run(
    repo: AsyncJobRepository,
    *,
    agent_id: str,
    trigger_kind: str,
    fire_key: str,
    budget: Budget,
    params: Optional[Dict[str, Any]] = None,
    now_fn: Callable[[], float] = time.time,
) -> Optional[Tuple[int, bool]]:
    """runs/day 门 + 幂等 enqueue 一个 agent_run job。

    Returns:
        (job_id, was_created) —— 正常入队或幂等命中既有；``None`` = runs/day 超限被拦（未入队）。
    """
    day_start = _local_day_start(now_fn())
    used = repo.count_agent_runs_since(agent_id, day_start)
    if used >= budget.max_runs_per_day:
        logger.info(
            f"[agent-run] budget hit: agent={agent_id} runs_today={used} "
            f">= max_runs_per_day={budget.max_runs_per_day} — skip enqueue"
        )
        return None
    payload: Dict[str, Any] = {
        "agent_id": agent_id,
        "trigger_kind": trigger_kind,
        "fire_key": fire_key,
    }
    if params:
        payload.update(params)
    job_id, was_created = repo.enqueue(
        job_type="agent_run",
        target_kind="agent",
        target_key=agent_id,
        params=payload,
        idempotency_key=f"agent_run:{agent_id}:{fire_key}",
    )
    if was_created:
        logger.info(
            f"[agent-run] enqueued agent={agent_id} kind={trigger_kind} "
            f"job_id={job_id} fire_key={fire_key}"
        )
    return job_id, was_created
