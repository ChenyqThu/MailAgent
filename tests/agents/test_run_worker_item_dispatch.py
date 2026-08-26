"""AgentRunWorker 的 `matter_item_run` 分派（task 08-25 批次 3，Lane 2）。

覆盖：认领 CAS（含 owner 抢先取消 → aborted）/ 交付后的终态映射 / **一轮跑完没交付 →
`no_report`** / transport 失败收敛（已交付过的不动）/ 兜底 except 不悬挂 / 启动扫尾。
gateway 全靠 mock httpx（同 `test_run_worker_matter.py`）。

🔴 与跟进 run 的**有意不同**：派发**没有**便宜比对短路 —— 它是 owner 显式按下的动作，
「这轮没什么变化」不是跳过它的理由。
"""

from __future__ import annotations

import asyncio

import pytest

import src.agents.run_worker as run_worker
from src.agents.run_worker import AgentRunWorker
from src.mail.sync_store import SyncStore
from src.matters.models import MatterItemDispatchState
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def env(tmp_path):
    db = tmp_path / "item-worker.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    service = MatterRunService(MatterRepository(db))
    matter = service.create_matter(
        {"title": "Worker Matter"}, idempotency_key="m", source="desktop_ui"
    )
    public_id = str(matter["matter"]["public_id"])
    item = service.create_item(
        public_id,
        {"kind": "action", "title": "回签补充协议"},
        expected_version=matter["version"],
        idempotency_key="i",
        source="desktop_ui",
    )
    return repo, service, public_id, int(item["item"]["id"])


def _dispatch_and_claim(repo, service, public_id, item_id, key="d1"):
    dispatch = service.dispatch_item(
        public_id, item_id, idempotency_key=key, source="desktop_ui"
    )["dispatch"]
    job = repo.claim_next(types=repo.AGENT_JOB_TYPES)
    assert job is not None and job.job_type == "matter_item_run"
    return int(dispatch["id"]), job


def _state(service, dispatch_id: int) -> dict:
    with service.repository.connect() as conn:
        return service.repository.get_dispatch(conn, dispatch_id)


class _FakeResp:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


def _patch_client(monkeypatch, *, resp=None, on_poke=None, raise_exc=None):
    calls = []

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            calls.append({"url": url, "json": json})
            if raise_exc is not None:
                raise raise_exc
            if on_poke is not None and url.endswith("/api/ai/agent-run"):
                on_poke()
            return resp if resp is not None else _FakeResp(200, {"ok": True})

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)
    return calls


def _pokes(calls):
    return [c for c in calls if c["url"].endswith("/api/ai/agent-run")]


def _run(coro):
    return asyncio.run(coro)


def test_claim_marks_the_dispatch_running_and_pokes_the_gateway(env, monkeypatch):
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    seen = {}

    def during_poke():
        seen["state"] = _state(service, dispatch_id)["state"]
        service.report_item_dispatch(public_id, dispatch_id, {"summary": "查完了"})

    calls = _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": True, "outcome": "completed", "sessionId": 7, "steps": 3}),
        on_poke=during_poke,
    )
    _run(AgentRunWorker(repo=repo)._execute(job))

    # 🔴 派发**恒执行**：没有便宜比对短路，poke 必然发生一次。
    assert len(_pokes(calls)) == 1
    assert seen["state"] == MatterItemDispatchState.RUNNING.value
    row = _state(service, dispatch_id)
    assert row["async_job_id"] == job.job_id
    assert row["state"] == MatterItemDispatchState.PROPOSED.value
    job_row = repo.get(job.job_id)
    assert job_row.status == "succeeded"
    assert job_row.result["itemDispatchState"] == MatterItemDispatchState.PROPOSED.value
    assert job_row.result["updateId"] == row["update_id"]
    assert job_row.result["sessionId"] == 7


def test_completed_without_a_report_fails_the_dispatch(env, monkeypatch):
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    _patch_client(monkeypatch, resp=_FakeResp(200, {"ok": True, "outcome": "completed"}))

    _run(AgentRunWorker(repo=repo)._execute(job))

    # run 本身没报错，但这条行动项什么也没等到 —— 不许静默留在 running。
    row = _state(service, dispatch_id)
    assert row["state"] == MatterItemDispatchState.FAILED.value
    assert row["error"] == {"code": "no_report"}
    assert row["ended_at"] is not None
    assert repo.get(job.job_id).result["itemDispatchState"] == "failed"


def test_needs_input_delivery_is_not_a_failure(env, monkeypatch):
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": True, "outcome": "completed"}),
        on_poke=lambda: service.report_item_dispatch(
            public_id, dispatch_id, {"needs_input": {"question": "用哪个主体？"}}
        ),
    )

    _run(AgentRunWorker(repo=repo)._execute(job))

    assert _state(service, dispatch_id)["state"] == (
        MatterItemDispatchState.AWAITING_INPUT.value
    )
    assert repo.get(job.job_id).status == "succeeded"


def test_gateway_error_converges_both_the_job_and_the_dispatch(env, monkeypatch):
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    _patch_client(
        monkeypatch,
        resp=_FakeResp(
            200,
            {
                "ok": False,
                "outcome": "error",
                "error": "E_BUDGET_TIME",
                "errorMessage": "run aborted (budget deadline)",
            },
        ),
    )

    _run(AgentRunWorker(repo=repo)._execute(job))

    row = _state(service, dispatch_id)
    assert row["state"] == MatterItemDispatchState.FAILED.value
    assert row["error"]["code"] == "E_BUDGET_TIME"
    assert "budget deadline" in row["error"]["message"]
    assert repo.get(job.job_id).last_error == "E_BUDGET_TIME"


def test_transport_failure_after_a_delivery_leaves_the_delivery_alone(env, monkeypatch):
    """0813 dogfood #17 同旨：交付已经落了，drain 收尾报错不该把它推回失败。"""
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)

    def deliver_then_die():
        service.report_item_dispatch(public_id, dispatch_id, {"summary": "查完了"})
        raise run_worker.httpx.ReadTimeout("boom")

    _patch_client(monkeypatch, on_poke=deliver_then_die)

    _run(AgentRunWorker(repo=repo)._execute(job))

    assert _state(service, dispatch_id)["state"] == MatterItemDispatchState.PROPOSED.value
    assert repo.get(job.job_id).last_error == "E_RUN_TIMEOUT"


def test_owner_cancelled_before_claim_aborts_the_job(env, monkeypatch):
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    service.cancel_dispatch(
        public_id, dispatch_id, idempotency_key="c1", source="desktop_ui"
    )
    calls = _patch_client(monkeypatch)

    _run(AgentRunWorker(repo=repo)._execute(job))

    assert _pokes(calls) == []  # 取消了就不烧这一轮 token
    job_row = repo.get(job.job_id)
    assert job_row.status == "aborted"
    assert job_row.result["reason"] == "dispatch_already_terminal"
    assert _state(service, dispatch_id)["state"] == MatterItemDispatchState.CANCELED.value


def test_missing_dispatch_row_fails_the_job_without_hanging(env, monkeypatch):
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    with service.repository.transaction() as conn:
        conn.execute("DELETE FROM matter_item_dispatch WHERE id=?", (dispatch_id,))
    calls = _patch_client(monkeypatch)

    _run(AgentRunWorker(repo=repo)._execute(job))

    assert _pokes(calls) == []
    assert repo.get(job.job_id).last_error == "E_ITEM_DISPATCH_MISSING"


def test_startup_sweep_converges_orphaned_dispatches(env, monkeypatch):
    """job 已 failed（进程被杀）而派发仍活跃 → failed，且**绝不 requeue**。"""
    repo, service, public_id, item_id = env
    dispatch_id, job = _dispatch_and_claim(repo, service, public_id, item_id)
    assert service.mark_dispatch_started(dispatch_id, async_job_id=job.job_id)
    repo.mark_terminal(job.job_id, status="failed", last_error="E_ORPHANED")

    AgentRunWorker(repo=repo)._recover_item_dispatches()

    row = _state(service, dispatch_id)
    assert row["state"] == MatterItemDispatchState.FAILED.value
    assert row["error"] == {"code": "claim_expired"}
    assert repo.claim_next(types=repo.AGENT_JOB_TYPES) is None
