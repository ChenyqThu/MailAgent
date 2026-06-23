"""calendar 路由 — /api/calendar/* (4 读端点 + sync-trigger 写)。

填充 4 个读端点 (handoff §2) + 远程手动同步触发 (syncTrigger; 其余写端点仍 defer):
  GET  /api/calendar/events             — eventsList   (→ CalendarEventOccurrence[])
  GET  /api/calendar/events/{event_id}  — eventGet     (→ CalendarEventDetail | null, 404→null)
  GET  /api/calendar/sync-status        — syncStatus   (→ CalendarSyncStateItem[])
  GET  /api/calendar/names              — calendarNames (→ string[])
  POST /api/calendar/sync-trigger       — syncTrigger  (CalDAV→SQLite, to_thread, →unknown)

实现纪律:
  - 全部经 ``CalendarService`` (src/calendar_sync/service.py) 直读 ``calendar_event`` /
    ``calendar_sync_state`` 表 — service 是纯 SQLite reader, **无 davmail gate**
    (gate 只在 CalDAV 写路径), 任何 backend 都能读已同步的本地数据。
  - **C7 契约 (响应形状对齐 frontend types.ts ``CalendarApi``)**: HttpApi (Workflow ②)
    直接把 envelope ``data`` 当作 typed 返回值消费, **不做 remap** —— 所以 ``data`` 必须
    *就是* 前端期望的形状, 两端都向 types.ts 收敛:
      * eventsList  → ``data`` 是 ``CalendarEventOccurrence[]`` (数组本身, 非 {events,...});
                      total / window / filters 落 envelope ``meta``。
      * eventGet    → ``data`` 是单个 ``CalendarEventDetail`` (非 {event}); 不存在 → 404
                      (HttpApi 把 404 转 null, 对齐 ``CalendarEventDetail | null``)。
      * syncStatus  → ``data`` 是 ``CalendarSyncStateItem[]`` (数组本身, 非 {calendars,...});
                      total / worker_enabled 落 envelope ``meta``。
      * calendarNames → ``data`` 是 ``string[]`` (本就是数组)。
    occurrence / detail / sync-state 单项形状仍 = CLI emit 的元素 (复用 occurrence_to_dict /
    row_to_dict / list_sync_states 的逐项 dict), 与 schemas/calendar.py 的
    Occurrence/Detail/SyncStateItem 一致, 只是 envelope 顶层从 {wrapper} 拆成裸数组/对象。
  - service 构造便宜且无活跃连接 (per-call 短命连接, WAL 下与 mail-sync writer 并发安全),
    每请求新建 OK (deps gotcha #13)。
  - 统一响应走 app.success_envelope / app.APIError; 鉴权挂 Depends(verify_cf_access);
    meta.source='sqlite' (repo 直查)。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings

if TYPE_CHECKING:
    from src.calendar_sync.service import CalendarService
    from src.config import Config

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

# 与 CLI calendar events 对齐: occurrence 上限 (前端 EventsListOpts.limit 默认 1000)。
EVENTS_LIMIT_MAX = 5000
VALID_EVENT_SOURCES = ("caldav", "email_ics", "legacy_calendar_app")


def _build_service(cfg: "Config") -> "CalendarService":
    """从 config 单例构造 CalendarService (读路径 cfg 仅用于 db_path)。"""
    from src.calendar_sync.service import CalendarService

    return CalendarService(db_path=cfg.sync_store_db_path, cfg=cfg)


def _parse_iso_date_opt(value: Optional[str], *, field: str) -> Optional[datetime]:
    """YYYY-MM-DD (或完整 ISO datetime) → tz-aware UTC datetime; 留空 None; 失败 400。

    镜像 CLI calendar.py::_parse_iso_date_opt: naive 视为 UTC, 已带 tz 转 UTC。
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise APIError(
            "E_INVALID_ARG",
            f"{field}={value!r} not a valid ISO date (expected YYYY-MM-DD)",
            source="sqlite",
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ===========================================================================
# GET /api/calendar/events — CalendarService.list_events_in_window
# ===========================================================================


@router.get("/events", dependencies=[Depends(verify_cf_access)])
async def list_events(
    request: Request,
    cfg: "Config" = Depends(get_settings),
    from_iso: Optional[str] = Query(
        None, alias="fromIso", description="窗口起 (ISO / YYYY-MM-DD, UTC); 默认今天 00:00 UTC"
    ),
    to_iso: Optional[str] = Query(
        None, alias="toIso", description="窗口止; 默认 fromIso + 7 天"
    ),
    calendar_name: Optional[str] = Query(None, alias="calendarName"),
    source: Optional[str] = Query(None, description=f"过滤 source ∈ {VALID_EVENT_SOURCES}"),
    expand_recurrences: bool = Query(
        True, alias="expandRecurrences", description="false = 仅主事件, 不展开 RRULE"
    ),
    limit: int = Query(1000, ge=1, le=EVENTS_LIMIT_MAX),
):
    """列出窗口内的 calendar_event occurrences (RRULE 已展开)。

    EventsListOpts 映射: fromIso/toIso/calendarName/source/expandRecurrences/limit。
    **C7**: ``data`` = ``CalendarEventOccurrence[]`` (裸数组, 对齐 frontend
    ``CalendarApi.eventsList``); window/filters/total 落 envelope ``meta`` (含
    ``meta.from_iso`` / ``meta.to_iso`` / ``meta.calendar_name`` / ``meta.source`` /
    ``meta.expand_recurrences``)。窗口默认今天起 7 天 (与 CLI 一致)。
    """
    if source is not None and source not in VALID_EVENT_SOURCES:
        raise APIError(
            "E_INVALID_ARG",
            f"source must be one of {list(VALID_EVENT_SOURCES)}, got {source!r}",
            source="sqlite",
        )

    window_start = _parse_iso_date_opt(from_iso, field="fromIso")
    window_end = _parse_iso_date_opt(to_iso, field="toIso")
    if window_start is None:
        window_start = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
    if window_end is None:
        window_end = window_start + timedelta(days=7)

    svc = _build_service(cfg)
    try:
        data = svc.list_events_in_window(
            window_start=window_start,
            window_end=window_end,
            calendar_name=calendar_name,
            source=source,
            limit=limit,
            expand_recurrences=expand_recurrences,
        )
    except ValueError as exc:
        # service 抛 ValueError (window_end ≤ window_start / source 非法 / limit ≤ 0)
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite") from exc

    # C7: 返裸 occurrences 数组 (CalendarEventOccurrence[]); 窗口/过滤元数据落 meta。
    # 注意 envelope 的 meta['source'] 恒为 'sqlite' (positional source=)，故 events 的
    # source **过滤器** 不能挂 meta['source'] (会覆盖)，挂 meta['filters'] 子对象。
    return success_envelope(
        data["events"],
        request=request,
        source="sqlite",
        meta_extra={
            "total": data["total"],
            "limit": limit,
            "window": data["window"],
            "filters": data["filters"],
        },
    )


# ===========================================================================
# GET /api/calendar/events/{event_id} — CalendarService.get_event
# (event_id = ical_uid; ?source / ?recurrenceId 选填)
# ===========================================================================


@router.get("/events/{event_id}", dependencies=[Depends(verify_cf_access)])
async def get_event(
    request: Request,
    event_id: str,
    cfg: "Config" = Depends(get_settings),
    source: str = Query("caldav", description=f"source ∈ {VALID_EVENT_SOURCES}"),
    recurrence_id: Optional[str] = Query(
        None, alias="recurrenceId", description="非空 = 单次跳脱 occurrence; 留空 = 主事件"
    ),
):
    """按 (ical_uid, recurrence_id, source) 取单 event 完整 row。

    EventGetOpts 映射: path event_id=icalUid; query source/recurrenceId。
    **C7**: ``data`` = 单个 ``CalendarEventDetail`` (裸对象, 非 {event}; 对齐 frontend
    ``CalendarApi.eventGet`` 返回 ``CalendarEventDetail | null``)。
    404 (E_NOT_FOUND) 当 row 不存在 —— HttpApi (②) 把 404 转成 ``null``, 故服务端只需
    在缺失时 404, 命中时直接返 detail 对象。
    """
    if source not in VALID_EVENT_SOURCES:
        raise APIError(
            "E_INVALID_ARG",
            f"source must be one of {list(VALID_EVENT_SOURCES)}, got {source!r}",
            source="sqlite",
        )

    svc = _build_service(cfg)
    try:
        data = svc.get_event(
            ical_uid=event_id, source=source, recurrence_id=recurrence_id,
        )
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise APIError(
                "E_NOT_FOUND",
                msg,
                hint="check GET /api/calendar/events or GET /api/calendar/sync-status; "
                "may be soft-deleted or wrong source",
                source="sqlite",
            ) from exc
        raise APIError("E_INVALID_ARG", msg, source="sqlite") from exc

    # C7: 解开 service 的 {event: <row>} wrapper，返裸 detail (CalendarEventDetail)。
    return success_envelope(data["event"], request=request, source="sqlite")


# ===========================================================================
# GET /api/calendar/sync-status — CalendarService.list_sync_states
# ===========================================================================


@router.get("/sync-status", dependencies=[Depends(verify_cf_access)])
async def sync_status(
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """列出所有 calendar 的 CalDAV sync 状态 (ctag / sync_token / 时间戳)。

    **C7**: ``data`` = ``CalendarSyncStateItem[]`` (裸数组, 对齐 frontend
    ``CalendarApi.syncStatus``); total / worker_enabled 落 envelope ``meta``。
    worker_enabled 读 config CALENDAR_CALDAV_SYNC_ENABLED (镜像 CLI sync-status)。
    """
    worker_enabled = bool(getattr(cfg, "calendar_caldav_sync_enabled", False))
    svc = _build_service(cfg)
    data = svc.list_sync_states(worker_enabled=worker_enabled)
    # C7: 返裸 calendars 数组 (CalendarSyncStateItem[]); total/worker_enabled 落 meta。
    return success_envelope(
        data["calendars"],
        request=request,
        source="sqlite",
        meta_extra={"total": data["total"], "worker_enabled": worker_enabled},
    )


# ===========================================================================
# GET /api/calendar/names — CalendarService.list_calendar_names
# ===========================================================================


@router.get("/names", dependencies=[Depends(verify_cf_access)])
async def calendar_names(
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """SQL distinct calendar_name (非空, deleted_at IS NULL)。

    给前端 toolbar chip / event-form 下拉用 (frontend calendarNames → string[])。
    data = list[str]。CLI 无对应 subcommand — 直接调 service.list_calendar_names()
    (该方法本就是 IPC handler runCalendarNames 的后端)。
    """
    svc = _build_service(cfg)
    names = svc.list_calendar_names()
    return success_envelope(
        names,
        request=request,
        source="sqlite",
        meta_extra={"count": len(names)},
    )


# ===========================================================================
# POST /api/calendar/sync-trigger — CalendarService.sync_now (远程手动触发)
# ===========================================================================


@router.post("/sync-trigger", dependencies=[Depends(verify_cf_access)])
async def sync_trigger(
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """手动触发一次 CalDAV → SQLite 日历同步 (远程 admin/debug 写端点)。

    镜像 CLI ``calendar sync-now`` / Electron ``calendar:syncTrigger``:
    body = ``{full?: bool = True, calendarName?: str}``。CalDAV 是阻塞网络操作
    (逐 calendar LIST + REPORT, 单个最长 ~60-120s), 经 ``asyncio.to_thread`` 跑,
    不阻塞 event loop (同 folder.py IMAP 写端点)。

    data = ``sync_now`` 结果 dict (mode / total_calendars / window / results) —
    与 CLI emit 同形, HttpApi 直接当 ``unknown`` 透传 (对齐 WriteEnvelope 语义,
    不 remap)。错误分两段对齐 CLI: ValueError(参数非法) → 400 E_INVALID_ARG;
    其它 (CalDAV 连接失败) → 502 E_CALDAV + DavMail hint。meta.source='cli'。
    """
    # body 直接读 request.json() (对齐 chat.py POST 模式) — 不用 ``body: dict`` 参数
    # 注解, 因 ``from __future__ import annotations`` 下 FastAPI/pydantic resolve 该
    # forward ref 会 "name 'Optional' is not defined" 炸。
    try:
        raw = await request.json()
    except Exception:
        raw = {}
    if not isinstance(raw, dict):
        raise APIError(
            "E_INVALID_ARG", "body must be a JSON object",
            http_status=400, source="cli",
        )
    full = raw.get("full", True)
    calendar_name = raw.get("calendarName")
    if not isinstance(full, bool):
        raise APIError(
            "E_INVALID_ARG", "body.full must be a JSON boolean",
            http_status=400, source="cli",
        )
    if calendar_name is not None and not isinstance(calendar_name, str):
        raise APIError(
            "E_INVALID_ARG", "body.calendarName must be a string",
            http_status=400, source="cli",
        )

    svc = _build_service(cfg)
    try:
        data = await asyncio.to_thread(
            svc.sync_now, full=full, calendar_name=calendar_name,
        )
    except ValueError as exc:
        raise APIError(
            "E_INVALID_ARG", str(exc), http_status=400, source="cli",
        ) from exc
    except Exception as exc:  # CalDAV connect / reader 失败 (对齐 CLI 第二段 except)
        raise APIError(
            "E_CALDAV", f"CalDAV connect failed: {exc}",
            hint="检查 DavMail 1080 端口是否 online + .env DAVMAIL_CIPHER_KEY",
            http_status=502, source="cli",
        ) from exc

    return success_envelope(data, request=request, source="cli")
