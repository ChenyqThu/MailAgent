"""Recurring meeting expansion shared between main.py loop and CLI."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from loguru import logger

from src.calendar_notion.recurrence import expand_occurrences
from src.mail.icalendar_parser import MeetingInvite


def reconstruct_invite_from_series_row(row: dict[str, Any]) -> Optional[MeetingInvite]:
    """Rehydrate a minimal MeetingInvite from a recurring_series row."""
    try:
        dtstart = datetime.fromisoformat(row["master_dtstart"])
        dtend = datetime.fromisoformat(row["master_dtend"])
    except (ValueError, KeyError, TypeError) as e:
        logger.warning(
            f"[expansion] cannot rehydrate series {row.get('series_uid','?')[:60]}: {e}"
        )
        return None

    try:
        exdates_raw = json.loads(row.get("exdates_json") or "[]")
    except (json.JSONDecodeError, TypeError):
        exdates_raw = []
    exdates = []
    for s in exdates_raw if isinstance(exdates_raw, list) else []:
        try:
            exdates.append(datetime.fromisoformat(s))
        except ValueError:
            continue

    return MeetingInvite(
        uid=row["series_uid"],
        method="REQUEST",
        summary=row.get("master_summary") or "",
        start_time=dtstart,
        end_time=dtend,
        location=row.get("master_location"),
        description=row.get("master_description"),
        organizer=row.get("master_organizer"),
        organizer_email=row.get("master_organizer_email"),
        attendees=[],
        status="tentative",
        sequence=int(row.get("last_sequence") or 0),
        is_all_day=bool(row.get("master_is_all_day")),
        recurrence_rule=row.get("rrule_str"),
        exdates=exdates,
        tzid=row.get("master_tzid"),
    )


async def run_expansion_tick(
    sync_store,
    meeting_sync,
    horizon_weeks: int,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Run one recurring meeting expansion tick and return a summary."""
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(weeks=horizon_weeks)
    cutoff_iso = cutoff.isoformat()

    rows = list(sync_store.iter_series_needing_expansion(cutoff_iso))
    if not rows:
        logger.debug("[expansion] no series need extension")
        return {"series_scanned": 0, "occurrences_synced": 0, "errors": []}

    logger.info(
        f"[expansion] tick: {len(rows)} series need extension (dry_run={dry_run})"
    )

    synced_total = 0
    errors: list[dict[str, str]] = []
    for row in rows:
        try:
            series_failed = False
            invite = reconstruct_invite_from_series_row(row)
            if invite is None:
                continue

            last_until_str = row.get("last_expanded_until")
            last_until = None
            if last_until_str:
                try:
                    last_until = datetime.fromisoformat(last_until_str)
                    if last_until.tzinfo is None:
                        last_until = last_until.replace(tzinfo=timezone.utc)
                except ValueError:
                    last_until = None

            since = max(now, last_until) if last_until else now
            occurrences = expand_occurrences(
                invite,
                since=since,
                until=cutoff,
                series_state=row,
            )

            for occ in occurrences:
                if dry_run:
                    synced_total += 1
                    continue
                try:
                    await meeting_sync.calendar_sync.sync_event(occ)
                    synced_total += 1
                except Exception as e:
                    logger.error(
                        f"[expansion] sync_event failed for {occ.event_id[:80]}: {e}"
                    )
                    series_failed = True
                    errors.append(
                        {
                            "series_uid": row.get("series_uid") or "",
                            "error": f"sync_event failed: {e}",
                        }
                    )

            if not dry_run and not series_failed:
                sync_store.update_expanded_until(row["series_uid"], cutoff_iso)
        except Exception as e:
            logger.error(
                f"[expansion] series {row.get('series_uid','?')[:60]} failed: {e}"
            )
            errors.append({"series_uid": row.get("series_uid") or "", "error": str(e)})

    logger.info(
        f"[expansion] tick done: {synced_total} occurrences synced across {len(rows)} series"
    )
    return {
        "series_scanned": len(rows),
        "occurrences_synced": synced_total,
        "errors": errors,
    }
