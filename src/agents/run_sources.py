"""团队页 run 历史的「成员 → 执行记录来自哪儿」显式映射 (task 08-27 L4 P4a)。

`GET /api/agent-runs?agentId=X` 原本只查 `async_jobs(job_type='agent_run')`，别的 agent 族
job 全被挡在外面 (research/r8 §A.1 第 1 条)。团队页要按成员列执行记录, 就得知道这个成员
的记录在哪张表、什么条件下能查到 —— 那张表**放后端**, 前端不拼 job_type, 也就不会各拼各的。

🔴 **`target_key` 的语义随 job_type 变**, 这是这块最容易踩的坑 (r8 §A.1 第 2 条):

    job_type              target_key 是什么
    ────────────────────  ────────────────────────────────────────
    agent_run             report_agent.id (自定义 agent 的 id)
    contact_governance    'global' —— 治理是全局的一件事, 不是 per-agent
    matter_followup       'MAT-0005' (事项 public_id)
    matter_item_run       行动项标识

⇒ **不能**拿 agentId 直接当 target_key 去查另一个 job_type。所以这里是一张显式表, 不是
一条「agentId == target_key」的通则。

🔴 **事项域的 run 永不进团队页口径** (design §8.0: 事项跟进 agent 不在团队页, 它的配置在
事项域)。两道:
  ① `matter_followup` / `matter_item_run` 两个 job_type 结构上不在本表里 (没有任何入口能
     解析出它们);
  ② 会话侧的 `matter:` / `matter_item:` 命名空间 (`src/matters/run_spec.py` 写的 agent_id)
     由 `is_matter_scoped()` **显式拒绝** —— 靠「反正也查不到」侥幸不算排除, 哪天默认分支
     换了 job_type 就漏出来了。

没在表里的成员 (报告 / 项目周报 / 预处理 / 搜索 / 主 Agent) 落默认档 = 查 `agent_run` +
target_key=agentId, 结果是空集。这是**如实**的: 它们的记录在各自的表 (`report` /
`project_progress_sync` / `llm_processing`) 或压根没有, 由聚合层各接各的 (design §8.1)。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from src.contacts.governance import CONTACT_GOVERNANCE_JOB_TYPE
from src.contacts.governance_config import CONTACT_GOVERNANCE_AGENT_ID
from src.contacts.profile_config import CONTACT_PROFILE_AGENT_ID

#: 记录来自 `async_jobs` 的一行 (投影经 `_run_history_item`)。
RUN_SOURCE_ASYNC_JOB = "async_job"
#: 记录来自 `contact_profile_run` 台账 (DB v72; 画像不走 async_jobs)。
RUN_SOURCE_CONTACT_PROFILE = "contact_profile"

#: 事项域会话/派发的 agent_id 命名空间 (`src/matters/run_spec.py`)。团队页恒排除。
MATTER_AGENT_ID_PREFIXES = ("matter:", "matter_item:")
#: 事项域的两个 job_type。列在这里是为了让「不进团队页」这件事有个可断言的锚点 ——
#: 本模块任何一条映射都不许产出它们 (`test_no_mapping_yields_matter_job_type` 钉死)。
MATTER_JOB_TYPES = frozenset({"matter_followup", "matter_item_run"})


@dataclass(frozen=True)
class RunSource:
    """一个团队成员的执行记录来自哪儿。

    kind == RUN_SOURCE_ASYNC_JOB   → 用 (job_type, target_key) 查 async_jobs;
    kind == RUN_SOURCE_CONTACT_PROFILE → 查 contact_profile_run 台账 (两个字段恒 None)。
    """

    kind: str
    job_type: Optional[str] = None
    target_key: Optional[str] = None


#: 内建成员的显式映射。默认档 (自定义 agent) 不在表里, 见 `resolve_run_source`。
BUILTIN_RUN_SOURCES: dict[str, RunSource] = {
    CONTACT_GOVERNANCE_AGENT_ID: RunSource(
        RUN_SOURCE_ASYNC_JOB, CONTACT_GOVERNANCE_JOB_TYPE, "global"
    ),
    CONTACT_PROFILE_AGENT_ID: RunSource(RUN_SOURCE_CONTACT_PROFILE),
}


def is_matter_scoped(agent_id: str) -> bool:
    """agent_id 是不是事项域的命名空间 (`matter:MAT-0001` / `matter_item:...`)。"""
    return any(agent_id.startswith(prefix) for prefix in MATTER_AGENT_ID_PREFIXES)


def resolve_run_source(agent_id: str) -> Optional[RunSource]:
    """成员 id → 记录来源。返回 None = **本域没有这个成员**, 调用方给空集不是报错。

    空集而不是 400 的理由: 前端的成员清单与后端的映射表是两处枚举, 拿一个本域不认识的
    id 来查是「查不到」不是「参数非法」—— 报错会让团队页在多一个成员时整栏崩掉。
    """
    if not agent_id or is_matter_scoped(agent_id):
        return None
    builtin = BUILTIN_RUN_SOURCES.get(agent_id)
    if builtin is not None:
        return builtin
    # 默认档 = 自定义 agent (现状不变): async_jobs 里 target_key 就是它的 id。
    return RunSource(RUN_SOURCE_ASYNC_JOB, "agent_run", agent_id)
