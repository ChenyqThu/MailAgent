"""SyncStore.recurring_series 表的测试（in-memory SQLite via tmp file）."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "test_sync_store.db"))


def test_table_created(store: SyncStore):
    """recurring_series 表应在 _init_database 阶段创建。"""
    with store._connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='recurring_series'"
        )
        assert cursor.fetchone() is not None


def test_upsert_and_get(store: SyncStore):
    payload = {
        "series_uid": "evt-1",
        "rrule_str": "FREQ=WEEKLY;BYDAY=TU",
        "master_dtstart": "2026-04-21T14:00:00+08:00",
        "master_dtend": "2026-04-21T15:00:00+08:00",
        "master_summary": "对齐会",
        "master_organizer": "Alice",
        "master_organizer_email": "alice@example.com",
        "master_tzid": "China Standard Time",
        "last_sequence": 1,
    }
    assert store.upsert_recurring_series(payload) is True

    row = store.get_recurring_series("evt-1")
    assert row is not None
    assert row["rrule_str"] == "FREQ=WEEKLY;BYDAY=TU"
    assert row["master_summary"] == "对齐会"
    assert row["last_sequence"] == 1
    assert row["exdates_json"] == "[]"


def test_upsert_updates_existing_row(store: SyncStore):
    base = {
        "series_uid": "evt-2",
        "rrule_str": "FREQ=WEEKLY",
        "master_dtstart": "2026-04-21T14:00:00+08:00",
        "master_dtend": "2026-04-21T15:00:00+08:00",
        "last_sequence": 0,
    }
    store.upsert_recurring_series(base)

    bumped = {**base, "rrule_str": "FREQ=WEEKLY;BYDAY=WE", "last_sequence": 2}
    store.upsert_recurring_series(bumped)

    row = store.get_recurring_series("evt-2")
    assert row["rrule_str"] == "FREQ=WEEKLY;BYDAY=WE"
    assert row["last_sequence"] == 2


def test_upsert_missing_required_returns_false(store: SyncStore):
    assert store.upsert_recurring_series({"series_uid": "x"}) is False


def test_append_exdate_dedups(store: SyncStore):
    store.upsert_recurring_series(
        {
            "series_uid": "evt-3",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": "2026-04-21T14:00:00+08:00",
            "master_dtend": "2026-04-21T15:00:00+08:00",
        }
    )
    assert store.append_exdate("evt-3", "2026-04-28T14:00:00+08:00") is True
    assert store.append_exdate("evt-3", "2026-05-05T14:00:00+08:00") is True
    # 重复添加不会出现两次
    assert store.append_exdate("evt-3", "2026-04-28T14:00:00+08:00") is True

    row = store.get_recurring_series("evt-3")
    parsed = json.loads(row["exdates_json"])
    assert parsed == [
        "2026-04-28T14:00:00+08:00",
        "2026-05-05T14:00:00+08:00",
    ]


def test_append_exdate_unknown_uid(store: SyncStore):
    assert store.append_exdate("nonexistent", "2026-04-28T14:00:00+08:00") is False


def test_update_expanded_until(store: SyncStore):
    store.upsert_recurring_series(
        {
            "series_uid": "evt-4",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": "2026-04-21T14:00:00+08:00",
            "master_dtend": "2026-04-21T15:00:00+08:00",
        }
    )
    assert store.update_expanded_until("evt-4", "2026-06-01T00:00:00+00:00") is True
    row = store.get_recurring_series("evt-4")
    assert row["last_expanded_until"] == "2026-06-01T00:00:00+00:00"


def test_iter_series_needing_expansion(store: SyncStore):
    # 三个系列：未展开、低水位、高水位
    store.upsert_recurring_series(
        {
            "series_uid": "low-1",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": "2026-04-21T14:00:00+08:00",
            "master_dtend": "2026-04-21T15:00:00+08:00",
            "last_expanded_until": "2026-04-30T00:00:00+00:00",  # 低于 cutoff
        }
    )
    store.upsert_recurring_series(
        {
            "series_uid": "fresh-1",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": "2026-04-21T14:00:00+08:00",
            "master_dtend": "2026-04-21T15:00:00+08:00",
            # last_expanded_until=NULL → 应被选中
        }
    )
    store.upsert_recurring_series(
        {
            "series_uid": "high-1",
            "rrule_str": "FREQ=WEEKLY",
            "master_dtstart": "2026-04-21T14:00:00+08:00",
            "master_dtend": "2026-04-21T15:00:00+08:00",
            "last_expanded_until": "2026-08-01T00:00:00+00:00",  # 高于 cutoff
        }
    )

    cutoff = "2026-06-01T00:00:00+00:00"
    selected = {row["series_uid"] for row in store.iter_series_needing_expansion(cutoff)}
    assert selected == {"low-1", "fresh-1"}


def test_get_recurring_series_unknown(store: SyncStore):
    assert store.get_recurring_series("unknown-uid") is None
