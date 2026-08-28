"""AgentRunWorker 单测（S4 W2, ADR D1/D4）—— poke gateway 五路径终态 + 永不悬挂 running。

gateway 端点 W3 才存在 → 全靠 mock httpx.AsyncClient。断言 async_jobs 终态 + claim_token 写入。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import time

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


def test_contact_governance_terminal_records_suggestion_delta(env, monkeypatch):
    repo, store = env
    job_id, _ = repo.enqueue(
        job_type="contact_governance",
        target_kind="contact_directory",
        target_key="global",
        params={"trigger_kind": "manual"},
        idempotency_key="contact-governance-delta",
    )
    claimed = repo.claim_next(types=repo.AGENT_JOB_TYPES)
    assert claimed is not None and claimed.job_id == job_id
    async def fake_poke(*args, **kwargs):
        with sqlite3.connect(repo.db_path) as conn:
            conn.execute(
                "INSERT INTO contact_suggestion "
                "(type, contact_ids_json, payload_json, evidence_json, evidence_fingerprint, "
                "status, created_at) VALUES ('identity','[1]','{}','[]','fp','pending',1)"
            )
            conn.commit()
        return {"ok": True, "outcome": "completed", "sessionId": 12}

    worker = AgentRunWorker(repo=repo, store=store)
    monkeypatch.setattr(worker, "_poke_gateway", fake_poke)

    async def no_announce(*args, **kwargs):
        return None

    monkeypatch.setattr(worker, "_announce_terminal", no_announce)
    _run(worker._execute(repo.get(job_id)))
    job = repo.get(job_id)
    assert job.status == "succeeded"
    assert job.result["suggestions_created"] == 1


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


# ---------------------------------------------------------------------------
# 通知中心双写（task 08-20-notification-center 步骤 4a, design §7 行 1）
# —— 与岛卡并存：岛瞬时、通知中心落库。契约 category/severity/dedupe_key/deep-link。
# ---------------------------------------------------------------------------


def _notifications(repo: AsyncJobRepository) -> list:
    conn = sqlite3.connect(str(repo.db_path))
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM notification ORDER BY id")]
    finally:
        conn.close()


def test_completed_publishes_result_notification(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "completed", "sessionId": 7, "summary": "跑完了",
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    rows = _notifications(repo)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "results"
    assert row["severity"] == "info"
    assert row["source"] == "agent_run"
    assert row["dedupe_key"] == f"agent_run:{job_id}"  # 成功按 job（每次运行各一条）
    assert row["state"] == "open" and row["read_at"] is None
    assert "DMS" in row["title"] and row["body"] == "跑完了"  # 文案与岛卡同源
    assert json.loads(row["payload_json"])["link"] == {"type": "session", "sessionId": 7}


def test_failed_publishes_warn_notification_keyed_by_agent(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": False, "outcome": "error", "error": "E_BUDGET_TIME",
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    rows = _notifications(repo)
    assert len(rows) == 1
    assert rows[0]["category"] == "results"
    assert rows[0]["severity"] == "warn"
    assert rows[0]["dedupe_key"] == "agent_run_failed:dms"  # 失败按 agent（连败合并计次）
    assert "E_BUDGET_TIME" in rows[0]["body"]
    # 无 sessionId → deep-link 退化到团队页（`/agents` 自 08-27 P3 起无 `?tab=`）
    assert json.loads(rows[0]["payload_json"])["link"] == {"type": "route", "to": "/agents"}


def test_paused_handoff_never_publishes_completed_notification(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "paused_handoff", "sessionId": 5,
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    # 🔴 succeeded + paused_handoff 不是「成功完成」（derive_agent_run_state 口径）——
    # M2 起它落一条「待审批」待办（见 test_paused_pending_publishes_action_required_todo），
    # 但**永不得**落成 results 那条「运行完成」。
    assert [(r["category"], r["dedupe_key"]) for r in _notifications(repo)] == [
        ("action_required", f"agent_run_paused:{job_id}")
    ]
    assert repo.get(job_id).result["approval_state"] == "pending"  # 终态仍正确


def test_contact_governance_notification_lands_in_reviews(env, monkeypatch):
    repo, store = env
    job_id, _ = repo.enqueue(
        job_type="contact_governance", target_kind="contact_directory",
        target_key="global", params={"trigger_kind": "manual"},
        idempotency_key="contact-governance-notify",
    )
    worker = AgentRunWorker(repo=repo, store=store)

    async def no_island(*a, **k):
        return None

    monkeypatch.setattr(worker, "_post_announce", no_island)
    _run(worker._announce_terminal(
        repo.get(job_id), "succeeded",
        {"outcome": "completed", "summary": "新增 2 条建议"}, None,
    ))

    rows = _notifications(repo)
    assert len(rows) == 1
    assert rows[0]["category"] == "reviews"  # 待审阅的建议 ≠ 运行结果
    assert rows[0]["dedupe_key"] == f"agent_run:{job_id}"


def test_paused_pending_publishes_action_required_todo(env, monkeypatch):
    """M2 信源 ①：等审批 = 待办条目（action_required），且**不推岛**（审批卡已 announce）。"""
    repo, store = env
    job_id = _claim_agent_job(repo)
    calls = _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "paused_handoff", "sessionId": 5,
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    rows = _notifications(repo)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "action_required"  # 待办, 不是运行结果
    assert row["severity"] == "warn"
    assert row["source"] == "agent_run"
    assert row["dedupe_key"] == f"agent_run_paused:{job_id}"  # 逐条待办, 不按 agent 合并
    assert "DMS" in row["title"] and row["body"] == "等待审批"  # 无 TTL → 不硬造期限
    assert json.loads(row["payload_json"])["link"] == {"type": "session", "sessionId": 5}
    assert _announce_calls(calls) == []  # 岛卡链路不变（防双卡）


def test_paused_body_carries_approval_ttl_when_gateway_reports_it(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "paused_handoff", "sessionId": 5, "approvalTtlSec": 1800,
    }))
    worker = AgentRunWorker(repo=repo, store=store)
    _run(worker._execute(repo.get(job_id)))

    assert _notifications(repo)[0]["body"] == "等待审批（30 分钟内有效）"


def test_terminal_resolves_pending_approval_todo_before_publishing(env, monkeypatch):
    """审批处理完 run 走向终态 → 待办先归档、再落终态条目（顺序反了面板会先多一条）。"""
    repo, store = env
    job_id = _claim_agent_job(repo)
    worker = AgentRunWorker(repo=repo, store=store)

    async def no_island(*a, **k):
        return None

    monkeypatch.setattr(worker, "_post_announce", no_island)
    # ① 先落一条「待审批」待办
    _run(worker._announce_terminal(
        repo.get(job_id), "succeeded",
        {"outcome": "paused_handoff", "approval_state": "pending", "sessionId": 5}, None,
    ))
    assert [r["dedupe_key"] for r in _notifications(repo)] == [
        f"agent_run_paused:{job_id}"
    ]

    order: list = []
    center = worker._notify_center
    real_resolve, real_publish = center.resolve_by_dedupe, center.publish

    def rec_resolve(dedupe_key, **kw):
        order.append(("resolve", dedupe_key))
        return real_resolve(dedupe_key, **kw)

    def rec_publish(**kw):
        order.append(("publish", kw["dedupe_key"]))
        return real_publish(**kw)

    monkeypatch.setattr(center, "resolve_by_dedupe", rec_resolve)
    monkeypatch.setattr(center, "publish", rec_publish)
    # ② 同 job 到达终态
    _run(worker._announce_terminal(
        repo.get(job_id), "succeeded", {"outcome": "completed", "sessionId": 5}, None,
    ))

    assert order == [
        ("resolve", f"agent_run_paused:{job_id}"),
        ("publish", f"agent_run:{job_id}"),
    ]
    by_key = {r["dedupe_key"]: r for r in _notifications(repo)}
    assert by_key[f"agent_run_paused:{job_id}"]["state"] == "resolved"
    assert by_key[f"agent_run:{job_id}"]["state"] == "open"


def test_resolve_failure_does_not_swallow_terminal_notification(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "completed", "sessionId": 7,
    }))
    worker = AgentRunWorker(repo=repo, store=store)

    def boom(dedupe_key, **kw):
        raise RuntimeError("resolve blew up")

    monkeypatch.setattr(worker._notify_center, "resolve_by_dedupe", boom)
    _run(worker._execute(repo.get(job_id)))

    # 归档失败被单独吞：终态那一条照发（两段 try 的意义）
    assert [r["dedupe_key"] for r in _notifications(repo)] == [f"agent_run:{job_id}"]


def _paused_todo(repo, worker, *, agent_id: str = "dms") -> int:
    """造一条真实的「待审批」待办：job 落 paused_handoff 终态 + 通知条目。"""
    job_id = _claim_agent_job(repo, agent_id=agent_id)
    result = {"outcome": "paused_handoff", "approval_state": "pending", "sessionId": 5}
    repo.mark_terminal(job_id, status="succeeded", result=result)
    _run(worker._announce_terminal(repo.get(job_id), "succeeded", result, None))
    assert [r["dedupe_key"] for r in _notifications(repo)] == [
        f"agent_run_paused:{job_id}"
    ]
    return job_id


def test_sweep_archives_todo_only_after_approval_ttl_expires(env):
    """M3-C2 ⑤: `paused_expired` 纯读侧派生（无写路径可挂）→ 只能按龄重算。

    TTL 内一动不动；过期后归档（只 resolve，不 publish 不未读化）。
    """
    repo, store = env
    worker = AgentRunWorker(repo=repo, store=store)
    job_id = _paused_todo(repo, worker)

    _run(worker._sweep_expired_paused_notifications())
    row = _notifications(repo)[0]
    assert row["state"] == "open", "TTL 内仍可批 —— 不许提前收掉待办"
    assert row["read_at"] is None and row["recurrence_no"] == 1

    # 审批已过期（默认 TTL 30min）
    expired = AgentRunWorker(
        repo=repo, store=store, now_fn=lambda: time.time() + 3600
    )
    _run(expired._sweep_expired_paused_notifications())
    rows = _notifications(repo)
    assert len(rows) == 1, "只归档, 不新开条目"
    assert rows[0]["state"] == "resolved" and rows[0]["dedupe_key"] == (
        f"agent_run_paused:{job_id}"
    )
    assert rows[0]["recurrence_no"] == 1, "归档不得未读化/计次"


def test_sweep_is_idempotent_and_leaves_other_action_items_alone(env):
    """已归档的条目再扫不炸；非 agent_run_paused 的 action_required 条目不碰。"""
    repo, store = env
    worker = AgentRunWorker(repo=repo, store=store)
    _paused_todo(repo, worker)
    worker._notify_center.publish(
        category="action_required", source="matter", title="事项待跟进",
        dedupe_key="matter_attention:7",
    )

    clock = {"t": time.time() + 3600}
    expired = AgentRunWorker(repo=repo, store=store, now_fn=lambda: clock["t"])
    _run(expired._sweep_expired_paused_notifications())
    clock["t"] += 120  # 越过扫描节拍 → 第二次真的会扫
    _run(expired._sweep_expired_paused_notifications())

    by_key = {r["dedupe_key"]: r for r in _notifications(repo)}
    assert by_key["matter_attention:7"]["state"] == "open"
    assert len([k for k in by_key if k.startswith("agent_run_paused:")]) == 1


def test_sweep_throttled_to_one_pass_per_interval(env):
    """寄生主循环空闲轮（5s 一次）→ 必须自己节流, 否则每 5s 一次全扫。"""
    repo, store = env
    worker = AgentRunWorker(repo=repo, store=store)
    _paused_todo(repo, worker)

    base = time.time() + 3600
    expired = AgentRunWorker(repo=repo, store=store, now_fn=lambda: base)
    calls: list = []
    real_list = expired._notify_center.list
    expired._notify_center.list = lambda **kw: (  # type: ignore[method-assign]
        calls.append(kw) or real_list(**kw)
    )
    for _ in range(3):
        _run(expired._sweep_expired_paused_notifications())

    assert len(calls) == 1, "同一节拍窗口内只扫一次"
    assert calls[0] == {
        "category": "action_required", "state": "open", "limit": 100,
    }, "扫描有界: 只看 action_required 活跃行头部窗口"


def test_sweep_archives_todo_when_job_row_is_gone(env):
    """job 行已被清理 → 条目再也点不动, 按读态单源同款 fail-closed 归档。"""
    repo, store = env
    worker = AgentRunWorker(repo=repo, store=store)
    job_id = _paused_todo(repo, worker)
    conn = sqlite3.connect(str(repo.db_path))
    with conn:
        conn.execute("DELETE FROM async_jobs WHERE job_id=?", (job_id,))
    conn.close()

    expired = AgentRunWorker(
        repo=repo, store=store, now_fn=lambda: time.time() + 3600
    )
    _run(expired._sweep_expired_paused_notifications())
    assert _notifications(repo)[0]["state"] == "resolved"


def test_notify_publish_failure_does_not_block_terminal_or_island(env, monkeypatch):
    repo, store = env
    job_id = _claim_agent_job(repo)
    calls = _patch_client_capturing(monkeypatch, gateway_resp=_FakeResp(200, {
        "ok": True, "outcome": "completed", "sessionId": 3,
    }))
    worker = AgentRunWorker(repo=repo, store=store)

    def boom(**kwargs):
        raise RuntimeError("notification table gone")

    monkeypatch.setattr(worker._notify_center, "publish", boom)
    _run(worker._execute(repo.get(job_id)))

    # publish 抛异常被挂点吞：job 终态与岛卡都不受牵连
    assert repo.get(job_id).status == "succeeded"
    assert len(_announce_calls(calls)) == 1
    assert _notifications(repo) == []
