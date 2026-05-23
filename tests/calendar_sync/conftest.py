"""Shared fixtures for calendar_sync tests."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pytest

from src.calendar_notion.caldav_reader import CalendarEvent
from src.calendar_sync import CalendarEventRepository
from src.mail.sync_store import SyncStore


@pytest.fixture
def fresh_db(tmp_path: Path) -> str:
    """Fresh SQLite DB with v15 schema. Returns path string."""
    db_path = tmp_path / "test.db"
    SyncStore(str(db_path))  # init schema
    return str(db_path)


@pytest.fixture
def repo(fresh_db: str) -> CalendarEventRepository:
    return CalendarEventRepository(fresh_db)


def _make_event(
    uid: str = "test-uid-1",
    *,
    summary: str = "Test event",
    start: Optional[datetime] = None,
    duration_hours: float = 1.0,
    rrule: str = "",
    recurrence_id: Optional[str] = None,
    sequence: int = 0,
    calendar_name: str = "Personal",
    response_status: str = "",
    status: str = "",
    organizer: str = "",
    attendees: Optional[list[str]] = None,
    location: str = "",
    description: str = "",
    url: str = "",
    exdates: Optional[list[str]] = None,
    rdates: Optional[list[str]] = None,
) -> CalendarEvent:
    """Test helper — build CalendarEvent with sensible defaults."""
    if start is None:
        start = datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=duration_hours)
    return CalendarEvent(
        summary=summary,
        start=start,
        end=end,
        organizer=organizer,
        attendees=attendees or [],
        location=location,
        description=description,
        url=url,
        ical_uid=uid,
        sequence=sequence,
        recurrence_id=recurrence_id,
        rrule=rrule,
        exdates=exdates or [],
        rdates=rdates or [],
        status=status,
        response_status=response_status,
        calendar_name=calendar_name,
    )


@pytest.fixture
def make_event():
    """Return the _make_event factory; pytest fixtures with parameters via call."""
    return _make_event
