"""单测：SyncStore v7 island_dispatch 表 + 评估指标聚合."""

from __future__ import annotations

import time
from pathlib import Path

from src.mail.sync_store import SyncStore


def test_db_version_bumped_to_7(tmp_path: Path):
    store = SyncStore(str(tmp_path / "test.db"))
    assert store.DB_VERSION == 7
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
