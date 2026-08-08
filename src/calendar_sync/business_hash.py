"""Canonical Calendar business-content hashing.

Included fields: summary, organizer, attendees, location, url, description, status.
Explicitly excluded fields: dtstart, dtend, sequence, ics_raw, last_synced_at,
updated_at, notion_page_id, response_status, tzid, rrule, exdates, and rdates.
Those excluded values are scheduling or synchronization metadata and must not emit
``calendar_event_change`` runs.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

BUSINESS_FIELDS = (
    "summary",
    "organizer",
    "attendees",
    "location",
    "url",
    "description",
    "status",
)


def _value(event: Any, name: str) -> Any:
    if name == "attendees":
        raw = getattr(event, "attendees", None)
        if raw and isinstance(raw[0], str):
            return raw
        detail = getattr(event, "attendees_detail", None)
        return detail if detail is not None else raw
    return getattr(event, name, None)


def _attendee_emails(event: Any) -> tuple[str, ...]:
    emails: set[str] = set()
    for attendee in _value(event, "attendees") or []:
        email = attendee.get("email") if isinstance(attendee, dict) else attendee
        if isinstance(email, str) and email.strip():
            emails.add(email.strip().lower())
    return tuple(sorted(emails))


def business_projection(event: Any) -> dict[str, Any]:
    return {
        "summary": str(_value(event, "summary") or ""),
        "organizer": str(_value(event, "organizer") or "").strip().lower(),
        "attendees": _attendee_emails(event),
        "location": str(_value(event, "location") or ""),
        "url": str(_value(event, "url") or ""),
        "description": str(_value(event, "description") or ""),
        "status": str(_value(event, "status") or "").upper(),
    }


def business_content_hash(event: Any) -> str:
    canonical = json.dumps(
        business_projection(event),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def deleted_business_content_hash(event: Any) -> str:
    """Deletion transition hash; distinct from the event's last live content hash."""
    return hashlib.sha256(
        f"{business_content_hash(event)}|deleted".encode("utf-8")
    ).hexdigest()


def changed_business_fields(previous: Any, current: Any) -> list[str]:
    before = business_projection(previous)
    after = business_projection(current)
    return [name for name in BUSINESS_FIELDS if before[name] != after[name]]
