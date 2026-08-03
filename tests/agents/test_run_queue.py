"""enqueue_agent_run 单测（S4 W1, ADR D4/D7）—— runs/day 门 + 幂等 + target 约定。"""
from __future__ import annotations

import ast
import inspect

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


def test_runs_per_day_gate_records_visible_skipped_row(repo):
    budget = Budget(max_runs_per_day=2)
    assert enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=budget) is not None
    assert enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k2", budget=budget) is not None
    # 第三次超 max_runs_per_day=2 → 写审计行但不进入 worker 队列。
    third = enqueue_agent_run(
        repo, agent_id="a1", trigger_kind="cron", fire_key="k3", budget=budget
    )
    skipped = repo.get(third[0])
    assert skipped.status == "succeeded"
    assert skipped.result == {
        "outcome": "skipped",
        "reason": "daily_run_limit",
        "runsToday": 2,
        "maxRunsPerDay": 2,
        "steps": 0,
    }
    # skipped 审计行不占额度；账本总行数为 3。
    assert repo.count_agent_runs_since("a1", 0) == 2
    assert len(repo.list_agent_runs(agent_id="a1")) == 3


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


def test_sync_atomicity_invariant():
    """守护 runs/day 门的「同步原子性不变量」（codex S4 终审 P3 finding）。

    runs/day 门是 check-then-act（count → enqueue 无事务），当前无竞态完全依赖
    enqueue_agent_run 保持同步函数、体内无 await point —— 两触发方（cron tick_loop /
    email dispatch 同 loop 后台 task）在同一 event loop 串行调用，count+enqueue 原子执行。
    本测试红了 = 有人把它转 async / 在 count 与 enqueue 之间引入了 await point，
    须按 run_queue.py 门旁注释的失效条件改「单 DB 事务内 count+INSERT（BEGIN IMMEDIATE CAS）」。
    用 ast 解析（非字符串匹配）——注释/docstring 里提到 await 不误伤。
    """
    assert inspect.iscoroutinefunction(enqueue_agent_run) is False
    tree = ast.parse(inspect.getsource(enqueue_agent_run))
    assert isinstance(tree.body[0], ast.FunctionDef)  # 非 AsyncFunctionDef
    offenders = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.Await, ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith))
    ]
    assert offenders == [], "enqueue_agent_run 引入了 await point，同步原子性不变量已破"


# =============================================================================
# 预算跳过的 CAS（08-02 review F6）—— 抢跑的 run 不得被记成 skipped
# =============================================================================


def test_budget_skip_does_not_clobber_a_claimed_run(repo):
    """enqueue 与「标 skipped」之间 worker 抢先 claim → 跳过标记必须写不进去。

    没有 CAS 时这里会把一个**正在执行**的 run 记成「未执行」，随后 worker 的终态写再覆盖回来，
    历史与事实两次相反。
    """
    budget = Budget(max_runs_per_day=1)
    first = enqueue_agent_run(
        repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=budget
    )
    assert first is not None

    # 第二次入队会超限。模拟「入队后、标 skipped 前」被 AgentRunWorker 抢走：
    # 先手工把新行推进到 running，再让预算路径尝试覆盖。
    real_mark_terminal = repo.mark_terminal
    claimed: dict = {}

    def _claim_then_mark(job_id, **kwargs):
        if not claimed:
            claimed["job_id"] = job_id
            # 模拟并发 worker：把这一行 claim 成 running。
            conn = repo._connect()
            try:
                conn.execute(
                    "UPDATE async_jobs SET status='running' WHERE job_id=?", (job_id,)
                )
                conn.commit()
            finally:
                conn.close()
        return real_mark_terminal(job_id, **kwargs)

    repo.mark_terminal = _claim_then_mark  # type: ignore[method-assign]
    second = enqueue_agent_run(
        repo, agent_id="a1", trigger_kind="cron", fire_key="k2", budget=budget
    )
    repo.mark_terminal = real_mark_terminal  # type: ignore[method-assign]

    job_id, _ = second
    assert claimed["job_id"] == job_id
    job = repo.get(job_id)
    assert job is not None
    # 抢跑方赢：行仍是 running，没有被伪造成 succeeded+skipped。
    assert job.status == "running"
    assert not (isinstance(job.result, dict) and job.result.get("outcome") == "skipped")


def test_budget_skip_still_records_when_unclaimed(repo):
    """常态（无人抢跑）下跳过标记照常写入 —— CAS 不能把正常路径也挡掉。"""
    budget = Budget(max_runs_per_day=1)
    enqueue_agent_run(repo, agent_id="a1", trigger_kind="cron", fire_key="k1", budget=budget)
    job_id, _ = enqueue_agent_run(
        repo, agent_id="a1", trigger_kind="cron", fire_key="k2", budget=budget
    )
    job = repo.get(job_id)
    assert job is not None
    assert job.status == "succeeded"
    assert job.result["outcome"] == "skipped"
    assert job.result["reason"] == "daily_run_limit"
    # skipped 行不占额度（否则超限后每次触发都会把额度越推越远）。
    assert repo.count_agent_runs_since("a1", 0) == 1
