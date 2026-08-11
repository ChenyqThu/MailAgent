from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from src.mail.sync_store import SyncStore
from src.matters.attention import AttentionService, SNOOZE_3D_MS
from src.matters.repository import MatterRepository
from src.matters.service import MatterService

DAY = 24 * 60 * 60 * 1000
NOW = int(datetime(2026, 8, 11, 12, tzinfo=timezone.utc).timestamp() * 1000)


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "attention.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    base = MatterService(repo, clock_ms=lambda: NOW)
    attention = AttentionService(repo, clock_ms=lambda: NOW)
    return str(path), repo, base, attention


def _create(base, title, **fields):
    result = base.create_matter(
        {"title": title, **fields}, idempotency_key=f"create:{title}", source="test"
    )
    return result["matter"]


def _action(path, matter_id, *, title, status, due_at=None, updated_at=NOW):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_item(matter_id,kind,title,status,due_at,checklist_json," 
            "created_by_kind,version,created_at,updated_at) VALUES (?,'action',?,?,?,'[]','user',1,?,?)",
            (matter_id, title, status, due_at, updated_at, updated_at),
        )
        conn.commit()


def test_predicate_table_boundaries_and_context_gap_has_no_producer(env):
    path, _, base, attention = env
    wait = _create(base, "wait")
    _action(path, wait["id"], title="客户回复", status="waiting", updated_at=NOW - 7 * DAY)
    action = _create(base, "action")
    _action(path, action["id"], title="提交方案", status="open", due_at=NOW - DAY)
    deadline = _create(base, "deadline", due_at=NOW + 3 * DAY)
    health = _create(base, "health", health="off_track")
    review = _create(base, "review")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_update(matter_id,review_status,anchored_matter_version," 
            "original_proposal_json,changes_json,citations_json,created_by_kind,created_at) "
            "VALUES (?,'pending',1,'{}','[]','[]','agent',?)",
            (review["id"], NOW),
        )
        conn.commit()
    attention.reconcile()
    kinds = {row["kind"] for row in attention.list_attention(state="open")}
    assert {"wait_overdue", "action_overdue", "deadline_near", "health_down", "needs_review"} <= kinds
    assert "context_gap" not in kinds


def test_dismiss_requires_fact_clear_before_recurrence(env):
    path, _, base, attention = env
    matter = _create(base, "health", health="at_risk")
    attention.reconcile()
    signal = attention.list_attention(public_id=matter["public_id"])[0]
    attention.triage(matter["public_id"], signal["id"], "dismiss", idempotency_key="dismiss")
    attention.reconcile()
    assert attention.list_attention(public_id=matter["public_id"], state="open") == []
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE matter SET health='on_track' WHERE id=?", (matter["id"],))
        conn.commit()
    attention.reconcile()
    with sqlite3.connect(path) as conn:
        cleared = conn.execute("SELECT cleared_at FROM matter_attention WHERE id=?", (signal["id"],)).fetchone()[0]
        assert cleared == NOW
        conn.execute("UPDATE matter SET health='at_risk' WHERE id=?", (matter["id"],))
        conn.commit()
    attention.reconcile()
    reopened = attention.list_attention(public_id=matter["public_id"])[0]
    assert reopened["recurrence_no"] == 2


def test_snooze_expiry_and_severity_upgrade_clear_notification_ack(tmp_path):
    path = tmp_path / "clock.db"
    SyncStore(str(path))
    clock = {"now": NOW}
    repo = MatterRepository(path)
    base = MatterService(repo, clock_ms=lambda: clock["now"])
    attention = AttentionService(repo, clock_ms=lambda: clock["now"])
    matter = _create(base, "health", health="at_risk")
    attention.reconcile()
    signal = attention.list_attention(public_id=matter["public_id"])[0]
    attention.acknowledge_notified(matter["public_id"], signal["id"])
    attention.triage(
        matter["public_id"], signal["id"], "snooze", idempotency_key="snooze",
        until=NOW + SNOOZE_3D_MS,
    )
    clock["now"] = NOW + SNOOZE_3D_MS + 1
    attention.reconcile()
    opened = attention.list_attention(public_id=matter["public_id"])[0]
    assert opened["state"] == "open" and opened["last_notified_at"] is None
    attention.acknowledge_notified(matter["public_id"], signal["id"])
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE matter SET health='off_track' WHERE id=?", (matter["id"],))
        conn.commit()
    attention.reconcile()
    upgraded = attention.list_attention(public_id=matter["public_id"])[0]
    assert upgraded["severity"] == "critical"
    assert upgraded["last_notified_at"] is None


def test_notification_two_phase_and_episode_dedup(env):
    _, _, base, attention = env
    matter = _create(base, "health", health="off_track")
    attention.reconcile()
    first = attention.eligible_notifications("high")
    assert len(first) == 1
    assert len(attention.eligible_notifications("high")) == 1
    attention.acknowledge_notified(matter["public_id"], first[0]["id"])
    assert attention.eligible_notifications("high") == []
    attention.triage(matter["public_id"], first[0]["id"], "resolve", idempotency_key="resolve")
    attention.reconcile()
    second = attention.eligible_notifications("high")
    assert len(second) == 1 and second[0]["id"] != first[0]["id"]
