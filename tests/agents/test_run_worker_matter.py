"""AgentRunWorker 的 matter_followup 分派（Matters P4, D3/D4）。

覆盖：noop 短路不 poke / 终态四值映射（ok/noop/warn/fail）
/ cancel 收敛 canceled / 孤儿收敛。gateway 全靠 mock httpx（同 test_run_worker.py）。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

import src.agents.run_worker as run_worker
from src.agents.run_worker import AgentRunWorker
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def env(tmp_path, monkeypatch):
    db = tmp_path / "matter-worker.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    service = MatterRunService(MatterRepository(db))
    created = service.create_matter(
        {"title": "Worker Matter"}, idempotency_key="create", source="desktop_ui"
    )
    pid = created["matter"]["public_id"]
    linked = service.add_resource(
        pid,
        {"provider": "mailagent", "external_key": "doc:d1", "kind": "doc"},
        expected_version=created["version"], idempotency_key="link",
        source="desktop_ui",
    )
    return repo, service, pid, linked["version"]


def _enqueue_and_claim(service, repo, pid, version, key="r1"):
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key=key, source="desktop_ui"
    )["run"]
    job = repo.claim_next(types=repo.AGENT_JOB_TYPES)
    assert job is not None and job.job_id == run["async_job_id"]
    return run, job


class _FakeResp:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


def _patch_client(monkeypatch, *, resp=None, on_poke=None):
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
            if on_poke is not None and url.endswith("/api/ai/agent-run"):
                on_poke()
            return resp if resp is not None else _FakeResp(200, {"ok": True})

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)
    return calls


def _pokes(calls):
    return [c for c in calls if c["url"].endswith("/api/ai/agent-run")]


def _run(coro):
    return asyncio.run(coro)


def test_noop_short_circuit_does_not_poke_gateway(env, monkeypatch):
    repo, service, pid, version = env
    # 第一轮完成并落 output_watermark = 当前指纹 → 第二轮无变化
    first, first_job = _enqueue_and_claim(service, repo, pid, version)
    assert service.mark_started(first["id"])
    current = service.current_watermark(first["matter_id"])
    service.finish_run(first["id"], "ok", output_watermark=current)
    repo.mark_terminal(first_job.job_id, status="succeeded")

    second, job = _enqueue_and_claim(service, repo, pid, version, key="r2")
    calls = _patch_client(monkeypatch)
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    job_row = repo.get(job.job_id)
    assert job_row.status == "succeeded"
    assert job_row.result == {"outcome": "noop"}
    row = service.get_run(second["id"])
    assert row["status"] == "noop"
    assert row["started_at"] is None  # noop 短路：从未 started
    assert row["output_watermark_json"] is not None
    assert _pokes(calls) == []  # 🔴 不 poke gateway、零 LLM token


def test_completed_with_proposal_maps_ok(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def propose():
        service.propose_update(pid, run["id"], {"summary": "有发现", "changes": []})

    calls = _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": True, "outcome": "completed", "sessionId": 42, "steps": 5,
                             "usage": {"input": 10}}),
        on_poke=propose,
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    job_row = repo.get(job.job_id)
    assert job_row.status == "succeeded"
    assert job_row.result["matterRunStatus"] == "ok"
    assert job_row.result["updateId"] is not None
    row = service.get_run(run["id"])
    assert row["status"] == "ok"
    assert row["chat_session_id"] == 42
    assert row["output_watermark_json"] is not None
    assert len(_pokes(calls)) == 1


def test_completed_without_proposal_maps_noop(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)
    _patch_client(monkeypatch, resp=_FakeResp(200, {"ok": True, "outcome": "completed"}))
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    assert repo.get(job.job_id).status == "succeeded"
    assert service.get_run(run["id"])["status"] == "noop"


def test_completed_with_dropped_changes_maps_warn(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def propose():
        result = service.propose_update(
            pid, run["id"],
            {
                "summary": "有发现但有幻觉",
                "changes": [
                    {"id": "chg_01", "kind": "fact", "text": "无源", "sources": []},
                ],
            },
        )
        assert result["dropped"]

    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": True, "outcome": "completed"}),
        on_poke=propose,
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    assert repo.get(job.job_id).result["matterRunStatus"] == "warn"
    assert service.get_run(run["id"])["status"] == "warn"


def test_gateway_error_maps_fail(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)
    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": False, "outcome": "error", "error": "E_BUDGET_TIME"}),
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    job_row = repo.get(job.job_id)
    assert job_row.status == "failed"
    assert job_row.last_error == "E_BUDGET_TIME"
    row = service.get_run(run["id"])
    assert row["status"] == "fail"
    assert "E_BUDGET_TIME" in (row["error_json"] or "")


def test_stream_error_after_proposal_maps_warn_not_fail(env, monkeypatch):
    """0813 dogfood #17 —— 提案已交出、drain 收尾报错 ⇒ warn（降级完成），不是 fail。

    活库实证：run 4 交出 update 6（owner 事后还接受了）之后 17s 才报 E_AGENT，旧映射把它
    记成「运行失败」，agenda worker 顺带开一条 critical 信号。
    """
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def propose():
        service.propose_update(pid, run["id"], {"summary": "有发现", "changes": []})

    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {
            "ok": False, "outcome": "error", "error": "E_AGENT",
            "errorMessage": "stream closed unexpectedly", "sessionId": 149, "steps": 12,
        }),
        on_poke=propose,
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    row = service.get_run(run["id"])
    assert row["status"] == "warn"
    assert row["completed_at"] is not None
    assert row["chat_session_id"] == 149
    # 提案覆盖的就是这个指纹 → 下一轮便宜比对从这里起算（同 completed 分支）。
    assert row["output_watermark_json"] is not None
    # 病因留在 run 上：码 + gateway 透传的原文（此前只进 console.error，打包 app 里哪儿都不去）。
    assert "E_AGENT" in (row["error_json"] or "")
    assert "stream closed unexpectedly" in (row["error_json"] or "")
    # async job 记的是「这次 gateway 调用出错了」，与「这轮产出了什么」是两件事，各自如实。
    job_row = repo.get(job.job_id)
    assert job_row.status == "failed"
    assert job_row.last_error == "E_AGENT"
    assert job_row.result["matterRunStatus"] == "warn"
    assert job_row.result["updateId"] is not None


def test_transport_failure_after_proposal_maps_warn_without_watermark(env, monkeypatch):
    """poke 侧异常（超时/非 2xx）同判：有提案 → warn。但**不写 output_watermark** ——
    连响应都没拿到，无从断言这轮已看完当前指纹，留给下一轮重新比对。"""
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def propose():
        service.propose_update(pid, run["id"], {"summary": "有发现", "changes": []})

    class _Boom:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            propose()
            raise run_worker.httpx.TimeoutException("boom")

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _Boom)
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    row = service.get_run(run["id"])
    assert row["status"] == "warn"
    assert row["output_watermark_json"] is None
    assert "E_RUN_TIMEOUT" in (row["error_json"] or "")
    assert repo.get(job.job_id).status == "failed"


def test_cancel_requested_converges_canceled(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def request_cancel():
        with service.repository.transaction() as conn:
            conn.execute(
                "UPDATE matter_run SET cancel_requested_at=1 WHERE id=?", (run["id"],)
            )

    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": False, "outcome": "error", "error": "E_RUN_STOPPED"}),
        on_poke=request_cancel,
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    assert repo.get(job.job_id).status == "aborted"
    row = service.get_run(run["id"])
    assert row["canceled_at"] is not None
    assert row["status"] is None  # D3：canceled 时 status 保持 NULL
    assert row["completed_at"] is None


def test_second_active_run_cas_fails_with_run_active(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)
    # 另一条 run 已 started（直接插行绕过 enqueue 单活跃检查）→ CAS 必撞 partial unique
    with service.repository.transaction() as conn:
        conn.execute(
            "INSERT INTO matter_run(matter_id,trigger_kind,idempotency_key,"
            "queued_at,started_at,created_at) VALUES (?,?,?,?,?,?)",
            (run["matter_id"], "manual", "other-active", 1, 2, 1),
        )
    calls = _patch_client(monkeypatch)
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    assert repo.get(job.job_id).last_error == "E_RUN_ACTIVE"
    assert service.get_run(run["id"])["status"] == "fail"
    assert _pokes(calls) == []


# ---------------------------------------------------------------------------
# 通知中心：matter_followup 硬失败（无提案）→ results/warn
# （task 08-20-notification-center M2 信源 ④，design §7 缺口 ④）
# 🔴 warn ≠ failed：提案已交出、只是收尾报错的那轮**有产出**，不发失败通知。
# ---------------------------------------------------------------------------


def _notifications(service):
    conn = sqlite3.connect(str(service.repository.db_path))
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM notification ORDER BY id")]
    finally:
        conn.close()


def test_hard_failure_without_proposal_publishes_warn_notification(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)
    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": False, "outcome": "error", "error": "E_BUDGET_TIME"}),
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    rows = _notifications(service)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "results" and row["severity"] == "warn"
    assert row["source"] == "matter"
    assert row["dedupe_key"] == f"matter_followup_failed:{run['matter_id']}"
    assert "Worker Matter" in row["title"] and "E_BUDGET_TIME" in row["body"]
    assert json.loads(row["payload_json"])["link"] == {"type": "matter", "publicId": pid}


def test_warn_after_proposal_publishes_no_failure_notification(env, monkeypatch):
    """🔴 0813 dogfood #17 的通知面版本：提案已交出 ⇒ 有产出，不得说成失败。"""
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def propose():
        service.propose_update(pid, run["id"], {"summary": "有发现", "changes": []})

    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {
            "ok": False, "outcome": "error", "error": "E_AGENT",
            "errorMessage": "stream closed unexpectedly",
        }),
        on_poke=propose,
    )
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    assert service.get_run(run["id"])["status"] == "warn"  # 前置：这轮记的是 warn
    # 提案那条 reviews 通知照发（信源 ②），失败通知一条都不许有
    assert [r["dedupe_key"] for r in _notifications(service)] == [
        f"matter_update:{service.update_id_for_run(run['id'])}"
    ]


def test_transport_failure_without_proposal_publishes_warn_notification(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    class _Boom:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            raise run_worker.httpx.TimeoutException("boom")

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _Boom)
    worker = AgentRunWorker(repo=repo)
    _run(worker._execute(job))

    assert service.get_run(run["id"])["status"] == "fail"
    rows = _notifications(service)
    assert len(rows) == 1 and "E_RUN_TIMEOUT" in rows[0]["body"]
    assert rows[0]["dedupe_key"] == f"matter_followup_failed:{run['matter_id']}"


def test_worker_crash_publishes_warn_notification(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)
    _patch_client(monkeypatch)
    worker = AgentRunWorker(repo=repo)
    svc = worker._matter_service()
    monkeypatch.setattr(
        svc, "mark_started",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    _run(worker._execute(job))

    assert repo.get(job.job_id).last_error.startswith("E_WORKER_CRASH")
    rows = _notifications(service)
    assert len(rows) == 1
    assert rows[0]["dedupe_key"] == f"matter_followup_failed:{run['matter_id']}"
    assert "E_WORKER_CRASH" in rows[0]["body"]


def test_crash_after_proposal_publishes_no_failure_notification(env, monkeypatch):
    """崩溃兜底那条路径**不看**有没有提案就记 fail —— 通知这一侧必须自己判。

    真实形态就是 0813 dogfood #17 的那一种：提案已经交出去了，收尾阶段才炸。
    """
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)

    def propose():
        service.propose_update(pid, run["id"], {"summary": "有发现", "changes": []})

    _patch_client(
        monkeypatch,
        resp=_FakeResp(200, {"ok": True, "outcome": "completed"}),
        on_poke=propose,
    )
    worker = AgentRunWorker(repo=repo)
    monkeypatch.setattr(
        worker, "_map_matter_response",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    _run(worker._execute(job))

    assert repo.get(job.job_id).last_error.startswith("E_WORKER_CRASH")  # 前置：走的是崩溃路径
    # 提案那条 reviews 通知在，失败通知一条都不许有
    assert [r["dedupe_key"] for r in _notifications(service)] == [
        f"matter_update:{service.update_id_for_run(run['id'])}"
    ]


def test_repeated_failures_of_same_matter_are_counted_not_stacked(env, monkeypatch):
    repo, service, pid, version = env
    for key in ("f1", "f2"):
        _, job = _enqueue_and_claim(service, repo, pid, version, key=key)
        _patch_client(
            monkeypatch,
            resp=_FakeResp(200, {"ok": False, "outcome": "error", "error": "E_AGENT"}),
        )
        _run(AgentRunWorker(repo=repo)._execute(job))

    rows = _notifications(service)
    assert len(rows) == 1  # 同 matter 连败合并成一条
    assert rows[0]["recurrence_no"] == 2


def test_orphan_sweep_converges_failed_job_runs(env, monkeypatch):
    repo, service, pid, version = env
    run, job = _enqueue_and_claim(service, repo, pid, version)
    # 模拟 worker 崩溃后重启：job 被 recover_orphaned_agents 标 failed，run 悬在 queued
    repo.mark_terminal(job.job_id, status="failed", last_error="E_ORPHANED")
    _patch_client(monkeypatch)
    worker = AgentRunWorker(repo=repo)
    worker.stop()  # run() 只做启动扫尾即退出
    _run(worker.run())

    row = service.get_run(run["id"])
    assert row["status"] == "fail"
    assert "E_ORPHANED" in (row["error_json"] or "")
