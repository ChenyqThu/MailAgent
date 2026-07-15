"""calendar 路由 — /api/calendar/* (6 读端点 + 6 写端点)。

填充读端点 (handoff §2 + 阶段 2.1 P1-3 双向反查) + 远程手动同步触发
(syncTrigger) + 阶段 3.1 (#11) 事件写路径 (create/update/delete/rsvp/replay):
  GET    /api/calendar/events             — eventsList   (→ CalendarEventOccurrence[])
  GET    /api/calendar/events/{event_id}  — eventGet     (→ CalendarEventDetail | null, 404→null)
  GET    /api/calendar/email-link/{internal_id}
                                          — emailCalendarLink (→ EmailCalendarLink | null, 404→null)
  GET    /api/calendar/events/{event_id}/source-email
                                          — eventSourceEmail (→ EventSourceEmail | null, 404→null)
  GET    /api/calendar/sync-status        — syncStatus   (→ CalendarSyncStateItem[])
  GET    /api/calendar/names              — calendarNames (→ string[])
  POST   /api/calendar/sync-trigger       — syncTrigger  (CalDAV→SQLite, to_thread, →unknown)
  POST   /api/calendar/events             — eventCreate  (CalDAV PUT, to_thread)
  PATCH  /api/calendar/events/{event_id}  — eventUpdate  (三分支: 整系列 / 改这次 detached /
                                            改未来 split; 语义逐字镜像 CLI `calendar update`)
  DELETE /api/calendar/events/{event_id}  — eventDelete  (CalDAV DELETE; 前端 5s undo 后才发,
                                            即 CLI --yes 的确认语义)
  POST   /api/calendar/events/{event_id}/rsvp   — eventRsvp   (iTIP REPLY via SMTP)
  POST   /api/calendar/events/{event_id}/replay — eventReplay (重导出 Notion mirror)

写端点纪律 (阶段 3.1, 对齐 email 写面):
  - 鉴权同 email 写端点: ``Depends(verify_cf_access)`` (CF Access JWT L2 + 本地
    ephemeral token 双腿合一, src/api/auth.py)。dry-run 也过传输鉴权 (email 面同款:
    dry-run 跳过的是 service 层 auth, 不是传输层)。
  - 审计: email 写面把 ``Actor(kind='http', label='cf-access')`` 传进 service;
    CalendarService 写方法无 actor 参数 (不动内核), 对等物 = 本 router 成功后
    ``_audit_write()`` 落一行结构化 log (actor=request.state.user_email)。
    远程写 = 过 CF Access 的浏览器可改真日历 + 发 RSVP 信 (PRD 风险表), 不可弱化。
  - 阻塞 CalDAV/SMTP/Notion 调用一律 ``asyncio.to_thread`` (同 sync-trigger)。
  - body = camelCase dict + 手动校验 (镜像 email.py 写端点模式; 本文件
    ``from __future__ import annotations`` 下不用 pydantic 参数注解, 见 sync-trigger 注)。
  - 错误映射逐字对齐 CLI `calendar create/update/delete/rsvp/replay`:
    ValueError "not found" → 404 E_NOT_FOUND; 其它 ValueError → 400 E_INVALID_ARG;
    其余异常 → 502 (CalDAV 写=E_CALDAV, SMTP/Notion 上游=E_UPSTREAM) + CLI 同款 hint。
  - data 形状 = CLI 同名命令 emit 的 data (HttpApi 直接透传, 与 ElectronApi fork CLI
    的 WriteEnvelope data 1:1)。

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
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings

if TYPE_CHECKING:
    from src.calendar_sync.service import CalendarService
    from src.config import Config

# 写端点审计 (docstring「写端点纪律」): 成功后落一行 actor+action+uid。
logger = logging.getLogger("mailagent.api.calendar")

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
# GET /api/calendar/email-link/{internal_id} — CalendarService.get_email_calendar_link
# (阶段 2.1 P1-3 方向 A: 邮件 → .ics uid + 日历 master 行)
# ===========================================================================


@router.get("/email-link/{internal_id}", dependencies=[Depends(verify_cf_access)])
async def email_calendar_link(
    request: Request,
    internal_id: int,
    cfg: "Config" = Depends(get_settings),
):
    """按邮件 internal_id 查它携带的 .ics uid + 对应 calendar_event master 行。

    **C7**: ``data`` = 单个 ``EmailCalendarLink`` (裸对象, 对齐 frontend
    ``CalendarApi.emailCalendarLink`` 返回 ``EmailCalendarLink | null``)。
    404 (E_NOT_FOUND) 当该邮件无会议映射 (非会议邀请 / v34 前旧邮件未回填) ——
    HttpApi 把 404 转 null。``event`` 为 null + in_calendar=false 表示 uid 在
    日历中 (已) 不存在, 仍是 200 (映射本身命中)。
    """
    svc = _build_service(cfg)
    try:
        data = svc.get_email_calendar_link(internal_id=internal_id)
    except ValueError as exc:
        raise APIError(
            "E_NOT_FOUND",
            str(exc),
            hint="email has no meeting mapping (not an invite, or synced before v34)",
            source="sqlite",
        ) from exc
    return success_envelope(data, request=request, source="sqlite")


# ===========================================================================
# GET /api/calendar/events/{event_id}/source-email — CalendarService.get_event_source_email
# (阶段 2.1 P1-3 方向 B: ical_uid → 来源邀请邮件)
# ===========================================================================


@router.get(
    "/events/{event_id}/source-email", dependencies=[Depends(verify_cf_access)]
)
async def event_source_email(
    request: Request,
    event_id: str,
    cfg: "Config" = Depends(get_settings),
):
    """按 ical_uid 反查来源邀请邮件 (event_id = ical_uid, 同 eventGet 路径参数)。

    **C7**: ``data`` = 单个 ``EventSourceEmail`` (裸对象, 对齐 frontend
    ``CalendarApi.eventSourceEmail`` 返回 ``EventSourceEmail | null``)。多封同
    uid 邮件时优先最新 METHOD:REQUEST, 无 REQUEST 时最新任意一封。404
    (E_NOT_FOUND) 当该 uid 无映射邮件 (caldav-only 事件 / 旧邮件未回填)。
    """
    svc = _build_service(cfg)
    try:
        data = svc.get_event_source_email(ical_uid=event_id)
    except ValueError as exc:
        raise APIError(
            "E_NOT_FOUND",
            str(exc),
            hint="no invite email mapped to this uid (caldav-only event, "
            "or emails synced before v34)",
            source="sqlite",
        ) from exc
    return success_envelope(data, request=request, source="sqlite")


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


# ===========================================================================
# 阶段 3.1 (#11) — 写端点共用 helpers
# ===========================================================================


async def _read_body_object(request: Request) -> dict:
    """request body → dict; 空 body → {}; 非 JSON object → 400 (镜像 sync-trigger)。"""
    try:
        raw = await request.json()
    except Exception:
        raw = {}
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise APIError(
            "E_INVALID_ARG", "body must be a JSON object",
            http_status=400, source="cli",
        )
    return raw


def _opt_str(raw: dict, key: str) -> Optional[str]:
    """body.{key} → str | None (缺席/null=None); 非 str → 400。

    空串**原样保留** — CLI 语义区分 None(不动) 与 ''(如 rrule='' 删除 RRULE)。
    """
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise APIError(
            "E_INVALID_ARG", f"body.{key} must be a string", source="cli",
        )
    return value


def _opt_bool(raw: dict, key: str) -> Optional[bool]:
    """body.{key} → bool | None (缺席/null=None); 非 bool → 400。"""
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise APIError(
            "E_INVALID_ARG", f"body.{key} must be a JSON boolean", source="cli",
        )
    return value


def _parse_iso_datetime_strict(value: str, *, field: str) -> datetime:
    """ISO datetime 必须带 tz; naive 拒绝; 'Z' 后缀 → '+00:00'; 归一 UTC。

    镜像 CLI calendar.py::_parse_iso_datetime_strict (Electron 面把 startIso 原样
    传给 CLI --start, 这里必须同样严格, 否则两端时区语义漂移)。
    """
    s_clean = value.strip()
    if s_clean.endswith("Z"):
        s_clean = s_clean[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s_clean)
    except ValueError as exc:
        raise APIError(
            "E_INVALID_ARG",
            f"{field}={value!r} not valid ISO datetime "
            f"(e.g. '2026-05-30T14:00:00+08:00' or '2026-05-30T06:00:00Z')",
            source="cli",
        ) from exc
    if dt.tzinfo is None:
        raise APIError(
            "E_INVALID_ARG",
            f"{field}={value!r} naive datetime not allowed; must include tz "
            f"offset, e.g. '2026-05-30T14:00:00+08:00'",
            source="cli",
        )
    return dt.astimezone(timezone.utc)


def _parse_attendees_body(raw_list: object, *, field: str) -> list[dict]:
    """body attendees ([{email, name?}]) → service attendees list。

    校验镜像 CLI _parse_attendees: email 必填且含 '@'; name 可选非空 str。
    """
    if not isinstance(raw_list, list):
        raise APIError(
            "E_INVALID_ARG",
            f"body.{field} must be a list of {{email, name?}} objects",
            source="cli",
        )
    out: list[dict] = []
    for item in raw_list:
        if not isinstance(item, dict):
            raise APIError(
                "E_INVALID_ARG",
                f"body.{field}[] items must be objects with an 'email' key",
                source="cli",
            )
        email = item.get("email")
        email = email.strip() if isinstance(email, str) else ""
        if not email or "@" not in email:
            raise APIError(
                "E_INVALID_ARG",
                f"body.{field}[] entry {item!r} not valid; expected "
                "{'email': 'a@b', 'name'?: '...'}",
                source="cli",
            )
        entry: dict = {"email": email}
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            entry["name"] = name.strip()
        out.append(entry)
    return out


def _audit_write(request: Request, action: str, **fields: object) -> None:
    """写操作审计行 (docstring「写端点纪律」— email 写面 Actor(label) 的对等物)。

    actor = 已过 verify_cf_access 的 request.state.user_email
    (CF 腿 = verified JWT claims email; 本地 token 腿 = 配置身份)。
    """
    actor = getattr(request.state, "user_email", None) or "?"
    detail = " ".join(f"{k}={v!r}" for k, v in fields.items() if v is not None)
    logger.info("[calendar-write] action=%s actor=%s %s", action, actor, detail)


# ===========================================================================
# POST /api/calendar/events — CalendarService.create_event (CalDAV PUT)
# ===========================================================================


@router.post("/events", dependencies=[Depends(verify_cf_access)])
async def create_event(
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """CalDAV PUT 创建事件 (CLI `calendar create` / Electron `calendar:eventCreate`)。

    body (EventCreateOpts, camelCase): {summary, startIso, endIso, location?,
    description?, attendees?: [{email, name?}], calendarName?, status?=CONFIRMED,
    rrule?, isAllDay?=false}。startIso/endIso 必须带 tz (naive 400); 全天事件
    isAllDay=true → writer 端 DTSTART/DTEND 用 VALUE=DATE (end exclusive)。
    data = writer 结果 dict (ical_uid / calendar_name / dtstart_iso / ...) 透传。
    """
    raw = await _read_body_object(request)

    summary = raw.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise APIError(
            "E_INVALID_ARG", "body.summary is required (non-empty string)",
            source="cli",
        )
    start_iso = _opt_str(raw, "startIso")
    end_iso = _opt_str(raw, "endIso")
    if not start_iso or not end_iso:
        raise APIError(
            "E_INVALID_ARG", "body.startIso and body.endIso are required",
            source="cli",
        )
    dtstart_utc = _parse_iso_datetime_strict(start_iso, field="startIso")
    dtend_utc = _parse_iso_datetime_strict(end_iso, field="endIso")

    status = _opt_str(raw, "status") or "CONFIRMED"
    is_all_day = _opt_bool(raw, "isAllDay") or False
    attendees = (
        _parse_attendees_body(raw.get("attendees"), field="attendees")
        if raw.get("attendees") is not None
        else []
    )

    svc = _build_service(cfg)
    try:
        data = await asyncio.to_thread(
            svc.create_event,
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            location=_opt_str(raw, "location"),
            description=_opt_str(raw, "description"),
            attendees=attendees,
            calendar_name=_opt_str(raw, "calendarName"),
            status=status,
            rrule=_opt_str(raw, "rrule"),
            is_all_day=is_all_day,
        )
    except ValueError as exc:
        # status 非法 / dtend ≤ dtstart (对齐 CLI create: 全部 → invalid arg)
        raise APIError("E_INVALID_ARG", str(exc), source="cli") from exc
    except Exception as exc:
        raise APIError(
            "E_CALDAV", f"calendar create failed: {exc}",
            hint="检查 DavMail CalDAV (1080) 可达 + cipher key + calendar 名是否存在",
            http_status=502, source="cli",
        ) from exc

    _audit_write(request, "create", uid=data.get("ical_uid"), summary=summary)
    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# PATCH /api/calendar/events/{event_id} — update 三分支 (CLI `calendar update`)
# ===========================================================================


@router.patch("/events/{event_id}", dependencies=[Depends(verify_cf_access)])
async def update_event(
    request: Request,
    event_id: str,
    cfg: "Config" = Depends(get_settings),
):
    """CalDAV PUT update (event_id = ical_uid); 分支逐字镜像 CLI `calendar update`:

    - recurrenceId + splitFuture → **改未来** split_series (老 series 截断 + 新 series);
    - recurrenceId (无 splitFuture) → **改这一次** update_occurrence (detached
      override; 忽略 rrule/isAllDay/attendees/noSequenceBump, 同 CLI);
    - 都不传 → **改整系列** update_event。

    body (EventUpdateOpts, camelCase, 全可选=保留原值): {summary?, startIso?,
    endIso?, location?, description?, attendees?, clearAttendees?, status?,
    calendarName?, rrule?, isAllDay?, recurrenceId?, splitFuture?, noSequenceBump?}。

    attendees 三态 (⚠️ 逐字对齐 Electron 面 runEventUpdate — `opts.attendees || []`
    循环零次 = 不传 --attendee):
      缺席/null/**空数组** → None 保留原与会者 (清空必须走 clearAttendees, 空数组
      不是清空); clearAttendees=true → [] 清空; 非空列表 → 整表替换。
    rrule: 缺席=保留; 'FREQ=...'=覆盖; ''=删除 RRULE (周期→单次)。
    """
    raw = await _read_body_object(request)

    clear_attendees = _opt_bool(raw, "clearAttendees") or False
    split_future = _opt_bool(raw, "splitFuture") or False
    no_sequence_bump = _opt_bool(raw, "noSequenceBump") or False
    is_all_day = _opt_bool(raw, "isAllDay")
    recurrence_id = _opt_str(raw, "recurrenceId")

    raw_attendees = raw.get("attendees")
    # 互斥校验 — 文案照 CLI calendar update
    if clear_attendees and isinstance(raw_attendees, list) and len(raw_attendees) > 0:
        raise APIError(
            "E_INVALID_ARG",
            "clearAttendees 与 attendees 互斥: 要么清空, 要么用 attendees 替换",
            source="cli",
        )
    if clear_attendees and recurrence_id:
        raise APIError(
            "E_INVALID_ARG",
            "clearAttendees 不支持 recurrenceId: occurrence override (改这一次) "
            "继承 master 与会者, 不改单次. 清空整系列与会者请去掉 recurrenceId",
            source="cli",
        )

    dtstart_utc = None
    dtend_utc = None
    start_iso = _opt_str(raw, "startIso")
    end_iso = _opt_str(raw, "endIso")
    if start_iso:
        dtstart_utc = _parse_iso_datetime_strict(start_iso, field="startIso")
    if end_iso:
        dtend_utc = _parse_iso_datetime_strict(end_iso, field="endIso")

    # attendees 三态: clear → []; 非空列表 → 替换; 缺席/null/空数组 → None 保留。
    attendees: Optional[list[dict]] = None
    if clear_attendees:
        attendees = []
    elif isinstance(raw_attendees, list) and len(raw_attendees) > 0:
        attendees = _parse_attendees_body(raw_attendees, field="attendees")
    elif raw_attendees is not None and not isinstance(raw_attendees, list):
        raise APIError(
            "E_INVALID_ARG",
            "body.attendees must be a list of {email, name?} objects",
            source="cli",
        )

    rid_utc = None
    if recurrence_id:
        rid_utc = _parse_iso_datetime_strict(recurrence_id, field="recurrenceId")

    common = dict(
        ical_uid=event_id,
        summary=_opt_str(raw, "summary"),
        dtstart_utc=dtstart_utc,
        dtend_utc=dtend_utc,
        location=_opt_str(raw, "location"),
        description=_opt_str(raw, "description"),
        status=_opt_str(raw, "status"),
        calendar_name=_opt_str(raw, "calendarName"),
    )

    svc = _build_service(cfg)
    try:
        if rid_utc is not None and split_future:
            data = await asyncio.to_thread(
                svc.split_series, split_recurrence_id_utc=rid_utc, **common,
            )
            action = "update-split-future"
        elif rid_utc is not None:
            data = await asyncio.to_thread(
                svc.update_occurrence, recurrence_id_utc=rid_utc, **common,
            )
            action = "update-occurrence"
        else:
            data = await asyncio.to_thread(
                svc.update_event,
                attendees=attendees,
                sequence_bump=not no_sequence_bump,
                rrule=_opt_str(raw, "rrule"),
                is_all_day=is_all_day,
                **common,
            )
            action = "update"
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise APIError(
                "E_NOT_FOUND", msg,
                hint="检查 ical_uid 存在 + DavMail CalDAV 可达", source="cli",
            ) from exc
        raise APIError("E_INVALID_ARG", msg, source="cli") from exc
    except Exception as exc:
        raise APIError(
            "E_CALDAV", f"calendar update failed: {exc}",
            hint="检查 ical_uid 存在 + DavMail CalDAV 可达",
            http_status=502, source="cli",
        ) from exc

    _audit_write(request, action, uid=event_id, recurrence_id=recurrence_id)
    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# DELETE /api/calendar/events/{event_id} — CalendarService.delete_event
# ===========================================================================


@router.delete("/events/{event_id}", dependencies=[Depends(verify_cf_access)])
async def delete_event(
    request: Request,
    event_id: str,
    cfg: "Config" = Depends(get_settings),
    calendar_name: Optional[str] = Query(None, alias="calendarName"),
):
    """CalDAV DELETE 删除事件 (event_id = ical_uid), 不可撤销。

    确认语义 = CLI --yes / Electron runEventDelete 恒 --yes: 前端在 5 秒撤销窗口
    之后才发本请求, HTTP 请求本身即确认。本地行软删由下轮 CalDAV sync reconcile。
    data = {action:'deleted', ical_uid, calendar_name} 透传。
    """
    svc = _build_service(cfg)
    try:
        data = await asyncio.to_thread(
            svc.delete_event, ical_uid=event_id, calendar_name=calendar_name,
        )
    except ValueError as exc:
        # CLI delete: 全部 ValueError → not found (writer 只在 UID 缺失时抛)
        raise APIError(
            "E_NOT_FOUND", str(exc),
            hint="检查 ical_uid 存在 + DavMail CalDAV 可达", source="cli",
        ) from exc
    except Exception as exc:
        raise APIError(
            "E_CALDAV", f"calendar delete failed: {exc}",
            hint="检查 ical_uid 存在 + DavMail CalDAV 可达",
            http_status=502, source="cli",
        ) from exc

    _audit_write(request, "delete", uid=event_id, calendar_name=calendar_name)
    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# POST /api/calendar/events/{event_id}/rsvp — CalendarService.send_rsvp (iTIP REPLY)
# ===========================================================================


@router.post("/events/{event_id}/rsvp", dependencies=[Depends(verify_cf_access)])
async def event_rsvp(
    request: Request,
    event_id: str,
    cfg: "Config" = Depends(get_settings),
):
    """发 iTIP REPLY 给 organizer (event_id = ical_uid; CLI `calendar rsvp`)。

    body (EventRsvpOpts): {response, recurrenceId?, source?, dryRun?}。
    response 大小写不敏感 + 同义词 (RSVP_RESPONSE_ALIAS: accept/yes → ACCEPTED,
    tentative/maybe → TENTATIVE, decline/no/reject → DECLINED — PARTSTAT 三值域)。
    dryRun=true → 查 row + 拼 plan (含 body_preview), 不发 SMTP。
    ⚠️ 非 dry-run = 真发 RSVP 信, 不可撤回 (前端确认卡把关, D1)。
    data 形状 = CLI rsvp emit: {action, ical_uid, recurrence_id, source,
    response_status, to_email, dry_run, body_preview?, organizer_freshness_warning?}。
    """
    from src.calendar_sync.service import RSVP_RESPONSE_ALIAS

    raw = await _read_body_object(request)

    response = _opt_str(raw, "response")
    response_key = (response or "").strip().lower()
    response_status = RSVP_RESPONSE_ALIAS.get(response_key)
    if response_status is None:
        raise APIError(
            "E_INVALID_ARG",
            f"body.response={response!r} unknown; valid: "
            f"{sorted(set(RSVP_RESPONSE_ALIAS.keys()))}",
            source="cli",
        )
    recurrence_id = _opt_str(raw, "recurrenceId")
    source = _opt_str(raw, "source")
    dry_run = _opt_bool(raw, "dryRun") or False

    svc = _build_service(cfg)
    try:
        result = await asyncio.to_thread(
            svc.send_rsvp,
            ical_uid=event_id,
            response_status=response_status,
            recurrence_id=recurrence_id,
            source=source,
            dry_run=dry_run,
        )
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg or "missing" in msg.lower():
            raise APIError("E_NOT_FOUND", msg, source="cli") from exc
        raise APIError("E_INVALID_ARG", msg, source="cli") from exc
    except Exception as exc:
        raise APIError(
            "E_UPSTREAM", f"rsvp failed: {exc}",
            hint="检查 DavMail SMTP 端口可达 (127.0.0.1:1025) + cipher key 正确 "
            "+ organizer 邮箱有效",
            http_status=502, source="cli",
        ) from exc

    # data 拼装照 CLI rsvp (body_preview / freshness warning 仅非空时带)。
    data = {
        "action": result["action"],
        "ical_uid": result["ical_uid"],
        "recurrence_id": result["recurrence_id"],
        "source": result["source"],
        "response_status": result["response_status"],
        "to_email": result["to_email"],
        "dry_run": result.get("dry_run", False),
    }
    if result.get("body_preview"):
        data["body_preview"] = result["body_preview"]
    if result.get("organizer_freshness_warning"):
        data["organizer_freshness_warning"] = result["organizer_freshness_warning"]

    if not dry_run:
        _audit_write(
            request, "rsvp",
            uid=event_id,
            response_status=response_status,
            to_email=result.get("to_email"),
        )
    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# POST /api/calendar/events/{event_id}/replay — CalendarService.replay_event_to_notion
# ===========================================================================


@router.post("/events/{event_id}/replay", dependencies=[Depends(verify_cf_access)])
async def event_replay(
    request: Request,
    event_id: str,
    cfg: "Config" = Depends(get_settings),
):
    """重导出 calendar_event 行到 Notion mirror (event_id = ical_uid; CLI `calendar replay`)。

    body (EventReplayOpts): {recurrenceId?, source?, dryRun?}。source 留空 =
    caldav → email_ics → legacy 顺序自动查。dryRun=true → 仅查 row + 拼 plan。
    data = service 结果 dict 透传 (executed {action, page_id, ...} | dry-run plan)。
    """
    raw = await _read_body_object(request)

    recurrence_id = _opt_str(raw, "recurrenceId")
    source = _opt_str(raw, "source")
    dry_run = _opt_bool(raw, "dryRun") or False

    svc = _build_service(cfg)
    try:
        data = await asyncio.to_thread(
            svc.replay_event_to_notion,
            ical_uid=event_id,
            recurrence_id=recurrence_id,
            source=source,
            dry_run=dry_run,
        )
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise APIError(
                "E_NOT_FOUND", msg,
                hint="check `mailagent calendar event-get` or run sync-now first",
                source="cli",
            ) from exc
        raise APIError("E_INVALID_ARG", msg, source="cli") from exc
    except Exception as exc:
        raise APIError(
            "E_UPSTREAM", f"replay failed: {exc}",
            hint="检查 Notion token / 网络 / calendar_event row 完整性",
            http_status=502, source="cli",
        ) from exc

    if not dry_run:
        _audit_write(request, "replay", uid=event_id, page_id=data.get("page_id"))
    return success_envelope(data, request=request, source="cli")
