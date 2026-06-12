"""OutboxRepository 单测（Sprint 15 Stage 1.2）.

覆盖:
- enqueue 基础 INSERT / merge 同 pending / echo prevention
- enqueue_many 批量 / 非法 target ValueError
- poll_ready：FIFO + pending/failed-ready 共采 + target filter + limit
- mark_processing / mark_done / mark_failed (含 退避 + dead_letter)
- retry_dead_letter / list_by_internal_id / list_dead_letter / get
- get_stats by_status / by_target / age_buckets
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from src.mail.sync_store import SyncStore
from src.sync.outbox import (
    OutboxEntry,
    OutboxRepository,
    OutboxStats,
    _backoff_next_retry_at,
    _BACKOFF_SECONDS,
)


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def db_path(tmp_path):
    """新建一个 v10 sync_store.db, 预先 INSERT 一些 email_metadata 行供 FK 引用."""
    path = tmp_path / "sync.db"
    SyncStore(str(path))  # 触发 v10 schema 建表

    conn = sqlite3.connect(str(path))
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        now = time.time()
        for iid in (1001, 1002, 1003, 1004, 1005):
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


# ============================================================
# enqueue
# ============================================================

class TestEnqueueBasic:
    def test_insert_new_row(self, repo):
        outbox_id = repo.enqueue(
            internal_id=1001,
            op_type="flag_sync",
            target="mailapp",
            payload={"is_read": True},
            source="frontend",
        )
        assert outbox_id > 0

        entry = repo.get(outbox_id)
        assert entry is not None
        assert entry.internal_id == 1001
        assert entry.op_type == "flag_sync"
        assert entry.target == "mailapp"
        assert entry.payload == {"is_read": True}
        assert entry.source == "frontend"
        assert entry.status == "pending"
        assert entry.attempts == 0
        assert entry.last_error is None
        assert entry.next_retry_at is None

    def test_invalid_target_raises(self, repo):
        with pytest.raises(ValueError, match="invalid target"):
            repo.enqueue(
                internal_id=1001, op_type="flag_sync",
                target="feishu", payload={},
            )

    def test_empty_op_type_raises(self, repo):
        with pytest.raises(ValueError, match="op_type required"):
            repo.enqueue(
                internal_id=1001, op_type="",
                target="mailapp", payload={},
            )

    def test_payload_json_sorted_for_stability(self, repo):
        """payload JSON 用 sort_keys=True, 确保 merge 行为可预测."""
        outbox_id = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True, "is_flagged": False},
        )
        # 查 raw JSON 是按 key 排序的
        conn = sqlite3.connect(repo.db_path)
        try:
            row = conn.execute(
                "SELECT payload_json FROM email_outbox WHERE outbox_id = ?",
                (outbox_id,),
            ).fetchone()
        finally:
            conn.close()
        # is_flagged 在 is_read 前（字典序）
        assert row[0].startswith('{"is_flagged"')


class TestEnqueueMerge:
    def test_merge_into_pending(self, repo):
        """同 (internal_id, op_type, target, status='pending') 已存在 → merge."""
        id1 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True},
        )
        id2 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_flagged": True},
        )
        # 同 outbox_id，没新增行
        assert id1 == id2

        entry = repo.get(id1)
        assert entry.payload == {"is_read": True, "is_flagged": True}

    def test_merge_overwrites_same_key(self, repo):
        """后写覆盖同 key."""
        id1 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True},
        )
        id2 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": False, "is_flagged": True},
        )
        assert id1 == id2
        assert repo.get(id1).payload == {"is_read": False, "is_flagged": True}

    def test_no_merge_across_different_targets(self, repo):
        """同 internal_id + op_type 但不同 target → 两行独立."""
        id_mailapp = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True},
        )
        id_notion = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="notion",
            payload={"is_read": True},
        )
        assert id_mailapp != id_notion

    def test_no_merge_across_op_types(self, repo):
        id_flag = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True},
        )
        id_status = repo.enqueue(
            internal_id=1001, op_type="processing_status_sync", target="mailapp",
            payload={"processing_status": "已完成"},
        )
        assert id_flag != id_status

    def test_no_merge_with_done_row(self, repo):
        """同 (internal_id, op_type, target) 但旧行已 done → 不复用, 新建一行."""
        id1 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True},
        )
        repo.mark_processing(id1)
        repo.mark_done(id1)

        id2 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_flagged": True},
        )
        assert id2 != id1
        assert repo.get(id1).status == "done"
        assert repo.get(id2).status == "pending"

    def test_merge_updates_source(self, repo):
        """merge 时 source 用 COALESCE, 已有 source 不被新 None source 覆盖."""
        id1 = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True}, source="frontend",
        )
        repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_flagged": True}, source=None,
        )
        assert repo.get(id1).source == "frontend"


class TestEchoPrevention:
    def test_notion_webhook_to_notion_skipped(self, repo):
        """Notion webhook 触发的反向 sync 写 outbox 时只允许 target=mailapp."""
        outbox_id = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="notion",
            payload={"is_read": True}, source="notion_webhook",
        )
        assert outbox_id == -1

        # 表里不应有这条
        entries = repo.list_by_internal_id(1001)
        assert all(e.source != "notion_webhook" or e.target != "notion" for e in entries)

    def test_notion_webhook_to_mailapp_allowed(self, repo):
        """notion_webhook + mailapp 是合法的（同步到 Mail.app）."""
        outbox_id = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp",
            payload={"is_read": True}, source="notion_webhook",
        )
        assert outbox_id > 0

    def test_frontend_to_notion_allowed(self, repo):
        """frontend 发起的 intent 是双向同步, 允许 target=notion."""
        outbox_id = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="notion",
            payload={"is_read": True}, source="frontend",
        )
        assert outbox_id > 0

    def test_none_source_to_notion_allowed(self, repo):
        """source=None (cli 默认) 允许 notion."""
        outbox_id = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="notion",
            payload={"is_read": True}, source=None,
        )
        assert outbox_id > 0


class TestEnqueueMany:
    def test_batch_insert(self, repo):
        ids = repo.enqueue_many([
            {"internal_id": 1001, "op_type": "flag_sync", "target": "mailapp",
             "payload": {"is_read": True}, "source": "frontend"},
            {"internal_id": 1001, "op_type": "flag_sync", "target": "notion",
             "payload": {"is_read": True}, "source": "frontend"},
            {"internal_id": 1002, "op_type": "flag_sync", "target": "mailapp",
             "payload": {"is_flagged": True}, "source": "frontend"},
        ])
        assert len(ids) == 3
        assert all(i > 0 for i in ids)
        assert len(set(ids)) == 3  # 全不同

    def test_batch_with_echo_skip(self, repo):
        ids = repo.enqueue_many([
            {"internal_id": 1001, "op_type": "flag_sync", "target": "mailapp",
             "payload": {"is_read": True}, "source": "notion_webhook"},
            {"internal_id": 1001, "op_type": "flag_sync", "target": "notion",
             "payload": {"is_read": True}, "source": "notion_webhook"},
        ])
        assert ids[0] > 0       # mailapp ok
        assert ids[1] == -1     # notion echo-prevented


# ============================================================
# poll_ready
# ============================================================

class TestPollReady:
    def test_picks_pending(self, repo):
        repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        rows = repo.poll_ready(limit=10)
        assert len(rows) == 1
        assert rows[0].status == "pending"

    def test_picks_failed_with_retry_due(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        # manually drop next_retry_at into the past
        conn = sqlite3.connect(repo.db_path)
        try:
            conn.execute(
                "UPDATE email_outbox SET status='failed', next_retry_at=? WHERE outbox_id=?",
                (time.time() - 60, oid),
            )
            conn.commit()
        finally:
            conn.close()

        rows = repo.poll_ready(limit=10)
        assert len(rows) == 1
        assert rows[0].status == "failed"

    def test_skips_failed_with_retry_future(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        conn = sqlite3.connect(repo.db_path)
        try:
            conn.execute(
                "UPDATE email_outbox SET status='failed', next_retry_at=? WHERE outbox_id=?",
                (time.time() + 600, oid),
            )
            conn.commit()
        finally:
            conn.close()

        assert repo.poll_ready(limit=10) == []

    def test_skips_done_and_dead_letter(self, repo):
        oid_done = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp", payload={}
        )
        repo.mark_processing(oid_done)
        repo.mark_done(oid_done)

        oid_dl = repo.enqueue(
            internal_id=1002, op_type="flag_sync", target="mailapp", payload={}
        )
        # promote to dead_letter
        for _ in range(5):
            repo.mark_failed(oid_dl, "x", max_attempts=5)

        assert repo.get(oid_dl).status == "dead_letter"
        assert repo.poll_ready(limit=10) == []

    def test_filter_by_target(self, repo):
        repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        repo.enqueue(internal_id=1001, op_type="flag_sync", target="notion", payload={})

        mailapp_only = repo.poll_ready(target="mailapp", limit=10)
        notion_only = repo.poll_ready(target="notion", limit=10)
        assert len(mailapp_only) == 1
        assert mailapp_only[0].target == "mailapp"
        assert len(notion_only) == 1
        assert notion_only[0].target == "notion"

    def test_fifo_order(self, repo):
        a = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        # ensure 不同 created_at
        time.sleep(0.01)
        b = repo.enqueue(internal_id=1002, op_type="flag_sync", target="mailapp", payload={})

        rows = repo.poll_ready(limit=10)
        assert [r.outbox_id for r in rows] == [a, b]

    def test_limit_caps_count(self, repo):
        for i in range(5):
            repo.enqueue(
                internal_id=1001 + i, op_type="flag_sync", target="mailapp", payload={}
            )
        assert len(repo.poll_ready(limit=3)) == 3


# ============================================================
# state transitions
# ============================================================

class TestStateTransitions:
    def test_mark_processing_only_from_pending_or_failed(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        assert repo.mark_processing(oid) is True
        assert repo.get(oid).status == "processing"

        # already processing → no-op
        assert repo.mark_processing(oid) is False

    def test_mark_done(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        repo.mark_processing(oid)
        assert repo.mark_done(oid) is True
        entry = repo.get(oid)
        assert entry.status == "done"
        assert entry.last_error is None
        assert entry.next_retry_at is None

    def test_mark_failed_first_time(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        result = repo.mark_failed(oid, "boom", max_attempts=5)
        assert result["attempts"] == 1
        assert result["status"] == "failed"
        assert result["next_retry_at"] is not None
        assert result["next_retry_at"] > time.time()

        entry = repo.get(oid)
        assert entry.last_error == "boom"

    def test_mark_failed_exponential_backoff(self, repo):
        """attempts=N 时退避时间 ≈ _BACKOFF_SECONDS[N-1]."""
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        before = time.time()
        result = repo.mark_failed(oid, "first", max_attempts=5)
        # attempts=1 应用 _BACKOFF_SECONDS[0]=60s
        assert result["next_retry_at"] >= before + 60 - 1
        assert result["next_retry_at"] <= before + 60 + 5

        # 进 attempts=2 用 300s
        before = time.time()
        result = repo.mark_failed(oid, "second", max_attempts=5)
        assert result["attempts"] == 2
        assert result["next_retry_at"] >= before + 300 - 1
        assert result["next_retry_at"] <= before + 300 + 5

    def test_mark_failed_promotes_to_dead_letter(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        for i in range(5):
            result = repo.mark_failed(oid, f"err{i}", max_attempts=5)
        assert result["status"] == "dead_letter"
        assert result["next_retry_at"] is None
        assert repo.get(oid).status == "dead_letter"

    def test_mark_failed_caps_error_length(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        long_err = "x" * 1000
        repo.mark_failed(oid, long_err, max_attempts=5)
        entry = repo.get(oid)
        assert len(entry.last_error) <= 500

    def test_retry_dead_letter_resets_to_pending(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        for _ in range(5):
            repo.mark_failed(oid, "x", max_attempts=5)
        assert repo.get(oid).status == "dead_letter"

        assert repo.retry_dead_letter(oid) is True
        entry = repo.get(oid)
        assert entry.status == "pending"
        assert entry.attempts == 0
        assert entry.last_error is None

    def test_retry_dead_letter_noop_on_non_dead_letter(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        # pending → retry_dead_letter 应为 no-op
        assert repo.retry_dead_letter(oid) is False


# ============================================================
# stats
# ============================================================

class TestStats:
    def test_by_status(self, repo):
        oid1 = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        oid2 = repo.enqueue(internal_id=1002, op_type="flag_sync", target="notion", payload={})
        oid3 = repo.enqueue(internal_id=1003, op_type="flag_sync", target="mailapp", payload={})

        repo.mark_processing(oid1)
        repo.mark_done(oid1)
        repo.mark_processing(oid2)
        # oid3 stays pending

        stats = repo.get_stats()
        assert stats.by_status.get("done") == 1
        assert stats.by_status.get("processing") == 1
        assert stats.by_status.get("pending") == 1
        assert stats.total == 3

    def test_by_target_only_active(self, repo):
        """by_target 只计算活跃状态 (pending/processing/failed)."""
        oid_done = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp", payload={}
        )
        repo.mark_processing(oid_done)
        repo.mark_done(oid_done)

        repo.enqueue(internal_id=1002, op_type="flag_sync", target="mailapp", payload={})
        repo.enqueue(internal_id=1003, op_type="flag_sync", target="notion", payload={})

        stats = repo.get_stats()
        # done 行不计入 by_target
        assert stats.by_target.get("mailapp") == 1
        assert stats.by_target.get("notion") == 1

    def test_age_buckets(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        # manually backdate this row to > 30min ago
        conn = sqlite3.connect(repo.db_path)
        try:
            conn.execute(
                "UPDATE email_outbox SET created_at = ? WHERE outbox_id = ?",
                (time.time() - 3600, oid),
            )
            conn.commit()
        finally:
            conn.close()

        # 加一个新 pending（< 1min bucket）
        repo.enqueue(internal_id=1002, op_type="flag_sync", target="mailapp", payload={})

        stats = repo.get_stats()
        assert stats.age_buckets.get("gt_30m", 0) == 1
        assert stats.age_buckets.get("lt_1m", 0) == 1


# ============================================================
# misc
# ============================================================

class TestListing:
    def test_list_by_internal_id(self, repo):
        repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        repo.enqueue(internal_id=1001, op_type="flag_sync", target="notion", payload={})
        repo.enqueue(internal_id=1002, op_type="flag_sync", target="mailapp", payload={})

        rows = repo.list_by_internal_id(1001)
        assert len(rows) == 2

    def test_list_dead_letter(self, repo):
        oid = repo.enqueue(internal_id=1001, op_type="flag_sync", target="mailapp", payload={})
        for _ in range(5):
            repo.mark_failed(oid, "x", max_attempts=5)

        rows = repo.list_dead_letter()
        assert len(rows) == 1
        assert rows[0].outbox_id == oid

    def test_get_unknown_returns_none(self, repo):
        assert repo.get(99999) is None


class TestCountPending:
    def test_counts_only_unfinished_statuses(self, repo):
        """pending/processing/failed 计入; done/dead_letter 不计."""
        oid_pending = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="mailapp", payload={}
        )
        oid_done = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="notion", payload={}
        )
        repo.mark_processing(oid_done)
        repo.mark_done(oid_done)

        assert repo.count_pending(1001) == 1
        assert repo.count_pending(1001, op_type="flag_sync") == 1
        # 别的邮件不串台
        assert repo.count_pending(1002) == 0

        # failed (未 dead_letter) 也算未派发完成
        repo.mark_processing(oid_pending)
        repo.mark_failed(oid_pending, "boom", max_attempts=5)
        assert repo.count_pending(1001) == 1

    def test_op_type_filter(self, repo):
        repo.enqueue(
            internal_id=1001, op_type="status_sync", target="notion", payload={}
        )
        assert repo.count_pending(1001, op_type="flag_sync") == 0
        assert repo.count_pending(1001) == 1


# ============================================================
# helpers
# ============================================================

class TestBackoffHelper:
    def test_attempts_1_uses_first_backoff(self):
        before = time.time()
        result = _backoff_next_retry_at(1)
        assert result >= before + _BACKOFF_SECONDS[0] - 1

    def test_attempts_caps_at_last_bucket(self):
        before = time.time()
        # attempts=100 → use last bucket (7200s)
        result = _backoff_next_retry_at(100)
        assert result >= before + _BACKOFF_SECONDS[-1] - 1
        assert result <= before + _BACKOFF_SECONDS[-1] + 5

    def test_attempts_0_uses_first_backoff(self):
        """attempts=0 异常输入仍走 _BACKOFF_SECONDS[0]."""
        before = time.time()
        result = _backoff_next_retry_at(0)
        assert result >= before + _BACKOFF_SECONDS[0] - 1
