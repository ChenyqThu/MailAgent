"""S6 W1 — GET /api/agent-runs 的 state 过滤 + GET /api/agent-runs/pending-count 契约。

读态唯一经 ``derive_agent_run_state`` 单源投影（不在此重造 status 映射）；只计 live 可批的
``paused_pending``（``paused_expired`` 不计红点）。鉴权 verify_cf_access（conftest auth bypass），
flag off → 404（S4 纪律）。fixtures 全合成：tmp SyncStore + AsyncJobRepository 注入。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.api.routers.agent_runs as agent_runs


@pytest.fixture()
def runs_env(tmp_path, monkeypatch):
    """tmp sync_store + AsyncJobRepository（注入 agent_runs.get_job_repo）+ flag on。"""
    from src.mail.sync_store import SyncStore
    from src.sync.async_jobs import AsyncJobRepository

    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=db, repo=repo)


def _enqueue_run(repo, agent_id: str, *, status=None, result=None) -> int:
    """入队一条 agent_run（target_key=agent_id）→ 可选写终态（status + result_json）。

    status=None → 留 queued；'succeeded' + result{outcome:'paused_handoff', approval_state:'pending'}
    → paused_pending（mark_terminal 写 finished_at=now，龄 ~0 < TTL）。result 不含 sessionId 以
    避开 _annotate_auto_whitelist 的 ChatDb 依赖（合成库无 ai_chat.db）。
    """
    job_id, _ = repo.enqueue(
        job_type="agent_run", target_kind="agent", target_key=agent_id,
        params={"agent_id": agent_id},
    )
    if status is not None:
        repo.mark_terminal(job_id, status=status, result=result)
    return job_id


_PAUSED_PENDING = {"outcome": "paused_handoff", "approval_state": "pending"}
_COMPLETED = {"outcome": "completed"}


def _states(items):
    return sorted(it["state"] for it in items)


# ── state 过滤 ──────────────────────────────────────────────────────────────────


def test_list_no_state_returns_all(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)
    _enqueue_run(runs_env.repo, "b", status="failed")
    _enqueue_run(runs_env.repo, "b")  # queued

    data = client.get("/api/agent-runs").json()["data"]
    assert _states(data) == ["completed", "failed", "paused_pending", "queued"]


def test_list_state_filter_paused_pending(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)

    data = client.get("/api/agent-runs", params={"state": "paused_pending"}).json()["data"]
    assert len(data) == 2
    assert all(it["state"] == "paused_pending" for it in data)


def test_list_state_filter_completed(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)

    data = client.get("/api/agent-runs", params={"state": "completed"}).json()["data"]
    assert len(data) == 1 and data[0]["state"] == "completed"


def test_list_state_filter_empty_when_no_match(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)
    data = client.get("/api/agent-runs", params={"state": "failed"}).json()["data"]
    assert data == []


def test_list_state_filter_combines_with_agent_id(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_PAUSED_PENDING)
    data = client.get(
        "/api/agent-runs", params={"agentId": "a", "state": "paused_pending"}
    ).json()["data"]
    assert len(data) == 1 and data[0]["agentId"] == "a"


def test_list_invalid_state_400(client, runs_env):
    r = client.get("/api/agent-runs", params={"state": "bogus"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ── pending-count ───────────────────────────────────────────────────────────────


def test_pending_count_total_and_by_agent(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "b", status="succeeded", result=_PAUSED_PENDING)
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)  # 不计
    _enqueue_run(runs_env.repo, "b", status="failed")  # 不计

    data = client.get("/api/agent-runs/pending-count").json()["data"]
    assert data["total"] == 3
    assert data["byAgent"] == {"a": 2, "b": 1}


def test_pending_count_zero_when_none_pending(client, runs_env):
    _enqueue_run(runs_env.repo, "a", status="succeeded", result=_COMPLETED)
    _enqueue_run(runs_env.repo, "b", status="failed")

    data = client.get("/api/agent-runs/pending-count").json()["data"]
    assert data == {"total": 0, "byAgent": {}}


def test_pending_count_only_counts_paused_pending_not_expired(client, runs_env):
    # paused_expired（finished_at 远早于 TTL）不计红点：直改 finished_at 回拨到 TTL 外。
    import time

    from src.agents.run_state import APPROVAL_PENDING_TTL_SEC

    jid = _enqueue_run(runs_env.repo, "a", status="succeeded", result=_PAUSED_PENDING)
    old = time.time() - APPROVAL_PENDING_TTL_SEC - 60
    conn = runs_env.repo._connect()
    try:
        conn.execute("UPDATE async_jobs SET finished_at=? WHERE job_id=?", (old, jid))
        conn.commit()
    finally:
        conn.close()

    # 读态应为 paused_expired（不可批）→ pending-count = 0。
    runs = client.get("/api/agent-runs").json()["data"]
    assert runs[0]["state"] == "paused_expired"
    assert client.get("/api/agent-runs/pending-count").json()["data"] == {
        "total": 0, "byAgent": {}
    }


# ── flag off（S4 纪律：feature 不存在 → 404）─────────────────────────────────────


def test_list_state_flag_off_404(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    assert client.get("/api/agent-runs", params={"state": "paused_pending"}).status_code == 404


def test_pending_count_flag_off_404(client, runs_env, monkeypatch):
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: False)
    assert client.get("/api/agent-runs/pending-count").status_code == 404
