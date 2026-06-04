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
    """async_jobs.VALID_JOB_TYPES 必须与 job_runners.JOB_TYPES 逐一致 (两份手抄防漂移)。"""
    from src.sync.job_runners import JOB_TYPES
    assert AsyncJobRepository.VALID_JOB_TYPES == JOB_TYPES


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
