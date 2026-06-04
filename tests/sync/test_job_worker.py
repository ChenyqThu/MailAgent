"""JobWorker e2e (C1): claim → run_job → 终态 + 进度 + SSE + 协作式停 + checkpoint 续跑。

用 monkeypatch 把 worker 内部 ``ServiceContext(config)`` 换成绑定测试 sync_store +
stub notion_sync 的 fake deps; safe_publish 收集 SSE 事件 (无 redis)。
"""
from __future__ import annotations

import types

import pytest

from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository
from src.sync.job_worker import JobWorker


class _FakeResult:
    def __init__(self, page_id="p", archived_page_id=None, action="created"):
        self.page_id = page_id
        self.archived_page_id = archived_page_id
        self.action = action


class _FakeNotionSync:
    def __init__(self):
        self.seen: list[int] = []

    async def create_email_page_from_sqlite(
        self, internal_id, *, repo, sync_store, replace_existing, skip_parent_lookup,
    ):
        self.seen.append(internal_id)
        return _FakeResult(page_id=f"p-{internal_id}")


class _FakeDeps:
    def __init__(self, sync_store, notion_sync):
        self._ss = sync_store
        self._ns = notion_sync

    @property
    def sync_store(self):
        return self._ss

    @property
    def email_repo(self):
        return object()

    @property
    def notion_sync(self):
        return self._ns


@pytest.fixture
def env(tmp_path, monkeypatch):
    db = tmp_path / "sync.db"
    sync_store = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    notion = _FakeNotionSync()

    # worker._execute 内 `from src.services.context import ServiceContext` → patch 工厂
    monkeypatch.setattr(
        "src.services.context.ServiceContext",
        lambda _config: _FakeDeps(sync_store, notion),
    )

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        "src.sync.job_worker.safe_publish",
        lambda event_type, **kw: events.append((event_type, kw)),
    )

    worker = JobWorker(repo=repo, config=types.SimpleNamespace(), poll_interval_sec=1)
    return types.SimpleNamespace(
        repo=repo, notion=notion, worker=worker, events=events,
    )


def test_execute_resync_job_succeeds_e2e(env):
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2,3",
        params={"internal_ids": [1, 2, 3]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)

    out = env.repo.get(job_id)
    assert out.status == "succeeded"
    assert out.progress_done == 3 and out.progress_total == 3
    assert out.result["succeeded"] == 3
    assert out.finished_at is not None
    assert env.notion.seen == [1, 2, 3]

    event_types = [e[0] for e in env.events]
    assert "job.running" in event_types
    assert "job.done" in event_types


def test_execute_cooperative_stop_aborts(env):
    """stop_event 预置 → on_unit_done 首个 unit 后返 False → 优雅中止 (status='aborted')。"""
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2,3,4,5",
        params={"internal_ids": [1, 2, 3, 4, 5]},
    )
    job = env.repo.claim_next()
    env.worker.stop()  # 预置停止
    env.worker._execute(job)

    out = env.repo.get(job_id)
    assert out.status == "aborted"
    # 协作式停: 第一个 unit 跑完即止 (不会全跑完 5 个)
    assert len(env.notion.seen) < 5


def test_execute_resumes_from_checkpoint(env):
    """job.checkpoint_internal_id 设过 → _execute resume_from=checkpoint+1, 跳过已完成 unit。"""
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:10,11,12",
        params={"internal_ids": [10, 11, 12]},
    )
    env.repo.update_progress(job_id, done=2, total=3, checkpoint_internal_id=11)
    job = env.repo.claim_next()
    env.worker._execute(job)

    # resume_from=12 → LongTaskContext 跳过 internal_id<12 → 只跑 12
    assert env.notion.seen == [12]
    assert env.repo.get(job_id).status == "succeeded"


def test_execute_runner_failure_marks_failed(env, monkeypatch):
    """run_job 整体抛 (非 unit 级) → 标 failed + last_error + job.failed SSE。"""
    def _boom(*a, **k):
        raise RuntimeError("runner exploded")

    monkeypatch.setattr("src.sync.job_runners.run_job", _boom)
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1",
        params={"internal_ids": [1]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)

    out = env.repo.get(job_id)
    assert out.status == "failed"
    assert "runner exploded" in (out.last_error or "")
    assert "job.failed" in [e[0] for e in env.events]
