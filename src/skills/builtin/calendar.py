"""calendar skill —— 读日历事件（CalDAV → SQLite SSoT，纯 reader，无 davmail gate）。

镜像 ``src/api/routers/calendar.py``：``CalendarService.list_events_in_window`` /
``get_event``。写（create/update/delete/rsvp）留 P1 enhancement —— 对外 **零** 写工具，
故 ``calendar:write`` scope 也**不**在 ``KNOWN_SCOPES`` 里（2026-07-28 审计删；悬空的可发放
scope 会让未来第一个消费者静默武装所有历史 key，理由见 ``src/security/api_keys.py``）。
真做 P1 时把 ToolDef 与那个 scope 放**同一个 commit**。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_VALID_SOURCES = ("caldav", "email_ics", "legacy_calendar_app")
_EVENTS_LIMIT_MAX = 5000


def _parse_iso(value: Optional[str], field: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise SkillError("E_INVALID_ARG", f"{field}={value!r} not a valid ISO date (YYYY-MM-DD)")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _calendar_events(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    source = params.get("source")
    if source is not None and source not in _VALID_SOURCES:
        raise SkillError("E_INVALID_ARG", f"source must be one of {list(_VALID_SOURCES)}")
    limit = int(params.get("limit") or 1000)
    if limit < 1 or limit > _EVENTS_LIMIT_MAX:
        raise SkillError("E_INVALID_ARG", f"limit must be 1..{_EVENTS_LIMIT_MAX}")
    start = _parse_iso(params.get("from_iso"), "from_iso")
    end = _parse_iso(params.get("to_iso"), "to_iso")
    if start is None:
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    if end is None:
        end = start + timedelta(days=7)
    try:
        data = ctx.calendar_service().list_events_in_window(
            window_start=start,
            window_end=end,
            calendar_name=params.get("calendar_name"),
            source=source,
            limit=limit,
            expand_recurrences=bool(params.get("expand_recurrences", True)),
        )
    except ValueError as exc:
        raise SkillError("E_INVALID_ARG", str(exc))
    return {
        "events": data["events"],
        "total": data["total"],
        "window": data["window"],
        "filters": data["filters"],
    }


def _calendar_event_get(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    source = str(params.get("source") or "caldav")
    if source not in _VALID_SOURCES:
        raise SkillError("E_INVALID_ARG", f"source must be one of {list(_VALID_SOURCES)}")
    try:
        data = ctx.calendar_service().get_event(
            ical_uid=str(params["event_id"]),
            source=source,
            recurrence_id=params.get("recurrence_id"),
        )
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise SkillError("E_NOT_FOUND", msg, http_status=404)
        raise SkillError("E_INVALID_ARG", msg)
    return data["event"]


def build_skill() -> BoundSkill:
    tools = [
        BoundTool(
            ToolDef(
                name="calendar_events",
                description="List calendar event occurrences in a time window (RRULE expanded).",
                input_schema={
                    "type": "object",
                    "properties": {
                        "from_iso": {"type": "string", "description": "ISO / YYYY-MM-DD UTC"},
                        "to_iso": {"type": "string"},
                        "calendar_name": {"type": "string"},
                        "source": {"type": "string", "enum": list(_VALID_SOURCES)},
                        "expand_recurrences": {"type": "boolean"},
                        "limit": {"type": "integer"},
                    },
                },
                output_schema={"type": "object", "description": "{events, total, window, filters}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["calendar:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="CalendarService.list_events_in_window"),
            ),
            _calendar_events,
        ),
        BoundTool(
            ToolDef(
                name="calendar_event_get",
                description="Fetch one calendar event by ical_uid (+ optional source/recurrence).",
                input_schema={
                    "type": "object",
                    "properties": {
                        "event_id": {"type": "string", "description": "ical_uid"},
                        "source": {"type": "string", "enum": list(_VALID_SOURCES)},
                        "recurrence_id": {"type": "string"},
                    },
                    "required": ["event_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["calendar:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="CalendarService.get_event"),
            ),
            _calendar_event_get,
        ),
    ]
    return BoundSkill(
        name="calendar",
        version="1.0.0",
        title="Calendar",
        description="Read calendar events synced from CalDAV (read-only in Phase 1).",
        default_enabled=True,
        prompt_fragment=(
            "Use calendar_events to list events in a date window and calendar_event_get to "
            "fetch one event by its ical_uid. Calendar writes are not exposed to agents."
        ),
        docs_path="skills/calendar/SKILL.md",
        tools=tools,
    )
