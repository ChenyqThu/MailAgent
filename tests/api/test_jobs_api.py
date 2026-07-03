"""POST /api/jobs + GET /api/jobs/{job_id} — C1 async_jobs 端点。

用真实 AsyncJobRepository (tmp SyncStore DB) 跑端到端 enqueue/get; safe_publish 换成
收集器断言 SSE。断言: job_type 校验 (400) / enqueue 返 job_id+queued / idempotent
重发 was_created=False 且不重复发 SSE / GET 查状态 / 404。
"""
from __future__ import annotations

import pytest

import src.api.routers.jobs as jobs_router
from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def jobs_repo(tmp_path, monkeypatch):
    db = tmp_path / "sync.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    monkeypatch.setattr(jobs_router, "get_job_repo", lambda: repo)
    return repo


@pytest.fixture
def sse_events(monkeypatch):
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        jobs_router, "safe_publish",
        lambda event_type, **kw: events.append((event_type, kw)),
    )
    return events


def test_enqueue_job_creates_queued_row(client, jobs_repo, sse_events):
    resp = client.post("/api/jobs", json={
        "jobType": "resync", "targetKind": "ids", "targetKey": "ids:1,2",
        "params": {"internal_ids": [1, 2]},
    })
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == "queued"
    assert data["was_created"] is True
    assert data["job_type"] == "resync"
    # 真落库了
    job = jobs_repo.get(data["job_id"])
    assert job is not None and job.status == "queued"
    assert job.params == {"internal_ids": [1, 2]}
    # 新建 → job.enqueued SSE
    assert ("job.enqueued", {"data": {"job_id": data["job_id"], "job_type": "resync"},
                             "source": "api"}) in sse_events


def test_enqueue_rejects_unknown_job_type(client, jobs_repo, sse_events):
    resp = client.post("/api/jobs", json={"jobType": "bogus"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert sse_events == []


def test_enqueue_missing_job_type_rejected(client, jobs_repo):
    resp = client.post("/api/jobs", json={"targetKind": "all"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_enqueue_rejects_agent_run(client, jobs_repo, sse_events):
    """S4 D1 分区: 公共 REST 只收维护族 —— agent_run 传入 → 400（唯一入队方 = 触发引擎）。"""
    resp = client.post("/api/jobs", json={"jobType": "agent_run", "targetKey": "a1"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert sse_events == []


def test_enqueue_idempotent_key_no_duplicate_sse(client, jobs_repo, sse_events):
    body = {"jobType": "backfill_body", "targetKind": "all", "targetKey": "all",
            "idempotencyKey": "nightly-1"}
    r1 = client.post("/api/jobs", json=body)
    r2 = client.post("/api/jobs", json=body)
    assert r1.json()["data"]["job_id"] == r2.json()["data"]["job_id"]
    assert r1.json()["data"]["was_created"] is True
    assert r2.json()["data"]["was_created"] is False
    # 仅首次发 SSE (idempotent 重发不发)
    assert [e[0] for e in sse_events] == ["job.enqueued"]


def test_get_job_returns_status(client, jobs_repo):
    job_id, _ = jobs_repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:5",
        params={"internal_ids": [5]},
    )
    jobs_repo.update_progress(job_id, done=1, total=1, checkpoint_internal_id=5)
    jobs_repo.mark_terminal(job_id, status="succeeded", result={"succeeded": 1})

    resp = client.get(f"/api/jobs/{job_id}")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["job_id"] == job_id
    assert data["status"] == "succeeded"
    assert data["progress_done"] == 1
    assert data["checkpoint_internal_id"] == 5
    assert data["result"] == {"succeeded": 1}


def test_get_job_404_when_missing(client, jobs_repo):
    resp = client.get("/api/jobs/999999")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_NOT_FOUND"
