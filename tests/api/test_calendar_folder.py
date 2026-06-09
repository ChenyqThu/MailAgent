"""calendar READ endpoints (src/api/routers/calendar.py).

Phase B §2 calendar READ endpoints. Exercised against a REAL-schema SQLite DB
(conftest `cal_folder_client` / `cal_folder_db`) seeded with calendar_event
rows, going through the actual CalendarService the router builds internally.

Discipline checks the handoff calls out for this lane (§2):
  - calendar reads carry the §3.4 envelope with meta.source='sqlite'.

NOTE: the old folder READ endpoints (/api/folder/{folder}/list|search|{id},
/by-id, /sync-status) backed by the never-used folder_email table were removed
in P6 (folder_sync display-path cleanup); their tests went with them.
"""

from __future__ import annotations

from tests.api.conftest import (
    CAL_DELETED_UID,
    CAL_EVENT_UID,
    CAL_NAME,
    CAL_WINDOW_FROM,
    CAL_WINDOW_TO,
)


def _ok_envelope(payload: dict) -> None:
    assert payload["status"] == "success"
    assert payload["schema_version"] == 1
    assert payload["error"] is None
    assert payload["meta"]["source"] == "sqlite"
    assert payload["meta"]["duration_ms"] >= 0


def _err(payload: dict, *, code: str) -> None:
    assert payload["status"] == "error"
    assert payload["data"] is None
    assert payload["error"]["code"] == code


# ===========================================================================
# GET /api/calendar/events
# ===========================================================================


def test_calendar_events_window(cal_folder_client):
    r = cal_folder_client.get(
        "/api/calendar/events",
        params={"fromIso": CAL_WINDOW_FROM, "toIso": CAL_WINDOW_TO},
    )
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    # C7: data is the bare CalendarEventOccurrence[] (not {events,total,window,filters}).
    data = body["data"]
    assert isinstance(data, list)
    assert len(data) == 1  # the soft-deleted event is excluded.
    ev = data[0]
    assert ev["ical_uid"] == CAL_EVENT_UID
    assert ev["summary"] == "Sprint Planning"
    assert ev["calendar_name"] == CAL_NAME
    # occurrence shape (occurrence_to_dict) — ISO occurrence bounds present.
    assert ev["occurrence_start_iso"].startswith("2026-06-01")
    # C7: total / window / filters moved onto envelope meta.
    assert body["meta"]["total"] == 1
    assert body["meta"]["limit"] == 1000
    assert body["meta"]["window"]["from_iso"].startswith("2026-06-01")
    assert "filters" in body["meta"]


def test_calendar_events_default_window_7d(cal_folder_client):
    # No fromIso/toIso → defaults to today 00:00 UTC + 7d. The 2026-06 event is
    # outside "today" but the endpoint must still 200 with a valid envelope.
    r = cal_folder_client.get("/api/calendar/events")
    assert r.status_code == 200
    _ok_envelope(r.json())
    # C7: data is the bare occurrences array.
    assert isinstance(r.json()["data"], list)


def test_calendar_events_filter_calendar_name(cal_folder_client):
    r = cal_folder_client.get(
        "/api/calendar/events",
        params={
            "fromIso": CAL_WINDOW_FROM, "toIso": CAL_WINDOW_TO,
            "calendarName": CAL_NAME,
        },
    )
    assert r.status_code == 200
    body = r.json()
    # C7: filters live on meta; data is the bare occurrences array.
    assert body["meta"]["filters"]["calendar_name"] == CAL_NAME
    assert [e["ical_uid"] for e in body["data"]] == [CAL_EVENT_UID]


def test_calendar_events_bad_source_400(cal_folder_client):
    r = cal_folder_client.get("/api/calendar/events", params={"source": "bogus"})
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_calendar_events_bad_from_iso_400(cal_folder_client):
    r = cal_folder_client.get(
        "/api/calendar/events", params={"fromIso": "not-a-date"}
    )
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_calendar_events_limit_out_of_range_422(cal_folder_client):
    r = cal_folder_client.get("/api/calendar/events", params={"limit": 999999})
    assert r.status_code == 422  # FastAPI le=5000 validation, not our envelope.


# ===========================================================================
# GET /api/calendar/events/{event_id}
# ===========================================================================


def test_calendar_event_get(cal_folder_client):
    r = cal_folder_client.get(f"/api/calendar/events/{CAL_EVENT_UID}")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    # C7: data is the bare CalendarEventDetail (full row_to_dict — has
    # description/ics_raw), NOT a {event} wrapper.
    ev = body["data"]
    assert ev["ical_uid"] == CAL_EVENT_UID
    assert ev["summary"] == "Sprint Planning"
    assert "description" in ev
    assert ev["dtstart_iso"].startswith("2026-06-01")


def test_calendar_event_get_missing_404(cal_folder_client):
    r = cal_folder_client.get("/api/calendar/events/does-not-exist")
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_calendar_event_get_bad_source_400(cal_folder_client):
    r = cal_folder_client.get(
        f"/api/calendar/events/{CAL_EVENT_UID}", params={"source": "nope"}
    )
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


# ===========================================================================
# GET /api/calendar/sync-status
# ===========================================================================


def test_calendar_sync_status(cal_folder_client):
    r = cal_folder_client.get("/api/calendar/sync-status")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    # C7: data is the bare CalendarSyncStateItem[] (not {calendars,total,worker_enabled}).
    data = body["data"]
    assert isinstance(data, list)
    assert len(data) == 1
    cal = data[0]
    assert cal["calendar_name"] == CAL_NAME
    assert cal["ctag"] == "ctag-1"
    assert cal["sync_token"] == "tok-1"
    # C7: total / worker_enabled moved onto envelope meta. worker_enabled mirrors
    # config CALENDAR_CALDAV_SYNC_ENABLED (stub → False).
    assert body["meta"]["total"] == 1
    assert body["meta"]["worker_enabled"] is False


# ===========================================================================
# GET /api/calendar/names
# ===========================================================================


def test_calendar_names_excludes_deleted(cal_folder_client):
    r = cal_folder_client.get("/api/calendar/names")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    # distinct non-deleted calendar_name only → "Work", NOT the soft-deleted
    # "GhostCal".
    assert body["data"] == [CAL_NAME]
    assert "GhostCal" not in body["data"]
    assert body["meta"]["count"] == 1
    # sanity: the deleted uid never leaks into names.
    assert CAL_DELETED_UID not in str(body["data"])
