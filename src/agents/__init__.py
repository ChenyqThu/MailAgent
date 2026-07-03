"""Custom Agent 内核（S4）—— 触发引擎 + 事件匹配 + headless run 外壳。

flag ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` 门控（默认关，off → 本包全部不激活）。

W1（本 wave）落地：
  - ``trigger``   : trigger_json 判别式解析/校验（cron | email_filter）+ budget 解析
  - ``matcher``   : ``AgentEmailMatcher`` —— email_filter 邮件事件匹配（泛化 ProjectProgressDetector）
  - ``trigger_worker`` : ``AgentTriggerWorker`` —— cron tick（croniter + UTC marker + DST）

W2+：spec 端点 + ``AgentRunWorker``（认领 → poke gateway）；W3：gateway fresh-spawn drain。
权威规格见 ``.trellis/tasks/07-02-s4-custom-agent-core/adr-003-headless-runner-contract.md``。
"""

from __future__ import annotations

from src.agents.matcher import AgentEmailMatcher
from src.agents.trigger import (
    Budget,
    CronTrigger,
    EmailFilterTrigger,
    Trigger,
    TriggerValidationError,
    parse_budget,
    parse_trigger,
    validate_agent_config_patch,
)

__all__ = [
    "AgentEmailMatcher",
    "Budget",
    "CronTrigger",
    "EmailFilterTrigger",
    "Trigger",
    "TriggerValidationError",
    "parse_budget",
    "parse_trigger",
    "validate_agent_config_patch",
]
