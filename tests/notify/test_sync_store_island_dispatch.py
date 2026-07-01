"""单测：SyncStore v7 island_dispatch 表 + 评估指标聚合."""

from __future__ import annotations

from pathlib import Path

from src.mail.sync_store import SyncStore


def test_db_version_bumped_to_7(tmp_path: Path):
    """v7 ship 时定的 baseline；后续 v8/v9/v10 演进只检查 island_dispatch 仍在 + 版本 >= 7。"""
    store = SyncStore(str(tmp_path / "test.db"))
    assert store.DB_VERSION >= 7
    # 表存在
    with store._connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='island_dispatch'"
        )
        assert cur.fetchone() is not None


def test_record_island_dispatch_returns_row_id(tmp_path: Path):
    store = SyncStore(str(tmp_path / "test.db"))
    rid = store.record_island_dispatch(
        event_type="MailReceived",
        session_key="mailagent:email:42",
        dispatched_ok=True,
        response_decision=None,
        response_latency_ms=18,
        internal_id=42,
    )
    assert rid is not None and rid > 0


def test_dispatch_stats_aggregation(tmp_path: Path):
    store = SyncStore(str(tmp_path / "test.db"))
    # 4 条事件：3 ok, 1 ok+decision，2 个 reviewed
    store.record_island_dispatch(event_type="MailReceived", dispatched_ok=True,
                                  internal_id=1)
    store.record_island_dispatch(event_type="LLMReviewed", dispatched_ok=True,
                                  internal_id=2)
    store.record_island_dispatch(event_type="LLMReviewedUrgent", dispatched_ok=True,
                                  response_decision="open_mail", internal_id=3)
    store.record_island_dispatch(event_type="MailCompleted", dispatched_ok=False,
                                  internal_id=4)
    stats = store.get_island_dispatch_stats(days=14)
    assert stats["total"] == 4
    assert stats["dispatched_ok"] == 3
    assert stats["responded"] == 1
    assert stats["urgent_or_reviewed"] >= 2
    assert 0 < stats["dispatched_ok_rate"] <= 1.0


def test_record_does_not_raise_on_missing_optional_args(tmp_path: Path):
    """DeadLetterAccum 没有 internal_id；record 函数必须接受 None 不抛."""
    store = SyncStore(str(tmp_path / "test.db"))
    rid = store.record_island_dispatch(
        event_type="DeadLetterAccum",
        session_key="mailagent:system:dead_letter",
        dispatched_ok=True,
        internal_id=None,
    )
    assert rid is not None


def test_was_island_notified_persistent_dedup(tmp_path: Path):
    """契约 §9-2: 持久去重查询——按 (event_type, internal_id) 查最近成功派发行."""
    store = SyncStore(str(tmp_path / "test.db"))
    # 空表 → False
    assert store.was_island_notified(event_type="LLMReviewedUrgent", internal_id=42) is False
    # 记录一次成功派发 → True
    store.record_island_dispatch(
        event_type="LLMReviewedUrgent", session_key="mailagent:email:42",
        dispatched_ok=True, internal_id=42,
    )
    assert store.was_island_notified(event_type="LLMReviewedUrgent", internal_id=42) is True
    # 不同 event_type / 不同邮件 → 不匹配
    assert store.was_island_notified(event_type="MailReceived", internal_id=42) is False
    assert store.was_island_notified(event_type="LLMReviewedUrgent", internal_id=99) is False
    # 失败派发 (dispatched_ok=0) 不算已通知 (允许重试)
    store.record_island_dispatch(
        event_type="MailReceived", internal_id=43, dispatched_ok=False,
    )
    assert store.was_island_notified(event_type="MailReceived", internal_id=43) is False
    # within_sec=0 → 无"最近"窗口 (sent_at > now-0 永不成立)
    assert store.was_island_notified(
        event_type="LLMReviewedUrgent", internal_id=42, within_sec=0,
    ) is False
    # 系统事件按 session_key 匹配 (无 internal_id)
    store.record_island_dispatch(
        event_type="DeadLetterAccum", session_key="mailagent:system:dead_letter",
        dispatched_ok=True, internal_id=None,
    )
    assert store.was_island_notified(
        event_type="DeadLetterAccum", session_key="mailagent:system:dead_letter",
    ) is True
