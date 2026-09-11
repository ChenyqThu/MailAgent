"""闸 —— async_jobs 维护族 job_type 的 Python ↔ TypeScript 同口径。

两处手抄同一份枚举:

  1. ``src/sync/job_runners.py::JOB_TYPES`` (= runner registry = ``MAINTENANCE_JOB_TYPES``)
     —— 后端据它收 ``POST /api/jobs`` 的 enqueue, 不在集合里直接 400;
  2. ``frontend/src/shared/api/types/jobs.ts`` 的 ``JobType`` 联合类型 —— 前端据它标注
     任务进度 / 终态。

漏一个值的后果是**静默**的: 后端新增的任务类型在 TS 联合里不存在, 前端拿到这类 job 时
类型层面根本不承认它 (收窄后的 switch 少一支 / 被 `as` 断言吞掉), typecheck 与后端测试
两边都不会红。多一个值则相反 —— 前端以为能起某种任务, 后端 400。

🔴 抽取失败必须红: 抽不到联合类型就断言失败, 绝不返回空集合与空集合比较装绿
(部分抽取比抽不到更毒 —— 见 architecture-internals「跨语言手抄常量的一致性闸」)。
"""

from __future__ import annotations

import re
from pathlib import Path

from src.sync.async_jobs import AsyncJobRepository
from src.sync.job_runners import JOB_TYPES

ROOT = Path(__file__).resolve().parents[2]
TS_JOBS = ROOT / "frontend/src/shared/api/types/jobs.ts"

#: ``export type JobType = 'resync' | 'backfill_body' | ...`` (单行联合)。
TS_UNION_RE = re.compile(r"export type JobType\s*=([^\n]+)")
QUOTED = re.compile(r"'([^']+)'")


def _extract_ts_job_types() -> frozenset[str]:
    source = TS_JOBS.read_text(encoding="utf-8")
    match = TS_UNION_RE.search(source)
    assert match is not None, (
        f"{TS_JOBS.name}: 没找到 `export type JobType =` —— 联合类型被改写了, "
        "更新这道闸的解析器 (不要让它抽空集合装绿)"
    )
    values = QUOTED.findall(match.group(1))
    assert values, f"{TS_JOBS.name}: JobType 联合抽取结果为空 —— 解析器坏了"
    # canary: 最老的那个值必须在, 抓到的若是别的 union 就立刻暴露。
    assert "resync" in values, (
        f"{TS_JOBS.name}: 抽取 canary 失败 (没抓到 'resync') —— 解析器可能配到了别的类型"
    )
    return frozenset(values)


def test_ts_job_type_union_matches_backend_registry() -> None:
    """TS ``JobType`` == 后端 runner registry。"""
    assert _extract_ts_job_types() == JOB_TYPES


def test_runner_registry_is_the_maintenance_family() -> None:
    """闸的后端一侧钉在维护族上: 公共 REST 只收这一族, 前端也只会见到这一族。

    (agent 族由 AgentRunWorker 独占, 无 runner 分支、不经公共 enqueue, 所以**不该**
    出现在 TS 的 JobType 里。)
    """
    assert JOB_TYPES == AsyncJobRepository.MAINTENANCE_JOB_TYPES
    assert not (JOB_TYPES & AsyncJobRepository.AGENT_JOB_TYPES)
