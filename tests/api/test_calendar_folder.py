"""calendar + folder READ endpoints (src/api/routers/{calendar,folder}.py).

Phase B §2: 8 READ endpoints. Exercised against a REAL-schema SQLite DB
(conftest `cal_folder_client` / `cal_folder_db`) seeded with calendar_event +
folder_email rows, going through the actual CalendarService /
FolderEmailRepository the routers build internally.

Discipline checks the handoff calls out for this lane (§2 + gotcha #6):
  - calendar/folder reads carry the §3.4 envelope with meta.source='sqlite'.
  - folder reads go straight to folder_email / folder_email_fts and NEVER touch
    the davmail gate (the gate lives only on the CLI write path); we prove this
    by getting 200s for archive/drafts with NO MAILAGENT_BACKEND set.
  - route-ordering: /sync-status, /{folder}/search must not be swallowed by the
    /{folder}/{id:int} dynamic segment.
"""

from __future__ import annotations

from tests.api.conftest import (
    CAL_DELETED_UID,
    CAL_EVENT_UID,
    CAL_NAME,
    CAL_WINDOW_FROM,
    CAL_WINDOW_TO,
    FOLDER_ARCHIVE_SUBJECT,
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


# ===========================================================================
# GET /api/folder/{folder}/list  — proves NO davmail gate on the read path
# ===========================================================================


def test_folder_list_archive_no_davmail_gate(cal_folder_client):
    # gotcha #6: folder READS hit folder_email directly; with no MAILAGENT_BACKEND
    # set this must still 200 (the gate is CLI-write-only).
    r = cal_folder_client.get("/api/folder/archive/list")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    assert len(data) == 1
    row = data[0]
    # FolderEmailMeta projection — NO body_html/body_markdown on the list item,
    # and NEVER a host path (gotcha #1).
    assert "body_html" not in row
    assert "body_markdown" not in row
    assert "local_path" not in str(row)
    assert row["subject"] == FOLDER_ARCHIVE_SUBJECT
    assert row["is_flagged"] is True
    assert row["has_attachments"] is True
    # attachment projection = {filename,size,content_type} only.
    assert row["attachments"] == [
        {"filename": "a.pdf", "size": 12, "content_type": "application/pdf"}
    ]
    assert body["meta"]["count"] == 1
    assert body["meta"]["limit"] == 200
    assert body["meta"]["offset"] == 0


def test_folder_list_drafts(cal_folder_client):
    r = cal_folder_client.get("/api/folder/drafts/list")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["folder"] == "drafts"
    assert data[0]["attachments"] == []  # null attachments_json → []


def test_folder_list_bad_folder_400(cal_folder_client):
    r = cal_folder_client.get("/api/folder/spam/list")
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_folder_list_limit_out_of_range_422(cal_folder_client):
    r = cal_folder_client.get("/api/folder/archive/list", params={"limit": 9999})
    assert r.status_code == 422  # le=500 FastAPI validation.


# ===========================================================================
# GET /api/folder/{folder}/{id}
# ===========================================================================


def test_folder_get_detail_has_body(cal_folder_client, folder_seed_ids):
    arch_id = folder_seed_ids["archive_id"]
    r = cal_folder_client.get(f"/api/folder/archive/{arch_id}")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    # FolderEmailDetail = meta + body.
    assert data["id"] == arch_id
    assert data["body_html"] == "<p>hi archive</p>"
    assert data["body_markdown"] == "hi archive body"


def test_folder_get_missing_404(cal_folder_client):
    r = cal_folder_client.get("/api/folder/archive/424242")
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_folder_get_cross_folder_mismatch_404(cal_folder_client, folder_seed_ids):
    # The archive row id requested under /drafts/ → folder mismatch → 404
    # (guards against cross-folder id reads).
    arch_id = folder_seed_ids["archive_id"]
    r = cal_folder_client.get(f"/api/folder/drafts/{arch_id}")
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_folder_get_bad_folder_400(cal_folder_client, folder_seed_ids):
    arch_id = folder_seed_ids["archive_id"]
    r = cal_folder_client.get(f"/api/folder/spam/{arch_id}")
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


# ===========================================================================
# GET /api/folder/by-id/{id}  — folder-agnostic detail (mirrors Electron
# folder:get(id); web FolderApi.get(id) carries only the numeric row id).
# Declared BEFORE /{folder}/{id:int} so the literal 'by-id' prefix wins.
# ===========================================================================


def test_folder_get_by_id_has_body(cal_folder_client, folder_seed_ids):
    # (a) existing row id → 200 + FolderEmailDetail (body_html/body_markdown),
    # envelope meta.source=sqlite. folder is self-parsed from the row.
    arch_id = folder_seed_ids["archive_id"]
    r = cal_folder_client.get(f"/api/folder/by-id/{arch_id}")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)  # asserts meta.source == "sqlite"
    data = body["data"]
    assert data["id"] == arch_id
    assert data["folder"] == "archive"
    assert data["subject"] == FOLDER_ARCHIVE_SUBJECT
    assert data["body_html"] == "<p>hi archive</p>"
    assert data["body_markdown"] == "hi archive body"


def test_folder_get_by_id_missing_404(cal_folder_client):
    # (b) non-existent id → 404 E_NOT_FOUND.
    r = cal_folder_client.get("/api/folder/by-id/424242")
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_folder_get_by_id_not_swallowed_by_folder_route(
    cal_folder_client, folder_seed_ids
):
    # (c) route-ordering: /by-id/{existing} must hit folder_get_by_id, NOT be
    # parsed as /{folder}/{id} with folder='by-id' (which would 400 on the
    # _validate_folder whitelist). Returning 200 (not 400 E_INVALID_ARG) proves
    # the literal 'by-id' route — declared before /{folder}/{id:int} — wins.
    arch_id = folder_seed_ids["archive_id"]
    r = cal_folder_client.get(f"/api/folder/by-id/{arch_id}")
    assert r.status_code == 200
    assert r.json()["status"] == "success"
    # explicit: NOT the folder-whitelist rejection.
    assert r.status_code != 400


# ===========================================================================
# GET /api/folder/{folder}/search
# ===========================================================================


def test_folder_search_smart(cal_folder_client):
    r = cal_folder_client.get(
        "/api/folder/archive/search", params={"q": "redis"}
    )
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    # FolderSearchResult = {query, transformed_query, total_hits, hits}.
    assert set(data) == {"query", "transformed_query", "total_hits", "hits"}
    assert data["query"] == "redis"
    assert data["total_hits"] == 1
    hit = data["hits"][0]
    assert hit["subject"] == FOLDER_ARCHIVE_SUBJECT
    # hits are meta (no body).
    assert "body_html" not in hit
    assert body["meta"]["total_hits"] == 1


def test_folder_search_raw_no_transform(cal_folder_client):
    r = cal_folder_client.get(
        "/api/folder/archive/search", params={"q": "redis", "raw": "true"}
    )
    assert r.status_code == 200
    data = r.json()["data"]
    # raw mode → transformed_query is null (passthrough).
    assert data["transformed_query"] is None
    assert data["total_hits"] == 1


def test_folder_search_no_match_empty(cal_folder_client):
    r = cal_folder_client.get(
        "/api/folder/archive/search", params={"q": "zzzznotpresentzzzz"}
    )
    assert r.status_code == 200
    assert r.json()["data"]["hits"] == []
    assert r.json()["data"]["total_hits"] == 0


def test_folder_search_scoped_to_folder(cal_folder_client):
    # The draft subject ("Draft in progress") must NOT surface when searching
    # the archive folder — search is folder-scoped.
    r = cal_folder_client.get(
        "/api/folder/archive/search", params={"q": "Draft"}
    )
    assert r.status_code == 200
    assert r.json()["data"]["hits"] == []


def test_folder_search_bad_folder_400(cal_folder_client):
    r = cal_folder_client.get("/api/folder/spam/search", params={"q": "x"})
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_folder_search_missing_q_422(cal_folder_client):
    r = cal_folder_client.get("/api/folder/archive/search")
    assert r.status_code == 422  # q is required.


# ===========================================================================
# GET /api/folder/sync-status  — must not be shadowed by /{folder}/...
# ===========================================================================


def test_folder_sync_status(cal_folder_client):
    r = cal_folder_client.get("/api/folder/sync-status")
    assert r.status_code == 200
    body = r.json()
    _ok_envelope(body)
    data = body["data"]
    assert set(data) == {"states", "counts"}
    # counts per folder from the seed (1 archive + 1 drafts).
    assert data["counts"] == {"archive": 1, "drafts": 1}
    arch_state = next(s for s in data["states"] if s["folder"] == "archive")
    assert arch_state["last_uidnext"] == 11
    assert arch_state["imap_uidvalidity"] == 1


def test_folder_sync_status_not_shadowed_by_folder_route(cal_folder_client):
    # "sync-status" must resolve to the dedicated handler, not be parsed as a
    # {folder} value (which would 400 on the folder whitelist).
    r = cal_folder_client.get("/api/folder/sync-status")
    assert r.status_code == 200
    assert "states" in r.json()["data"]
