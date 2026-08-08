"""Calendar business-change Custom Agent dispatch with a 60-second merge window.

The in-memory pending state is intentionally process-local. A restart may lose one
pending update; a later business change has a new content hash and will trigger.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from loguru import logger

from src.agents.matcher import AgentCalendarMatcher
from src.agents.run_queue import enqueue_agent_run
from src.agents.trigger import (
    CalendarEventChangeTrigger,
    TriggerValidationError,
    calendar_trigger_enabled,
    parse_budget,
    parse_trigger,
    parse_trigger_set,
    trigger_v2_enabled,
)
from src.calendar_sync.reconciler import CalendarChange

CALENDAR_TRIGGER_COALESCE_MS = 60_000


def dispatch_calendar_change_agents(
    *,
    store: Any,
    repo: Any,
    calendar_repo: Any,
    changes: Iterable[CalendarChange],
    now_fn: Callable[[], float] = time.time,
) -> None:
    if not calendar_trigger_enabled():
        return
    agents = store.list_agents()
    if not agents:
        return
    for change in changes:
        row = calendar_repo.get_by_ical_uid(
            change.ical_uid,
            source="caldav",
            recurrence_id=change.recurrence_id,
            include_deleted=True,
        )
        if row is None:
            continue
        for agent in agents:
            if not agent.get("enabled") or agent.get("type") != "custom":
                continue
            try:
                entries = (
                    parse_trigger_set(agent.get("trigger_json"))
                    if trigger_v2_enabled()
                    else ((None, True, parse_trigger(agent.get("trigger_json"))),)
                )
            except TriggerValidationError as exc:
                logger.warning(
                    f"[calendar-dispatch] skip agent={agent.get('id')} bad trigger_json: {exc}"
                )
                continue
            for entry in entries:
                trigger_id = getattr(entry, "id", entry[0] if isinstance(entry, tuple) else None)
                enabled = getattr(entry, "enabled", entry[1] if isinstance(entry, tuple) else True)
                trigger = getattr(entry, "trigger", entry[2] if isinstance(entry, tuple) else None)
                if not enabled or not isinstance(trigger, CalendarEventChangeTrigger):
                    continue
                if not AgentCalendarMatcher(trigger).is_match(
                    title=row.summary,
                    organizer=row.organizer,
                    attendees=row.attendees,
                    calendar_name=row.calendar_name,
                ):
                    continue
                enqueue_agent_run(
                    repo,
                    agent_id=agent["id"],
                    trigger_kind="calendar_event_change",
                    fire_key=(
                        f"{change.ical_uid}|{change.recurrence_id or ''}|"
                        f"{change.business_hash[:16]}"
                    ),
                    budget=parse_budget(agent.get("budget_json")),
                    params={
                        "calendar_event_uid": change.ical_uid,
                        "recurrence_id": change.recurrence_id,
                        "change_kind": change.change_kind,
                        "changed_fields": change.changed_fields,
                    },
                    trigger_id=trigger_id,
                    now_fn=now_fn,
                )


@dataclass
class CalendarChangeCoalescer:
    last_dispatch_monotonic: dict[tuple[str, str | None], float] = field(default_factory=dict)
    pending: dict[tuple[str, str | None], CalendarChange] = field(default_factory=dict)

    def offer(
        self,
        changes: Iterable[CalendarChange],
        *,
        now_monotonic: float,
    ) -> list[CalendarChange]:
        ready: list[CalendarChange] = []
        window_sec = CALENDAR_TRIGGER_COALESCE_MS / 1000
        for change in changes:
            key = (change.ical_uid, change.recurrence_id)
            previous = self.last_dispatch_monotonic.get(key)
            if previous is None or now_monotonic - previous >= window_sec:
                ready.append(change)
                self.last_dispatch_monotonic[key] = now_monotonic
                self.pending.pop(key, None)
            else:
                self.pending[key] = change
        for key, change in list(self.pending.items()):
            if now_monotonic - self.last_dispatch_monotonic.get(key, 0) >= window_sec:
                ready.append(change)
                self.last_dispatch_monotonic[key] = now_monotonic
                self.pending.pop(key, None)
        return ready
