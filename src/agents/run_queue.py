"""agent_run enqueue helper —— cron worker 与 email hook 共用入队路径（S4 W1, D4/D7）。

单一入队入口，两处触发方（``AgentTriggerWorker`` cron / new_watcher 第 5 hook email）都经它：
  - runs/day 门（D7-1）：enqueue 前查当日实际运行数；超限仍写一条 outcome=skipped 的可见历史；
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
    trigger_id: Optional[str] = None,
    now_fn: Callable[[], float] = time.time,
) -> Tuple[int, bool]:
    """runs/day 门 + 幂等 enqueue 一个 agent_run job。

    Returns:
        (job_id, was_created) —— 正常入队、预算跳过或幂等命中既有。预算跳过行会立即写成
        ``succeeded + outcome=skipped``，因此不会被 worker claim，但会出现在运行历史里。
    """
    # 不变量（codex S4 终审唯一 finding，P3）：runs/day 门是 check-then-act（count → enqueue
    # 无事务），当前无竞态依赖「本函数同步无 await point + 两触发方（trigger_worker.tick_loop
    # cron / email_dispatch 的同 loop create_task 后台任务）跑在同一 event loop 串行调用」
    # → 单 loop 下 count+enqueue 原子、不可交错（机械守护
    # tests/agents/test_run_queue.py::test_sync_atomicity_invariant）。
    # 失效条件：count_agent_runs_since / enqueue 转 async（如换 aiosqlite）或触发方移到独立
    # 线程/进程 → 窗口打开，须改单 DB 事务内 count+INSERT（BEGIN IMMEDIATE CAS）才安全。
    # 语义边界：成本预算软门（D7 触发方职责）非安全边界——越限最坏 = 多跑几次 run（LLM 成本），
    # 无数据/权限影响；同-occurrence 重复由幂等键 partial unique 另兜（不靠此门）。
    day_start = _local_day_start(now_fn())
    used = repo.count_agent_runs_since(agent_id, day_start)
    payload: Dict[str, Any] = {
        "agent_id": agent_id,
        "trigger_kind": trigger_kind,
        "fire_key": fire_key,
    }
    if trigger_id is not None:
        payload["trigger_id"] = trigger_id
    if params:
        payload.update(params)
    job_id, was_created = repo.enqueue(
        job_type="agent_run",
        target_kind="agent",
        target_key=agent_id,
        params=payload,
        idempotency_key=(
            f"agent_run:{agent_id}:{trigger_id}:{fire_key}"
            if trigger_id is not None
            else f"agent_run:{agent_id}:{fire_key}"
        ),
    )
    if used >= budget.max_runs_per_day:
        if was_created:
            # CAS on 'queued'：enqueue 与本次写之间 AgentRunWorker 可能已 claim 并真的开跑
            # （同 event loop 内不可能 —— 本函数同步无 await point；跨进程则可能）。抢跑方赢：
            # 与其把一个**正在执行**的 run 记成「未执行」，不如让它照常跑完写自己的终态。
            recorded = repo.mark_terminal(
                job_id,
                status="succeeded",
                result={
                    "outcome": "skipped",
                    "reason": "daily_run_limit",
                    "runsToday": used,
                    "maxRunsPerDay": budget.max_runs_per_day,
                    "steps": 0,
                },
                expect_status="queued",
            )
            if not recorded:
                logger.warning(
                    f"[agent-run] budget hit but job_id={job_id} was already claimed "
                    f"(agent={agent_id}) — letting the in-flight run finish instead of "
                    f"marking it skipped"
                )
                return job_id, was_created
        logger.info(
            f"[agent-run] budget hit: agent={agent_id} runs_today={used} "
            f">= max_runs_per_day={budget.max_runs_per_day} — recorded skipped job_id={job_id}"
        )
        return job_id, was_created
    if was_created:
        logger.info(
            f"[agent-run] enqueued agent={agent_id} kind={trigger_kind} "
            f"job_id={job_id} fire_key={fire_key}"
        )
    return job_id, was_created
