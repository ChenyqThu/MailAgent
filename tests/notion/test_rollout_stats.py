"""NotionSync v4 rollout stats counter + flush_rollout_stats (PR-4 US-008).

不真连 Notion / AppleScript, 直接调 NotionSync.record_* / snapshot / flush.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "s.db"))


@pytest.fixture
def notion_sync(store: SyncStore) -> NotionSync:
    from src.repository import AttachmentStore, EmailRepository

    repo = EmailRepository(
        db_path=str(store.db_path),
        attachment_store=AttachmentStore(str(store.db_path.parent / "att")),
    )
    return NotionSync(email_repo=repo, sync_store=store)


def test_initial_counters_zero(notion_sync):
    # 通过 __init__ 走的 ns 应有初始 0; snapshot 是 caller-safe 即使 __new__ bypass
    assert notion_sync.snapshot_rollout_stats() == {
        "from_sqlite_hit": 0,
        "fallback_miss": 0,
        "fallback_error": 0,
        "route_latency_p99_ms": 0.0,
        "body_miss_internal_ids": [],
    }


def test_record_route_hit_accumulates(notion_sync):
    notion_sync.record_route_hit(latency_ms=10.0)
    notion_sync.record_route_hit(latency_ms=20.0)
    notion_sync.record_route_hit(latency_ms=15.0)
    assert notion_sync._route_hit == 3
    assert sorted(notion_sync._route_latency_samples) == [10.0, 15.0, 20.0]


def test_record_route_miss_and_recent_ids(notion_sync):
    notion_sync.record_route_miss(53001)
    notion_sync.record_route_miss(53002)
    notion_sync.record_route_miss(53003)
    assert notion_sync._route_miss == 3
    assert list(notion_sync._body_miss_recent) == [53001, 53002, 53003]


def test_body_miss_recent_caps_at_10(notion_sync):
    for i in range(15):
        notion_sync.record_route_miss(53000 + i)
    assert len(notion_sync._body_miss_recent) == 10
    assert list(notion_sync._body_miss_recent) == list(range(53005, 53015))


def test_record_route_error(notion_sync):
    notion_sync.record_route_error()
    notion_sync.record_route_error()
    assert notion_sync._route_error == 2


def test_snapshot_resets_counters(notion_sync):
    notion_sync.record_route_hit(latency_ms=10.0)
    notion_sync.record_route_miss(53001)
    notion_sync.record_route_error()

    snap = notion_sync.snapshot_rollout_stats()
    assert snap["from_sqlite_hit"] == 1
    assert snap["fallback_miss"] == 1
    assert snap["fallback_error"] == 1
    assert snap["route_latency_p99_ms"] == pytest.approx(10.0)
    assert snap["body_miss_internal_ids"] == [53001]

    snap2 = notion_sync.snapshot_rollout_stats()
    assert snap2["from_sqlite_hit"] == 0
    assert snap2["fallback_miss"] == 0
    assert snap2["fallback_error"] == 0
    # body_miss_recent 是滚动窗口 — 不清
    assert snap2["body_miss_internal_ids"] == [53001]


def test_snapshot_p99_with_many_samples(notion_sync):
    """100 samples 1..100 (latency_ms=0 被 record_route_hit filter 掉).

    nearest-rank for n=100: idx = (99*100+99)//100 - 1 = 99 - 1 = 98.
    sorted = [1, 2, ..., 100], sorted[98] = 99.
    """
    for i in range(1, 101):
        notion_sync.record_route_hit(latency_ms=float(i))
    snap = notion_sync.snapshot_rollout_stats()
    assert snap["route_latency_p99_ms"] == pytest.approx(99.0)


def test_snapshot_p99_small_window_uses_max(notion_sync):
    """PR-4 codex critic round 1 fix: 小窗 n=2 应返回 max(samples), 不是 min."""
    notion_sync.record_route_hit(latency_ms=10.0)
    notion_sync.record_route_hit(latency_ms=100.0)
    snap = notion_sync.snapshot_rollout_stats()
    # nearest-rank: ceil(0.99*2)-1 = ceil(1.98)-1 = 2-1 = 1 → sorted[1] = 100.0
    assert snap["route_latency_p99_ms"] == pytest.approx(100.0)


def test_snapshot_p99_three_samples_uses_max(notion_sync):
    """n=3: ceil(0.99*3)-1 = ceil(2.97)-1 = 3-1 = 2 → sorted[2] = max."""
    notion_sync.record_route_hit(latency_ms=5.0)
    notion_sync.record_route_hit(latency_ms=50.0)
    notion_sync.record_route_hit(latency_ms=500.0)
    snap = notion_sync.snapshot_rollout_stats()
    assert snap["route_latency_p99_ms"] == pytest.approx(500.0)


def test_flush_writes_to_sync_store(notion_sync, store):
    notion_sync.record_route_hit(latency_ms=5.0)
    notion_sync.record_route_hit(latency_ms=10.0)
    notion_sync.record_route_miss(53001)

    rowid = notion_sync.flush_rollout_stats(sync_store=store, window_seconds=60)
    assert rowid is not None and rowid > 0

    latest = store.get_latest_v4_rollout()
    assert latest is not None
    assert latest["from_sqlite_hit"] == 2
    assert latest["fallback_miss"] == 1
    assert latest["fallback_error"] == 0
    assert latest["window_seconds"] == 60
    assert latest["body_miss_internal_ids"] == [53001]


def test_flush_resets_counters(notion_sync, store):
    notion_sync.record_route_hit(latency_ms=10.0)
    notion_sync.flush_rollout_stats(sync_store=store)
    assert notion_sync._route_hit == 0


def test_flush_with_zero_traffic_still_writes(notion_sync, store):
    rowid = notion_sync.flush_rollout_stats(sync_store=store)
    assert rowid is not None
    latest = store.get_latest_v4_rollout()
    assert latest["from_sqlite_hit"] == 0
    assert latest["fallback_miss"] == 0
