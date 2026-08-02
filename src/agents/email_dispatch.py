"""email_filter 触发分发 —— new_watcher 第 5 hook 的后台任务体（S4 W1, ADR D5）。

对每个 enabled 的 ``type='custom'`` email_filter agent 做正则匹配, 命中则 enqueue agent_run。
**正则编译 + 匹配都在这里执行**（hook 的 fire-and-forget 后台任务体内）——new_watcher 主循环
只做 flag + 存在性检查, 不碰正则, 使当封邮件的内联处理不被匹配拖住。
注意：本函数经 ``asyncio.create_task`` 调度, 仍跑在同一事件循环上（re 持 GIL）——ReDoS 防线是
pattern 长度≤256 + 输入截断 512 + owner 配置（非攻击者）, **不是**这层 task 隔离。

纯函数（注入 agents / repo / now_fn 即可测），异常逐 agent 隔离（一个坏 agent 不影响其余）。
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional

from loguru import logger

from src.agents.matcher import AgentEmailMatcher
from src.agents.run_queue import enqueue_agent_run
from src.agents.trigger import (
    EmailFilterTrigger,
    TriggerValidationError,
    parse_budget,
    parse_trigger,
)


def dispatch_email_agents(
    agents: List[Dict[str, Any]],
    *,
    sender: Optional[str],
    subject: Optional[str],
    mailbox: Optional[str],
    internal_id: int,
    repo: Any,
    now_fn: Callable[[], float] = time.time,
) -> int:
    """对候选 custom agent 逐个匹配 + 命中入队。返回命中且入队（含幂等命中既有）的数目。

    Args:
        agents: 主循环预筛的 enabled ``type='custom'`` 行（含 trigger_json/budget_json）。
    """
    fired = 0
    for agent in agents:
        agent_id = agent.get("id")
        try:
            trig = parse_trigger(agent.get("trigger_json"))
        except TriggerValidationError as e:
            logger.warning(f"[custom-agent] skip agent={agent_id} bad trigger_json: {e}")
            continue
        if not isinstance(trig, EmailFilterTrigger):
            continue  # cron → AgentTriggerWorker 负责，本路径只处理 email_filter
        try:
            matcher = AgentEmailMatcher(trig)
            if not matcher.is_match(sender=sender, subject=subject, mailbox=mailbox):
                continue
        except Exception as e:  # noqa: BLE001 — 正则匹配异常隔离到单 agent
            logger.warning(f"[custom-agent] match error agent={agent_id}: {e}")
            continue
        budget = parse_budget(agent.get("budget_json"))
        try:
            res = enqueue_agent_run(
                repo,
                agent_id=str(agent_id),
                trigger_kind="email_filter",
                fire_key=str(internal_id),
                budget=budget,
                params={"email_internal_id": internal_id},
                now_fn=now_fn,
            )
        except Exception as e:  # noqa: BLE001 — 入队异常隔离到单 agent
            logger.warning(f"[custom-agent] enqueue error agent={agent_id}: {e}")
            continue
        if res is not None:
            job = repo.get(res[0])
            skipped = bool(
                job and isinstance(job.result, dict) and job.result.get("outcome") == "skipped"
            )
            if skipped:
                logger.info(
                    f"[custom-agent] email_filter matched agent={agent_id} "
                    f"internal_id={internal_id} → daily limit, recorded skipped"
                )
                continue
            fired += 1
            logger.info(
                f"[custom-agent] email_filter matched agent={agent_id} "
                f"internal_id={internal_id} → enqueued"
            )
    return fired
