"""AgentRunWorker 单测（S4 W2, ADR D1/D4）—— poke gateway 五路径终态 + 永不悬挂 running。

gateway 端点 W3 才存在 → 全靠 mock httpx.AsyncClient。断言 async_jobs 终态 + claim_token 写入。
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

import src.agents.run_worker as run_worker
from src.agents.run_worker import AgentRunWorker
from src.mail.sync_store import SyncStore
from src.reports.store import ReportStore
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def env(tmp_path):
    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    store = ReportStore(str(db))
    store.create_agent("dms", type="custom", enabled=True, title="DMS")
    return repo, store


def _claim_agent_job(repo: AsyncJobRepository, *, agent_id: str = "dms") -> int:
    """enqueue + claim 一个 agent_run job → running，返回 job_id（worker._execute 的前置态）。"""
    job_id, _ = repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key=agent_id,
        params={"agent_id": agent_id, "trigger_kind": "cron", "fire_key": "20260703T090000Z"},
        idempotency_key=f"agent_run:{agent_id}:20260703T090000Z",
    )
    claimed = repo.claim_next(types=repo.AGENT_JOB_TYPES)
    assert claimed is not None and claimed.job_id == job_id
    return job_id


class _FakeResp:
    def __init__(self, status_code: int, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is _BAD_JSON:
            raise ValueError("not json")
        return self._body


_BAD_JSON = object()


def _patch_client(monkeypatch, *, resp=None, exc=None):
    """把 run_worker.httpx.AsyncClient 换成返回固定响应 / 抛固定异常的假 client。"""

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None):
            if exc is not None:
                raise exc
            return resp

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)


def _run(coro):
    return asyncio.run(coro)


def test_completed_maps_to_succeeded(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client(monkeypatch, resp=_FakeResp(200, {
        "ok": True, "outcome": "completed", "sessionId": 12, "steps": 3,
        "usage": {"input": 100, "output": 40},
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "succeeded"
    assert job.last_error is None
    assert job.result["sessionId"] == 12 and job.result["steps"] == 3
    assert job.result["usage"] == {"input": 100, "output": 40}
    assert "approval_state" not in job.result
    # claim_token 已写入
    assert worker.stats["succeeded"] == 1


def test_paused_handoff_is_succeeded_with_pending_approval(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client(monkeypatch, resp=_FakeResp(200, {
        "ok": True, "outcome": "paused_handoff", "sessionId": 5, "steps": 2,
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    # 「等审批」落 succeeded 但 approval_state=pending（≠ 成功完成，读侧凭此区分）
    assert job.status == "succeeded"
    assert job.result["approval_state"] == "pending"
    assert job.result["outcome"] == "paused_handoff"


def test_gateway_error_outcome_maps_to_failed(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client(monkeypatch, resp=_FakeResp(200, {
        "ok": False, "outcome": "error", "error": "E_BUDGET_TIME",
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "failed"
    assert job.last_error == "E_BUDGET_TIME"


def test_timeout_maps_to_failed_run_timeout(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client(monkeypatch, exc=httpx.ReadTimeout("slow"))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "failed"
    assert job.last_error == "E_RUN_TIMEOUT"


def test_connection_refused_maps_to_gateway_down(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client(monkeypatch, exc=httpx.ConnectError("refused"))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "failed"
    assert job.last_error == "E_GATEWAY_DOWN"


def test_non_2xx_transmits_gateway_error_code(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    # gateway 返 409 + envelope error（spec 类错误回报）→ 透传其 code
    _patch_client(monkeypatch, resp=_FakeResp(409, {"error": {"code": "E_SPEC_ALREADY_CLAIMED"}}))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "failed"
    assert job.last_error == "E_SPEC_ALREADY_CLAIMED"


def test_bad_json_response_maps_to_failed(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client(monkeypatch, resp=_FakeResp(200, _BAD_JSON))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "failed"
    assert job.last_error == "E_GATEWAY_BAD_RESPONSE"


def test_execute_never_leaves_running(env, monkeypatch):
    """set_claim_token 之后任何异常都不留 running（兜底 failed）。"""
    repo, store = env
    job_id = _claim_agent_job(repo)

    # 让 poke 之后的 mark 之外的路径抛未预期异常：patch _map_response 抛。
    _patch_client(monkeypatch, resp=_FakeResp(200, {"ok": True, "outcome": "completed"}))
    worker = AgentRunWorker(repo=repo, store=store)
    monkeypatch.setattr(
        worker, "_map_response",
        lambda resp: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    _run(worker._execute(repo.get(job_id)))

    job = repo.get(job_id)
    assert job.status == "failed"
    assert job.last_error.startswith("E_WORKER_CRASH")


def test_claim_token_written_before_poke(env, monkeypatch):
    """worker 认领后写 claim_token（spec 端点 CAS 校验它）。"""
    repo, store = env
    job_id = _claim_agent_job(repo)
    seen = {}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None):
            seen["claimToken"] = json.get("claimToken")
            seen["jobId"] = json.get("jobId")
            return _FakeResp(200, {"ok": True, "outcome": "completed"})

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    # poke body 带的 claimToken == worker 写进 job 行的 claim_token（spec 端点 CAS 据此校验）
    assert seen["jobId"] == job_id
    assert seen["claimToken"]
    import sqlite3

    conn = sqlite3.connect(str(repo.db_path))
    conn.row_factory = sqlite3.Row
    try:
        stored = conn.execute(
            "SELECT claim_token FROM async_jobs WHERE job_id=?", (job_id,)
        ).fetchone()["claim_token"]
    finally:
        conn.close()
    assert stored == seen["claimToken"]


def test_stop_before_claim_exits_clean(env):
    """stop_event 预置 → run() 立即退出，零 claim（flag-off 时 service.py 根本不启，这是二重保证）。"""
    repo, store = env
    _claim_agent_job(repo)  # 存在一个 running（不应被 recover 成别的族）
    worker = AgentRunWorker(repo=repo, store=store)
    worker.stop()
    _run(worker.run())
    assert worker.stats["claimed"] == 0


# ---------------------------------------------------------------------------
# 灵动岛「运行结果」通知（S5 W1）—— completed/error 发、paused_handoff 不发、失败不阻断
# ---------------------------------------------------------------------------


def _patch_client_capturing(monkeypatch, *, gateway_resp):
    """记录所有 post 调用（按 URL 区分 gateway poke vs island announce）。announce 恒返 200。"""
    calls: list = []

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            calls.append({"url": url, "json": json})
            if url.endswith("/api/ai/agent-run"):
                return gateway_resp
            return _FakeResp(200, {"ok": True})  # island announce 端点

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)
    return calls


def _announce_calls(calls: list) -> list:
    return [c for c in calls if c["url"].endswith("/api/island/agent/announce")]


def test_completed_announces_island_completed(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    calls = _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "completed", "sessionId": 7, "steps": 1,
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    ann = _announce_calls(calls)
    assert len(ann) == 1
    assert ann[0]["json"]["kind"] == "completed"
    assert ann[0]["json"]["sessionId"] == 7
    assert "DMS" in ann[0]["json"]["title"]  # agent 名进 title


def test_error_announces_island_error(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    calls = _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": False, "outcome": "error", "error": "E_BUDGET_TIME",
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    ann = _announce_calls(calls)
    assert len(ann) == 1 and ann[0]["json"]["kind"] == "error"
    assert "E_BUDGET_TIME" in ann[0]["json"]["summary"]


def test_paused_handoff_does_not_announce(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    calls = _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "paused_handoff", "sessionId": 5,
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    # 审批卡链路已 announce（gateway makePersistOnFinish）→ 终态通知不重发（防双卡）
    assert _announce_calls(calls) == []
    assert repo.get(job_id).result["approval_state"] == "pending"  # 终态仍正确


def test_announce_failure_does_not_block_terminal(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            if url.endswith("/api/ai/agent-run"):
                return _FakeResp(200, {"ok": True, "outcome": "completed", "sessionId": 1})
            raise httpx.ConnectError("island down")  # announce POST 失败

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    # 通知失败绝不影响 job 终态（已在 _mark 落库）
    job = repo.get(job_id)
    assert job.status == "succeeded"
    assert job.result["outcome"] == "completed"
