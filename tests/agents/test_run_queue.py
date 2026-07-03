"""enqueue_agent_run 单测（S4 W1, ADR D4/D7）—— runs/day 门 + 幂等 + target 约定。"""
from __future__ import annotations

import pytest

from src.agents.run_queue import enqueue_agent_run
from src.agents.trigger import Budget
from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def repo(tmp_path):
    db = tmp_path / "s.db"
    SyncStore(str(db))
    return AsyncJobRepository(str(db))


def test_enqueue_creates_agent_run(repo):
    res = enqueue_agent_run(
        repo, agent_id="a1", trigger_kind="cron", fire_key="20260703T090000Z",
        budget=Budget(),
    )
    assert res is not None
    job_id, created = res
    assert created is True
    job = repo.get(job_id)
    assert job.job_type == "agent_run"
    assert job.target_kind == "agent"
    assert job.target_key == "a1"
    assert job.params["trigger_kind"] == "cron"


def test_idempotent_same_fire_key_dedups(repo):
    r1 = enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=Budget())
    r2 = enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=Budget())
    assert r1[0] == r2[0]        # 同一 job_id
    assert r1[1] is True and r2[1] is False
    assert repo.count_agent_runs_since("a1", 0) == 1  # 只一行


def test_different_fire_key_new_job(repo):
    r1 = enqueue_agent_run(repo, agent_id="a1", trigger_kind="email_filter", fire_key="100", budget=Budget())
    r2 = enqueue_agent_run(repo, agent_id="a1", trigger_kind="email_filter", fire_key="101", budget=Budget())
    assert r1[0] != r2[0]
    assert repo.count_agent_runs_since("a1", 0) == 2


def test_runs_per_day_gate_blocks_over_budget(repo):
    budget = Budget(max_runs_per_day=2)
    assert enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=budget) is not None
    assert enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k2", budget=budget) is not None
    # 第三次超 max_runs_per_day=2 → 被拦（None），不入队。
    assert enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k3", budget=budget) is None
    assert repo.count_agent_runs_since("a1", 0) == 2


def test_budget_gate_per_agent_isolated(repo):
    budget = Budget(max_runs_per_day=1)
    assert enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=budget) is not None
    # 另一个 agent 有自己的预算额度。
    assert enqueue_agent_run(repo, agent_id="a2", trigger_kind="cron", fire_key="k1", budget=budget) is not None
    assert repo.count_agent_runs_since("a1", 0) == 1
    assert repo.count_agent_runs_since("a2", 0) == 1


def test_params_carry_extra(repo):
    res = enqueue_agent_run(
        repo, agent_id="a1", trigger_kind="email_filter", fire_key="555",
        budget=Budget(), params={"email_internal_id": 555},
    )
    job = repo.get(res[0])
    assert job.params["email_internal_id"] == 555
    assert job.params["agent_id"] == "a1"
