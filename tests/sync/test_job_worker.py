"""JobWorker e2e (C1): claim → run_job → 终态 + 进度 + SSE + 协作式停 + checkpoint 续跑。

用 monkeypatch 把 worker 内部 ``ServiceContext(config)`` 换成绑定测试 sync_store +
stub notion_sync 的 fake deps; safe_publish 收集 SSE 事件 (无 redis)。

通知中心接线 (task 08-20-notification-center 步骤 4b, design §7「维护族 job 终态」行):
``_notify_terminal`` 直接落 ``NotifyCenter`` 真库 (env fixture 只 patch 了 SSE 层的
safe_publish, 不 patch NotifyCenter), 故用 ``_fetch_notifications`` 直读 sqlite 断言。
"""
from __future__ import annotations

import sqlite3
import types

import pytest

from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJobRepository
from src.sync.job_worker import JobWorker


def _fetch_notifications(db_path) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM notification ORDER BY id").fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


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


# ==================== 通知中心接线 (步骤 4b) ====================

def test_execute_succeeded_job_publishes_results_notification(env):
    """succeeded → category=results/severity=info, 文案含「已完成」。"""
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2,3",
        params={"internal_ids": [1, 2, 3]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)

    rows = _fetch_notifications(env.repo.db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "results"
    assert row["severity"] == "info"
    assert row["dedupe_key"] == f"job:resync:{job_id}"
    assert "已完成" in row["title"]
    assert "成功 3" in row["body"] and "失败 0" in row["body"]


def test_execute_partial_failure_job_notifies_with_partial_wording(env):
    """部分 unit 失败 → status=partial_failure (走 job.done), 文案≠「已完成」。

    design §7 点名口径: partial_failure 走 job.done 事件, 但文案读 status 必须是
    「部分失败」——不能因为 SSE 事件名是 job.done 就误写成功文案。
    """
    original = env.notion.create_email_page_from_sqlite

    async def _flaky(internal_id, **kwargs):
        if internal_id == 2:
            raise RuntimeError("boom")
        return await original(internal_id, **kwargs)

    env.notion.create_email_page_from_sqlite = _flaky
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2,3",
        params={"internal_ids": [1, 2, 3]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)

    out = env.repo.get(job_id)
    assert out.status == "partial_failure"
    assert "job.done" in [e[0] for e in env.events]

    rows = _fetch_notifications(env.repo.db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "results"
    assert row["severity"] == "warn"
    assert "部分失败" in row["title"]
    assert "已完成" not in row["title"]
    assert "成功 2" in row["body"] and "失败 1" in row["body"]


def test_execute_all_units_failed_job_notifies_warn(env):
    """全部 unit 失败 (非 runner 级崩溃) → status=failed (走 job.failed), severity=warn。"""
    async def _always_fail(internal_id, **kwargs):
        raise RuntimeError("boom")

    env.notion.create_email_page_from_sqlite = _always_fail
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2",
        params={"internal_ids": [1, 2]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)

    out = env.repo.get(job_id)
    assert out.status == "failed"
    assert "job.failed" in [e[0] for e in env.events]

    rows = _fetch_notifications(env.repo.db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["severity"] == "warn"
    assert "失败" in row["title"]
    assert "成功 0" in row["body"]


def test_execute_cooperative_stop_notifies_info(env):
    """协作式中止 (aborted) → design §7: succeeded/aborted=info。"""
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1,2,3",
        params={"internal_ids": [1, 2, 3]},
    )
    job = env.repo.claim_next()
    env.worker.stop()
    env.worker._execute(job)

    rows = _fetch_notifications(env.repo.db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["severity"] == "info"
    assert "已中止" in row["title"]


def test_execute_runner_crash_notifies_failed_with_error_body(env, monkeypatch):
    """runner 整体崩溃 (crash 路径, 非 summary 形状) → 文案落 error, 无 summary 计数。"""
    def _boom(*a, **k):
        raise RuntimeError("runner exploded")

    monkeypatch.setattr("src.sync.job_runners.run_job", _boom)
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1",
        params={"internal_ids": [1]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)

    rows = _fetch_notifications(env.repo.db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "results"
    assert row["severity"] == "warn"
    assert row["dedupe_key"] == f"job:resync:{job_id}"
    assert "失败" in row["title"]
    assert "runner exploded" in row["body"]


def test_execute_notify_publish_failure_does_not_break_job_terminal(env, monkeypatch):
    """通知路径抛异常不得影响 job 终态写入 (design §3.3 纪律)。"""
    def _boom(*a, **k):
        raise RuntimeError("notify center down")

    monkeypatch.setattr(env.worker._notify_center, "publish", _boom)
    job_id, _ = env.repo.enqueue(
        job_type="resync", target_kind="ids", target_key="ids:1",
        params={"internal_ids": [1]},
    )
    job = env.repo.claim_next()
    env.worker._execute(job)  # 不应抛出

    out = env.repo.get(job_id)
    assert out.status == "succeeded"
