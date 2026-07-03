"""AsyncJobRepository + job_runners 状态映射单测 (C1 async_jobs 子系统)。

覆盖: enqueue 幂等 / claim 原子 + ASC / progress / mark_terminal / recover_orphaned /
get / job_type 校验 / JOB_TYPES 与 VALID_JOB_TYPES 一致 / summary_to_status 映射。
"""
from __future__ import annotations

import pytest

from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def repo(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # v21 schema (含 async_jobs)
    return AsyncJobRepository(str(db))


# ============================================================
# enqueue — 幂等
# ============================================================

def test_enqueue_creates_new_job(repo):
    job_id, was_created = repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2",
        params={"internal_ids": [1, 2]},
    )
    assert job_id > 0 and was_created is True
    job = repo.get(job_id)
    assert job.status == "queued"
    assert job.job_type == "resync"
    assert job.params == {"internal_ids": [1, 2]}


def test_enqueue_idempotent_same_key_returns_existing(repo):
    j1, c1 = repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1",
        params={"internal_ids": [1]}, idempotency_key="dedup-1",
    )
    j2, c2 = repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1",
        params={"internal_ids": [1]}, idempotency_key="dedup-1",
    )
    assert j1 == j2
    assert c1 is True and c2 is False  # 第二次是 idempotent 去重


def test_enqueue_null_key_always_new(repo):
    j1, _ = repo.enqueue(job_type="backfill_body", target_kind="all", target_key="all")
    j2, _ = repo.enqueue(job_type="backfill_body", target_kind="all", target_key="all")
    assert j1 != j2


def test_enqueue_rejects_unknown_job_type(repo):
    with pytest.raises(ValueError, match="invalid job_type"):
        repo.enqueue(job_type="nope", target_kind="all", target_key="all")


# ============================================================
# claim — 原子 + ASC 顺序
# ============================================================

def test_claim_next_picks_oldest_queued(repo):
    j1, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="a")
    j2, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="b")
    claimed = repo.claim_next()
    assert claimed.job_id == j1
    assert claimed.status == "running"
    assert claimed.started_at is not None
    # 第二次 claim → j2 (j1 已 running)
    assert repo.claim_next().job_id == j2
    # 无更多 queued → None
    assert repo.claim_next() is None


def test_claim_next_none_when_empty(repo):
    assert repo.claim_next() is None


# ============================================================
# progress / terminal
# ============================================================

def test_update_progress_partial_fields(repo):
    job_id, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="a")
    repo.update_progress(job_id, done=3, total=10, checkpoint_internal_id=53674)
    job = repo.get(job_id)
    assert (job.progress_done, job.progress_total, job.checkpoint_internal_id) == (3, 10, 53674)
    # total / checkpoint 为 None 时保留旧值 (COALESCE)
    repo.update_progress(job_id, done=5)
    job = repo.get(job_id)
    assert (job.progress_done, job.progress_total, job.checkpoint_internal_id) == (5, 10, 53674)


def test_mark_terminal_writes_status_result(repo):
    job_id, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="a")
    repo.mark_terminal(job_id, status="succeeded", result={"succeeded": 2, "failed": 0})
    job = repo.get(job_id)
    assert job.status == "succeeded"
    assert job.result == {"succeeded": 2, "failed": 0}
    assert job.finished_at is not None


def test_mark_terminal_rejects_non_terminal_status(repo):
    job_id, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="a")
    with pytest.raises(ValueError, match="invalid terminal status"):
        repo.mark_terminal(job_id, status="running")


# ============================================================
# recover_orphaned — crash resume 前置
# ============================================================

def test_recover_orphaned_resets_running_to_queued(repo):
    j1, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="a")
    claimed = repo.claim_next()  # j1 → running
    assert claimed.status == "running"
    n = repo.recover_orphaned()
    assert n == 1
    job = repo.get(j1)
    assert job.status == "queued"
    # recover 后可再次 claim (从 checkpoint 续跑场景)
    assert repo.claim_next().job_id == j1


def test_recover_orphaned_noop_when_none_running(repo):
    repo.enqueue(job_type="resync", target_kind="ids", target_key="a")  # queued only
    assert repo.recover_orphaned() == 0


# ============================================================
# get
# ============================================================

def test_get_missing_returns_none(repo):
    assert repo.get(99999) is None


# ============================================================
# 跨模块一致性 + 状态映射
# ============================================================

def test_job_types_match_runner_registry():
    """S4 D1 分区后: job_runners.JOB_TYPES(=runner registry) 必须与 MAINTENANCE_JOB_TYPES
    逐一致 (run_job 只处理维护族); agent_run 在 AGENT_JOB_TYPES, 无 runner 分支。"""
    from src.sync.job_runners import JOB_TYPES
    assert AsyncJobRepository.MAINTENANCE_JOB_TYPES == JOB_TYPES
    # 并集 = 维护 ∪ agent, 且两族不相交 (分区不变式)。
    assert AsyncJobRepository.VALID_JOB_TYPES == (
        AsyncJobRepository.MAINTENANCE_JOB_TYPES | AsyncJobRepository.AGENT_JOB_TYPES
    )
    assert not (
        AsyncJobRepository.MAINTENANCE_JOB_TYPES & AsyncJobRepository.AGENT_JOB_TYPES
    )
    # agent_run 不在 runner registry (run_job 无分支, 公共 REST 自动拒)。
    assert "agent_run" not in JOB_TYPES


@pytest.mark.parametrize(
    "succeeded,failed,aborted,max_failures_hit,expected",
    [
        (5, 0, False, False, "succeeded"),
        (3, 2, False, False, "partial_failure"),
        (0, 5, False, False, "failed"),
        (3, 1, True, False, "aborted"),       # 协作式/SIGINT 中止优先于 partial
        (3, 5, False, True, "failed"),         # max_failures 熔断 → failed
        (0, 0, False, False, "succeeded"),     # 空 job
    ],
)
def test_summary_to_status(succeeded, failed, aborted, max_failures_hit, expected):
    from src.cli.long_task import LongTaskSummary
    from src.sync.job_runners import summary_to_status

    summary = LongTaskSummary(
        total=succeeded + failed, succeeded=succeeded, failed=failed,
        aborted=aborted, max_failures_hit=max_failures_hit,
    )
    assert summary_to_status(summary) == expected


# ============================================================
# S4 D1 job_type 两族分区 (claim 过滤 / 孤儿分家 / count)
# ============================================================

def test_claim_next_families_are_invisible_to_each_other(repo):
    """维护 worker claim 看不到 agent_run, agent worker claim 看不到维护 job。"""
    m, _ = repo.enqueue(job_type="resync", target_kind="ids", target_key="m")
    a, _ = repo.enqueue(job_type="agent_run", target_kind="agent", target_key="a1")
    # 默认 (维护族) claim → 只拿到维护 job, 不碰 agent_run。
    claimed = repo.claim_next()
    assert claimed.job_id == m
    assert repo.claim_next() is None  # 维护族已空 (agent_run 不可见)
    # agent 族 claim → 拿到 agent_run。
    a_claim = repo.claim_next(types=AsyncJobRepository.AGENT_JOB_TYPES)
    assert a_claim.job_id == a
    assert a_claim.job_type == "agent_run"


def test_claim_next_empty_family_returns_none(repo):
    repo.enqueue(job_type="resync", target_kind="ids", target_key="m")
    # 空族过滤 → None (不误 claim, 不 IN () 语法错)。
    assert repo.claim_next(types=frozenset()) is None


def test_recover_orphaned_maintenance_requeues(repo):
    repo.enqueue(job_type="resync", target_kind="ids", target_key="m")
    claimed = repo.claim_next()  # → running
    assert claimed.status == "running"
    n = repo.recover_orphaned()
    assert n == 1  # 返回维护族重置数
    assert repo.get(claimed.job_id).status == "queued"  # 维护孤儿 → 重新排队


def test_recover_orphaned_agent_run_fails_never_requeue(repo):
    """agent_run 孤儿 → failed('E_ORPHANED'), 绝不 requeue (LLM run 非幂等, D4 fail-closed)。"""
    a, _ = repo.enqueue(job_type="agent_run", target_kind="agent", target_key="a1")
    claimed = repo.claim_next(types=AsyncJobRepository.AGENT_JOB_TYPES)  # → running
    assert claimed.status == "running"
    n = repo.recover_orphaned()
    assert n == 0  # 维护族无孤儿 (返回值只计维护族)
    job = repo.get(a)
    assert job.status == "failed"
    assert job.last_error == "E_ORPHANED"
    assert job.finished_at is not None
    # 不会被 agent 族 claim 重新捡起 (已终态)。
    assert repo.claim_next(types=AsyncJobRepository.AGENT_JOB_TYPES) is None


def test_recover_orphaned_mixed_families(repo):
    repo.enqueue(job_type="resync", target_kind="ids", target_key="m")
    a, _ = repo.enqueue(job_type="agent_run", target_kind="agent", target_key="a1")
    repo.claim_next()                                             # 维护 → running
    repo.claim_next(types=AsyncJobRepository.AGENT_JOB_TYPES)     # agent → running
    n = repo.recover_orphaned()
    assert n == 1  # 只维护族重置计入返回
    # 维护 → queued, agent → failed。
    statuses = {j.job_type: j.status for j in (repo.get(1), repo.get(2))}
    assert statuses["resync"] == "queued"
    assert statuses["agent_run"] == "failed"


def test_agent_run_enqueue_accepted(repo):
    # agent_run 现在是 VALID (AGENT 族), repo.enqueue 直接接受 (公共 REST 另有闸拒)。
    job_id, created = repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key="a1",
        params={"agent_id": "a1"},
    )
    assert created is True
    assert repo.get(job_id).job_type == "agent_run"


def test_count_agent_runs_since(repo):
    import time as _t
    t0 = _t.time()
    repo.enqueue(job_type="agent_run", target_kind="agent", target_key="a1", idempotency_key="k1")
    repo.enqueue(job_type="agent_run", target_kind="agent", target_key="a1", idempotency_key="k2")
    repo.enqueue(job_type="agent_run", target_kind="agent", target_key="a2", idempotency_key="k3")
    assert repo.count_agent_runs_since("a1", t0) == 2  # 按 target_key 隔离
    assert repo.count_agent_runs_since("a2", t0) == 1
    assert repo.count_agent_runs_since("a1", _t.time() + 10) == 0  # 未来窗口 → 0
