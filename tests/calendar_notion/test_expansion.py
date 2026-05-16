"""Shared recurring expansion tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.calendar_notion.expansion import (
    reconstruct_invite_from_series_row,
    run_expansion_tick,
)


class FakeSyncStore:
    def __init__(self, rows):
        self.rows = list(rows)
        self.expanded_until_calls: list[tuple[str, str]] = []

    def iter_series_needing_expansion(self, cutoff_iso):
        return iter(self.rows)

    def update_expanded_until(self, series_uid, cutoff_iso):
        self.expanded_until_calls.append((series_uid, cutoff_iso))
        return True


def _series_row(uid: str, *, count: int = 2) -> dict:
    start = datetime.now(timezone.utc) + timedelta(days=1)
    end = start + timedelta(hours=1)
    return {
        "series_uid": uid,
        "rrule_str": f"FREQ=WEEKLY;COUNT={count}",
        "master_dtstart": start.isoformat(),
        "master_dtend": end.isoformat(),
        "master_summary": "Weekly Sync",
        "master_location": "Teams",
        "master_description": "join",
        "master_organizer": "Alice",
        "master_organizer_email": "alice@example.com",
        "master_is_all_day": 0,
        "master_tzid": "UTC",
        "last_sequence": 3,
        "exdates_json": "[]",
        "last_expanded_until": None,
    }


@pytest.mark.asyncio
async def test_run_expansion_tick_no_series():
    sync_store = FakeSyncStore([])
    meeting_sync = MagicMock()
    meeting_sync.calendar_sync.sync_event = AsyncMock()

    result = await run_expansion_tick(sync_store, meeting_sync, horizon_weeks=4)

    assert result == {"series_scanned": 0, "occurrences_synced": 0, "errors": []}
    meeting_sync.calendar_sync.sync_event.assert_not_awaited()
    assert sync_store.expanded_until_calls == []


@pytest.mark.asyncio
async def test_run_expansion_tick_one_series_two_occurrences():
    sync_store = FakeSyncStore([_series_row("uid-1", count=2)])
    meeting_sync = MagicMock()
    meeting_sync.calendar_sync.sync_event = AsyncMock(return_value=("created", "page"))

    result = await run_expansion_tick(sync_store, meeting_sync, horizon_weeks=4)

    assert result["series_scanned"] == 1
    assert result["occurrences_synced"] == 2
    assert result["errors"] == []
    assert meeting_sync.calendar_sync.sync_event.await_count == 2
    assert len(sync_store.expanded_until_calls) == 1
    assert sync_store.expanded_until_calls[0][0] == "uid-1"


@pytest.mark.asyncio
async def test_failed_sync_does_not_advance_watermark():
    sync_store = FakeSyncStore([_series_row("S1", count=2)])
    meeting_sync = MagicMock()
    meeting_sync.calendar_sync.sync_event = AsyncMock(
        side_effect=[("created", "page"), RuntimeError("boom")]
    )

    result = await run_expansion_tick(sync_store, meeting_sync, horizon_weeks=4)

    assert result["series_scanned"] == 1
    assert result["occurrences_synced"] == 1
    assert len(result["errors"]) == 1
    assert result["errors"][0]["series_uid"] == "S1"
    assert "boom" in result["errors"][0]["error"]
    assert meeting_sync.calendar_sync.sync_event.await_count == 2
    assert sync_store.expanded_until_calls == []


@pytest.mark.asyncio
async def test_run_expansion_tick_dry_run_mode():
    sync_store = FakeSyncStore([_series_row("uid-dry", count=2)])
    meeting_sync = MagicMock()
    meeting_sync.calendar_sync.sync_event = AsyncMock(return_value=("created", "page"))

    result = await run_expansion_tick(
        sync_store, meeting_sync, horizon_weeks=4, dry_run=True,
    )

    assert result["series_scanned"] == 1
    assert result["occurrences_synced"] == 2
    assert result["errors"] == []
    meeting_sync.calendar_sync.sync_event.assert_not_awaited()
    assert sync_store.expanded_until_calls == []


def test_reconstruct_invite_from_series_row():
    row = _series_row("uid-2", count=4)

    invite = reconstruct_invite_from_series_row(row)

    assert invite is not None
    assert invite.uid == "uid-2"
    assert invite.summary == "Weekly Sync"
    assert invite.start_time == datetime.fromisoformat(row["master_dtstart"])
    assert invite.end_time == datetime.fromisoformat(row["master_dtend"])
    assert invite.recurrence_rule == "FREQ=WEEKLY;COUNT=4"
    assert invite.sequence == 3
    assert invite.organizer_email == "alice@example.com"


def test_reconstruct_invite_invalid_dtstart(monkeypatch):
    import src.calendar_notion.expansion as expansion_mod

    logger = MagicMock()
    monkeypatch.setattr(expansion_mod, "logger", logger)
    row = _series_row("uid-bad")
    row.pop("master_dtstart")

    invite = expansion_mod.reconstruct_invite_from_series_row(row)

    assert invite is None
    logger.warning.assert_called_once()
    assert "cannot rehydrate series uid-bad" in logger.warning.call_args.args[0]
