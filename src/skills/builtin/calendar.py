"""calendar skill —— 读日历事件 + 三个写工具（回复邀请 / 改期 / 删除）。

读镜像 ``src/api/routers/calendar.py``：``CalendarService.list_events_in_window`` /
``get_event``（CalDAV → SQLite SSoT，纯 reader）。

写（``calendar:write``，默认不授外部 key）与 serve-api 写端点调同一个 service 方法、走同一套
分支（应用内 gateway 的同名工具就是经这几个端点落地的）：

- ``calendar_event_rsvp`` → ``send_rsvp``（= ``POST /events/{id}/rsvp``，iTIP REPLY 走 SMTP）；
- ``calendar_event_reschedule`` → 带 ``recurrence_id`` 走 ``update_occurrence``（改这一次），
  不带走 ``update_event``（改整个事件 / 系列）—— 与 ``PATCH /events/{id}`` 去掉 splitFuture 后
  的两个分支一致。**只透传起止时间**，参会人 / 地点 / 正文 / RRULE 一律不动；
- ``calendar_event_delete`` → ``delete_event``（= ``DELETE /events/{id}``）。服务层不支持按
  occurrence 删除，所以没有 ``recurrence_id`` 参数。

写成功后照端点的做法记一行 ``[calendar-write]`` 审计日志（actor = ``mcp:<密钥名>``）并发
``calendar.synced`` 失效事件。三个写 handler 都是 ``blocking``（CalDAV / SMTP 网络 I/O）。

``calendar:write`` 在 2026-07-28 曾因「在册、零消费者」被删（悬空 scope 会让第一个消费者静默武装
所有历史 key，见 ``src/security/api_keys.py``）；这次与消费它的 ToolDef 在同一个提交里加回。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from src.skills.builtin._common import api_router, domain_error, mcp_actor_label
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


# ── 写 ──────────────────────────────────────────────────────────────────────
_RSVP_RESPONSES = ("accept", "tentative", "decline")
_ID_MAX_CHARS = 512
_ISO_MAX_CHARS = 64
_WRITE_SCOPES = ["calendar:write"]
# 改期 / 删除 / 回复邀请都会通知其他人：每把 key 每小时 20 次。
_WRITE_RATE_LIMIT = {"limit": 20, "per_seconds": 3600, "scope": "principal"}
_CONFIRM_PROP = {
    "type": "boolean",
    "description": "must be JSON true (explicit intent marker; anything else fails closed with 403)",
}


def _str_param(params: dict[str, Any], key: str, max_len: int, *, required: bool) -> Optional[str]:
    value = params.get(key)
    if value is None:
        if required:
            raise SkillError("E_INVALID_ARG", f"{key} is required")
        return None
    if not isinstance(value, str) or not value.strip():
        raise SkillError("E_INVALID_ARG", f"{key} must be a non-empty string")
    if len(value) > max_len:
        raise SkillError("E_INVALID_ARG", f"{key} must be at most {max_len} characters")
    return value.strip()


def _parse_strict(router: Any, value: str, field: str) -> datetime:
    """带时区的 ISO → UTC。复用写端点的同一个解析（naive / 非 ISO → E_INVALID_ARG）。"""
    from src.api.app import APIError

    try:
        return router._parse_iso_datetime_strict(value, field=field)
    except APIError as exc:
        raise domain_error(exc) from exc


def _audit(ctx: Any, router: Any, action: str, **fields: object) -> None:
    """与写端点的 ``_audit_write`` 同格式；actor 记 ``mcp:<密钥名>``。"""
    detail = " ".join(f"{k}={v!r}" for k, v in fields.items() if v is not None)
    router.logger.info(
        "[calendar-write] action=%s actor=%s %s", action, mcp_actor_label(ctx), detail
    )


def _calendar_event_rsvp(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    from src.calendar_sync.service import RSVP_RESPONSE_ALIAS

    event_id = _str_param(params, "event_id", _ID_MAX_CHARS, required=True)
    response = params.get("response")
    if response not in _RSVP_RESPONSES:
        raise SkillError("E_INVALID_ARG", f"response must be one of {list(_RSVP_RESPONSES)}")
    recurrence_id = _str_param(params, "recurrence_id", _ISO_MAX_CHARS, required=False)
    router = api_router("calendar")
    response_status = RSVP_RESPONSE_ALIAS[response]
    try:
        result = ctx.calendar_service().send_rsvp(
            ical_uid=event_id,
            response_status=response_status,
            recurrence_id=recurrence_id,
            source=None,
            dry_run=False,
        )
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg or "missing" in msg.lower():
            raise SkillError("E_NOT_FOUND", msg, http_status=404) from exc
        raise SkillError("E_INVALID_ARG", msg) from exc
    except Exception as exc:  # noqa: BLE001 — SMTP / CalDAV 失败统一 502（同端点）
        raise SkillError("E_UPSTREAM", f"rsvp failed: {exc}", http_status=502) from exc
    _audit(ctx, router, "rsvp", uid=event_id, response_status=response_status, to_email=result.get("to_email"))
    router._publish_calendar_synced(None, upserted=1)
    data = {
        "action": result["action"],
        "ical_uid": result["ical_uid"],
        "recurrence_id": result["recurrence_id"],
        "source": result["source"],
        "response_status": result["response_status"],
        "to_email": result["to_email"],
    }
    if result.get("organizer_freshness_warning"):
        data["organizer_freshness_warning"] = result["organizer_freshness_warning"]
    return data


def _calendar_event_reschedule(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    event_id = _str_param(params, "event_id", _ID_MAX_CHARS, required=True)
    new_start = _str_param(params, "new_start", _ISO_MAX_CHARS, required=True)
    new_end = _str_param(params, "new_end", _ISO_MAX_CHARS, required=True)
    recurrence_id = _str_param(params, "recurrence_id", _ISO_MAX_CHARS, required=False)
    router = api_router("calendar")
    dtstart_utc = _parse_strict(router, new_start, "new_start")
    dtend_utc = _parse_strict(router, new_end, "new_end")
    rid_utc = _parse_strict(router, recurrence_id, "recurrence_id") if recurrence_id else None
    svc = ctx.calendar_service()
    try:
        if rid_utc is not None:
            data = svc.update_occurrence(
                ical_uid=event_id,
                recurrence_id_utc=rid_utc,
                dtstart_utc=dtstart_utc,
                dtend_utc=dtend_utc,
            )
            action = "update-occurrence"
        else:
            data = svc.update_event(ical_uid=event_id, dtstart_utc=dtstart_utc, dtend_utc=dtend_utc)
            action = "update"
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise SkillError("E_NOT_FOUND", msg, http_status=404) from exc
        raise SkillError("E_INVALID_ARG", msg) from exc
    except Exception as exc:  # noqa: BLE001 — CalDAV 失败统一 502（同端点）
        raise SkillError("E_CALDAV", f"calendar update failed: {exc}", http_status=502) from exc
    _audit(ctx, router, action, uid=event_id, recurrence_id=recurrence_id)
    router._publish_calendar_synced(data.get("calendar_name"), upserted=1)
    return {
        "rescheduled": True,
        "event_id": event_id,
        "recurrence_id": recurrence_id,
        "new_start_iso": dtstart_utc.isoformat(),
        "new_end_iso": dtend_utc.isoformat(),
        "server": data,
    }


def _calendar_event_delete(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    event_id = _str_param(params, "event_id", _ID_MAX_CHARS, required=True)
    calendar_name = _str_param(params, "calendar_name", 200, required=False)
    router = api_router("calendar")
    try:
        data = ctx.calendar_service().delete_event(ical_uid=event_id, calendar_name=calendar_name)
    except ValueError as exc:
        # 同端点：writer 只在 UID 缺失时抛 ValueError。
        raise SkillError("E_NOT_FOUND", str(exc), http_status=404) from exc
    except Exception as exc:  # noqa: BLE001 — CalDAV 失败统一 502（同端点）
        raise SkillError("E_CALDAV", f"calendar delete failed: {exc}", http_status=502) from exc
    _audit(ctx, router, "delete", uid=event_id, calendar_name=calendar_name)
    router._publish_calendar_synced(data.get("calendar_name") or calendar_name, soft_deleted=1)
    return {"deleted": True, "event_id": event_id, "server": data}


def build_skill() -> BoundSkill:
    event_id_prop = {
        "type": "string",
        "maxLength": _ID_MAX_CHARS,
        "description": "ical_uid (from calendar_events)",
    }
    recurrence_id_prop = {
        "type": "string",
        "maxLength": _ISO_MAX_CHARS,
        "description": "recurrence_id of one occurrence of a recurring event (from calendar_events)",
    }
    tools = [
        BoundTool(
            ToolDef(
                name="calendar_events",
                title="List Calendar Events",
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
                title="Get Calendar Event",
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
        BoundTool(
            ToolDef(
                name="calendar_event_rsvp",
                title="Reply to Meeting Invitation",
                description=(
                    "Reply to a meeting invitation (accept / tentative / decline). Sends a real "
                    "iTIP REPLY email to the organizer; it cannot be recalled (reply again to "
                    "change the answer), so the client should ask the user to confirm first. "
                    "Requires calendar:write + confirm=true; rate limited to 20 calls per hour "
                    "per key."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "event_id": event_id_prop,
                        "response": {"type": "string", "enum": list(_RSVP_RESPONSES)},
                        "recurrence_id": recurrence_id_prop,
                        "confirm": _CONFIRM_PROP,
                    },
                    "required": ["event_id", "response"],
                },
                output_schema={"type": "object"},
                confirmation_tier="edit",
                side_effect="send",
                auth_scopes=_WRITE_SCOPES,
                mcp_exposed=True,
                rate_limit=_WRITE_RATE_LIMIT,
                destructive=False,
                idempotent=True,
                handler=ToolHandler(kind="service", target="CalendarService.send_rsvp"),
            ),
            _calendar_event_rsvp,
            blocking=True,
        ),
        BoundTool(
            ToolDef(
                name="calendar_event_reschedule",
                title="Reschedule Calendar Event",
                description=(
                    "Move a calendar event to a new start/end time. Only the time changes; "
                    "attendees, location and description are left as they are. With "
                    "recurrence_id only that one occurrence moves, without it the whole event / "
                    "series moves. new_start / new_end must be ISO 8601 with a timezone offset "
                    "(e.g. 2026-05-30T14:00:00+08:00). The change syncs to the real calendar "
                    "and attendees are notified, so the client should ask the user to confirm "
                    "first. Requires calendar:write + confirm=true; rate limited to 20 calls "
                    "per hour per key."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "event_id": event_id_prop,
                        "new_start": {"type": "string", "maxLength": _ISO_MAX_CHARS},
                        "new_end": {"type": "string", "maxLength": _ISO_MAX_CHARS},
                        "recurrence_id": recurrence_id_prop,
                        "confirm": _CONFIRM_PROP,
                    },
                    "required": ["event_id", "new_start", "new_end"],
                },
                output_schema={"type": "object"},
                confirmation_tier="edit",
                side_effect="external_call",
                auth_scopes=_WRITE_SCOPES,
                mcp_exposed=True,
                rate_limit=_WRITE_RATE_LIMIT,
                idempotent=True,
                handler=ToolHandler(
                    kind="service", target="CalendarService.update_event / update_occurrence"
                ),
            ),
            _calendar_event_reschedule,
            blocking=True,
        ),
        BoundTool(
            ToolDef(
                name="calendar_event_delete",
                title="Delete Calendar Event",
                description=(
                    "Delete a calendar event from the real calendar. IRREVERSIBLE: for a "
                    "recurring series every occurrence is removed, and if you are the "
                    "organizer the attendees receive a cancellation. The client should ask the "
                    "user to confirm first. Requires calendar:write + confirm=true; rate "
                    "limited to 20 calls per hour per key."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "event_id": event_id_prop,
                        "calendar_name": {"type": "string", "maxLength": 200},
                        "confirm": _CONFIRM_PROP,
                    },
                    "required": ["event_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="edit",
                side_effect="external_call",
                auth_scopes=_WRITE_SCOPES,
                mcp_exposed=True,
                rate_limit=_WRITE_RATE_LIMIT,
                destructive=True,
                idempotent=True,
                handler=ToolHandler(kind="service", target="CalendarService.delete_event"),
            ),
            _calendar_event_delete,
            blocking=True,
        ),
    ]
    return BoundSkill(
        name="calendar",
        version="1.0.0",
        title="Calendar",
        description=(
            "Read calendar events synced from CalDAV; reply to invitations, reschedule and "
            "delete events with the separate calendar:write scope."
        ),
        default_enabled=True,
        prompt_fragment=(
            "Use calendar_events to list events in a date window and calendar_event_get to "
            "fetch one event by its ical_uid. With calendar:write, calendar_event_rsvp answers "
            "an invitation, calendar_event_reschedule moves an event (time only) and "
            "calendar_event_delete removes it; all three notify other people and need an "
            "explicit boolean confirm=true."
        ),
        docs_path="skills/calendar/SKILL.md",
        tools=tools,
    )
