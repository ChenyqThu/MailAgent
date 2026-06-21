# Skill: calendar

Read calendar events synced from CalDAV (read-only in Phase 1).

## Tools

| tool | scope | effect |
|---|---|---|
| `calendar_events` | `calendar:read` | read |
| `calendar_event_get` | `calendar:read` | read |

## Usage

- `calendar_events {from_iso?, to_iso?, calendar_name?, source?, expand_recurrences?, limit?}` —
  list event occurrences in a window (RRULE expanded). Window defaults to the next 7 days.
- `calendar_event_get {event_id, source?, recurrence_id?}` — one event by its `ical_uid`.

## Notes

`source` ∈ `caldav` (default) / `email_ics` / `legacy_calendar_app`. Calendar **writes**
(create/update/delete/rsvp) are not exposed to external agents in Phase 1.
