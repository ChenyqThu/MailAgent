"""FanoutWorker 单测（Sprint 15 Stage 1.3）.

覆盖:
- _tick 单次: pending entry → mark_processing → execute → mark_done
- failure path: fanout 返回 False → mark_failed
- exception path: fanout 抛异常 → mark_failed (兜底)
- target 未知 → mark_failed
- mark_processing race condition: 另一 worker 已抢到, 当前 skip
- dead_letter 晋升: attempts ≥ max
- stop() 退出主循环

测试用真实 OutboxRepository + 真实 sync_store v10 schema, 但 fanout
本身用 mock 替代（不真调 AppleScript / Notion）。
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.mail.sync_store import SyncStore
from src.sync.fanout import FanoutWorker
from src.sync.outbox import OutboxRepository


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    conn = sqlite3.connect(str(path))
    try:
        now = time.time()
        for iid in (1001, 1002, 1003):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
                "VALUES (?, 'synced', ?, ?)",
                (iid, now, now),
            )
        conn.commit()
    finally:
        conn.close()
    return str(path)


@pytest.fixture
def repo(db_path):
    return OutboxRepository(db_path)


@pytest.fixture
def mailapp_fanout():
    f = MagicMock()
    f.execute = AsyncMock(return_value=(True, "done"))
    return f


@pytest.fixture
def notion_fanout():
    f = MagicMock()
    f.execute = AsyncMock(return_value=(True, "done"))
    return f


@pytest.fixture
def worker(repo, mailapp_fanout, notion_fanout):
    return FanoutWorker(
        outbox_repo=repo,
        mailapp_fanout=mailapp_fanout,
        notion_fanout=notion_fanout,
        poll_interval_sec=1,
        batch_size=10,
        concurrency=3,
        max_attempts=3,
    )


# ============================================================
# Single-tick happy paths
# ============================================================

class TestTickHappyPath:
    async def test_pending_to_done(self, repo, worker, mailapp_fanout):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})

        # 模拟 worker 主循环对 sem 的初始化
        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._tick()

        mailapp_fanout.execute.assert_called_once()
        assert repo.get(oid).status == "done"
        assert worker.stats["done"] == 1

    async def test_dispatches_by_target(self, repo, worker, mailapp_fanout, notion_fanout):
        oid_m = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})
        oid_n = repo.enqueue(internal_id=1001, op_type="flag_sync", target="notion", payload={"is_read": True})

        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._tick()

        mailapp_fanout.execute.assert_called_once()
        notion_fanout.execute.assert_called_once()
        assert repo.get(oid_m).status == "done"
        assert repo.get(oid_n).status == "done"

    async def test_noop_counted_as_done(self, repo, worker, mailapp_fanout):
        mailapp_fanout.execute = AsyncMock(return_value=(True, "noop_idempotent"))
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})

        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._tick()

        assert repo.get(oid).status == "done"
        assert worker.stats["noop"] == 1
        assert worker.stats["done"] == 1


# ============================================================
# Failure paths
# ============================================================

class TestFailureHandling:
    async def test_fanout_returns_false_marks_failed(
        self, repo, worker, mailapp_fanout
    ):
        mailapp_fanout.execute = AsyncMock(return_value=(False, "boom"))
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})

        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._tick()

        entry = repo.get(oid)
        assert entry.status == "failed"
        assert entry.attempts == 1
        assert entry.last_error == "boom"

    async def test_fanout_raises_exception_marks_failed(
        self, repo, worker, mailapp_fanout
    ):
        mailapp_fanout.execute = AsyncMock(side_effect=RuntimeError("crash"))
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})

        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._tick()

        entry = repo.get(oid)
        assert entry.status == "failed"
        assert entry.attempts == 1
        assert "RuntimeError" in entry.last_error

    async def test_promotion_to_dead_letter_after_max(self, repo, worker, mailapp_fanout):
        """worker.max_attempts=3, 跑 3 次失败应晋升 dead_letter."""
        mailapp_fanout.execute = AsyncMock(return_value=(False, "boom"))
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})

        worker._sem = asyncio.Semaphore(worker.concurrency)

        for _ in range(3):
            # 把 next_retry_at 设到过去, 否则 poll_ready 拿不到
            conn = sqlite3.connect(repo.db_path)
            try:
                conn.execute(
                    "UPDATE email_outbox SET next_retry_at = ? WHERE outbox_id = ?",
                    (time.time() - 60, oid),
                )
                conn.commit()
            finally:
                conn.close()
            await worker._tick()

        entry = repo.get(oid)
        assert entry.status == "dead_letter"
        assert entry.attempts == 3
        assert worker.stats["dead_letter"] == 1

    async def test_unknown_target_fails(self, repo, worker):
        # 直接 INSERT 一条 target='unknown' 绕开 enqueue 的 client-side validation —
        # 不可能，因 CHECK constraint 拒。所以这里测的是 _select_fanout 兜底 (理论
        # 不可达, 但 belt-and-suspenders)。直接调内部 _process_one 用人造 entry.
        from src.sync.outbox import OutboxEntry

        entry = OutboxEntry(
            outbox_id=999, internal_id=1001, op_type="flag_sync",
            target="something_else", payload={}, source="frontend",
            status="pending", attempts=0, last_error=None, next_retry_at=None,
            created_at=time.time(), updated_at=time.time(),
        )
        # 先 INSERT 一行真 outbox 让 mark_processing/mark_failed 能改它
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        # 替换 entry.outbox_id 为真 id
        entry = OutboxEntry(
            outbox_id=oid, internal_id=1001, op_type="flag_sync",
            target="something_else", payload={}, source="frontend",
            status="pending", attempts=0, last_error=None, next_retry_at=None,
            created_at=time.time(), updated_at=time.time(),
        )

        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._process_one(entry)

        result = repo.get(oid)
        assert result.status == "failed"
        assert "no fanout for target" in result.last_error


# ============================================================
# Concurrency / race
# ============================================================

class TestConcurrency:
    async def test_mark_processing_race_skip(self, repo, worker, mailapp_fanout):
        """另一个 worker 已经 mark_processing → 当前 process_one 应 silent skip."""
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})
        # 模拟竞争者已经抢到
        repo.mark_processing(oid)
        entry = repo.get(oid)
        assert entry.status == "processing"

        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._process_one(entry)

        # fanout 不应被调用，status 仍 processing（被 race 的 worker 应自己 mark_done）
        mailapp_fanout.execute.assert_not_called()
        assert repo.get(oid).status == "processing"


# ============================================================
# Lifecycle
# ============================================================

class TestLifecycle:
    async def test_run_stops_on_event(self, repo, worker, mailapp_fanout):
        """worker.run() 调 stop() 后应在下一 poll 退出."""
        repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={"is_read": True})

        async def trigger_stop():
            # 等一小段时间让 worker 至少跑过一轮 tick
            await asyncio.sleep(0.1)
            worker.stop()

        worker.poll_interval_sec = 1  # 短轮询便于测试
        await asyncio.gather(
            worker.run(),
            trigger_stop(),
        )

        # 跑了一轮 → done
        assert worker.stats["done"] >= 1
        assert worker.stats["polled"] >= 1

    async def test_empty_tick_no_calls(self, repo, worker, mailapp_fanout):
        """无 pending 时 tick 不调 fanout."""
        worker._sem = asyncio.Semaphore(worker.concurrency)
        await worker._tick()
        mailapp_fanout.execute.assert_not_called()
        assert worker.stats["polled"] == 0
