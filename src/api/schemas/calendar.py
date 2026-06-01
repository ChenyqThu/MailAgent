"""Calendar READ endpoint response models (calendar.{eventsList,eventGet,
syncStatus,calendarNames}).

Only the READ subset is in scope for web (all calendar WRITE/RSVP/CRUD are
Electron-only reductions).

**C7 — envelope ``data`` is the bare frontend shape** (handoff codex-review-fixes
§calendar.py): the HttpApi (Workflow ②) consumes ``envelope.data`` directly as the
``CalendarApi`` return type with **no remap**, so ``data`` is the array / object the
frontend expects, NOT a ``{events,...}`` / ``{calendars,...}`` / ``{event}`` wrapper:

  * eventsList  → ``data`` = ``list[CalendarOccurrence]`` (frontend CalendarEventOccurrence[]);
                  total / window / filters live on envelope ``meta``.
  * eventGet    → ``data`` = ``CalendarEventDetail`` (frontend CalendarEventDetail; 404→null).
  * syncStatus  → ``data`` = ``list[CalendarSyncStateItem]`` (frontend CalendarSyncStateItem[]);
                  total / worker_enabled live on envelope ``meta``.
  * calendarNames → ``data`` = ``list[str]``.

The per-element models below (CalendarOccurrence / CalendarEventDetail /
CalendarSyncStateItem) are therefore the **element** shapes of those arrays (and the
eventGet object), mirroring the CLI ``calendar`` subcommand element dicts
(occurrence_to_dict / row_to_dict / list_sync_states[]). CalendarWindow / CalendarFilters
now document the ``meta.window`` / ``meta.filters`` sub-objects the events endpoint emits.

The frontend types parse `attendees` into structured CalendarEventAttendee
objects, but the CLI schema leaves `attendees` as a free-form array — we keep it
as list[Any] to forward whatever the CLI emits without lossy coercion.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

CalendarEventSource = Literal["caldav", "email_ics", "legacy_calendar_app"]


# --- events list / today / week ---------------------------------------------
class CalendarOccurrence(BaseModel):
    """One RRULE-expanded occurrence (calendar-events-list.schema.json occurrence).

    Frontend alias: CalendarEventOccurrence.
    """

    model_config = {"extra": "allow"}

    id: int = Field(..., ge=1)
    ical_uid: str
    recurrence_id: Optional[str] = None
    sequence: int = Field(..., ge=0)
    summary: str
    occurrence_start_iso: str
    occurrence_end_iso: str
    is_recurrence_instance: bool
    is_all_day: bool
    calendar_name: str
    organizer: str
    attendees: list[Any]
    location: str
    url: str
    status: str
    response_status: str
    source: CalendarEventSource
    notion_page_id: Optional[str] = None
    related_email_internal_id: Optional[int] = None


class CalendarWindow(BaseModel):
    """Shape of ``meta.window`` on ``GET /api/calendar/events`` (C7)."""

    from_iso: str
    to_iso: str


class CalendarFilters(BaseModel):
    """Shape of ``meta.filters`` on ``GET /api/calendar/events`` (C7)."""

    calendar_name: Optional[str] = None
    source: Optional[str] = None
    expand_recurrences: bool


class CalendarEventsListData(BaseModel):
    """Legacy CLI ``calendar events`` ``data`` wrapper (calendar-events-list.schema.json).

    **C7**: the web ``GET /api/calendar/events`` envelope no longer returns this
    wrapper as ``data`` — ``data`` is the bare ``list[CalendarOccurrence]`` and these
    three side fields move to envelope ``meta`` (``meta.total`` / ``meta.window`` /
    ``meta.filters``). Kept as the shared CLI-shape doc + meta field reference.
    """

    events: list[CalendarOccurrence]
    total: int = Field(..., ge=0)
    window: CalendarWindow
    filters: CalendarFilters


# --- event get --------------------------------------------------------------
class CalendarEventDetail(BaseModel):
    """Full calendar_event row (calendar-event-get.schema.json event).

    Frontend alias: CalendarEventDetail.
    """

    model_config = {"extra": "allow"}

    id: int = Field(..., ge=1)
    ical_uid: str
    recurrence_id: Optional[str] = None
    sequence: int = Field(..., ge=0)
    summary: str
    description: str
    location: str
    organizer: str
    attendees: list[Any]
    dtstart_iso: Optional[str] = None
    dtend_iso: Optional[str] = None
    is_all_day: bool
    rrule: str
    exdates: list[str]
    rdates: list[str]
    status: str
    response_status: str
    url: str
    calendar_name: str
    source: CalendarEventSource
    notion_page_id: Optional[str] = None
    related_email_internal_id: Optional[int] = None
    ics_raw: str
    last_synced_at_iso: Optional[str] = None
    created_at_iso: Optional[str] = None
    updated_at_iso: Optional[str] = None


class CalendarEventGetData(BaseModel):
    """Legacy CLI ``calendar event-get`` ``data`` wrapper (wraps a single event).

    **C7**: the web ``GET /api/calendar/events/{event_id}`` envelope returns the bare
    ``CalendarEventDetail`` as ``data`` (404→null), NOT this ``{event}`` wrapper. Kept
    as the shared CLI-shape doc.
    """

    event: CalendarEventDetail


# --- sync status ------------------------------------------------------------
class CalendarSyncStateItem(BaseModel):
    """One calendar's CalDAV sync state (calendar-sync-status.schema.json).

    Frontend alias: CalendarSyncStateItem.
    """

    calendar_name: str
    ctag: Optional[str] = None
    sync_token: Optional[str] = None
    last_full_sync_at_iso: Optional[str] = None
    last_incremental_sync_at_iso: Optional[str] = None
    last_error: Optional[str] = None


class CalendarSyncStatusData(BaseModel):
    """Legacy CLI ``calendar sync-status`` ``data`` wrapper (calendar-sync-status.schema.json).

    **C7**: the web ``GET /api/calendar/sync-status`` envelope returns the bare
    ``list[CalendarSyncStateItem]`` as ``data``; ``total`` / ``worker_enabled`` move to
    envelope ``meta``. Kept as the shared CLI-shape doc + meta field reference.
    """

    calendars: list[CalendarSyncStateItem]
    total: int = Field(..., ge=0)
    worker_enabled: bool


__all__ = [
    "CalendarEventSource",
    "CalendarOccurrence", "CalendarWindow", "CalendarFilters",
    "CalendarEventsListData",
    "CalendarEventDetail", "CalendarEventGetData",
    "CalendarSyncStateItem", "CalendarSyncStatusData",
]
