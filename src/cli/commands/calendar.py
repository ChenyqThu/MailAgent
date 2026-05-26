"""mailagent calendar — 日历相关 (RFC v2 §4.10).

Phase 3 §P1-b: 13 个 subcommand 全部走 ``CalendarService`` facade. 每个
subcommand 职责降为 (parse args → call service.method → format response),
~40 行/cmd. 业务逻辑 (repo/CalDAV/SMTP 调用 + dry-run plan 拼装 + source
fallback) 见 ``src/calendar_sync/service.py``.

Subcommands:
- ``expand`` — 周期会议 occurrence 滚动展开 (dry-run plan / inline 触发)
- ``events`` / ``today`` / ``week`` — 时间窗口查询 (Phase 2 §2.1)
- ``event-get`` — 单事件详情
- ``sync-status`` / ``sync-now`` — CalDAV 同步状态 / 手动触发
- ``replay <ical_uid>`` — 重导出 calendar_event 行到 Notion (Phase 2.4)
- ``rsvp <ical_uid> <response>`` — iTIP REPLY 发 organizer (Phase 2.1)
- ``create`` / ``update`` / ``delete`` — CalDAV PUT/DELETE 事件 CRUD (Phase 2.2/2.3)
- ``recurring discover`` / ``recurring replay`` — RRULE master 扫 + 重跑
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

import typer

from src.calendar_sync.service import (
    CalendarService,
    RSVP_RESPONSE_ALIAS,
    VALID_EVENT_SOURCES,
    VALID_EVENT_STATUS,
)
from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliNotFoundError,
)
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="calendar",
    help="日历: expand / events / today / week / event-get / sync-* / replay / rsvp / create / update / delete / recurring (RFC §4.10)",
    no_args_is_help=True,
)

recurring_app = typer.Typer(
    name="recurring",
    help="周期会议 (RRULE) discover / replay 子组",
    no_args_is_help=True,
)
app.add_typer(recurring_app, name="recurring")


# ============================================================
# Helpers — shared across commands
# ============================================================

def _build_service(cli: "CliContext") -> CalendarService:
    """从 CliContext 构造 CalendarService — service cheap, 每次 call 新构 OK."""
    from src.config import config as global_cfg
    return CalendarService(
        db_path=cli.cli_config.sync_store_db_path,
        cfg=global_cfg,
    )


def _parse_iso_date_opt(s: Optional[str], *, field_name: str) -> Optional[datetime]:
    """YYYY-MM-DD → tz-aware UTC datetime (00:00). 留空返回 None. 失败 raise."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise CliInvalidArgError(
            f"--{field_name}={s!r} not a valid ISO date (expected YYYY-MM-DD)"
        ) from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_iso_datetime_strict(s: str, field: str) -> datetime:
    """ISO datetime with tz required; naive 拒绝. 'Z' 后缀 → '+00:00'."""
    s_clean = s.strip()
    if s_clean.endswith("Z"):
        s_clean = s_clean[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s_clean)
    except ValueError as e:
        raise CliInvalidArgError(
            f"--{field}={s!r} not valid ISO datetime "
            f"(e.g. '2026-05-30T14:00:00+08:00' or '2026-05-30T06:00:00Z')"
        ) from e
    if dt.tzinfo is None:
        raise CliInvalidArgError(
            f"--{field}={s!r} naive datetime not allowed; must include tz offset, "
            f"e.g. '2026-05-30T14:00:00+08:00'"
        )
    return dt.astimezone(timezone.utc)


def _parse_attendees(attendee_specs: list[str]) -> list[dict]:
    """``--attendee 'email[,name]'`` 多个 → list of dict."""
    out: list[dict] = []
    for spec in attendee_specs:
        parts = spec.split(",", 1)
        email = parts[0].strip()
        if not email or "@" not in email:
            raise CliInvalidArgError(
                f"--attendee={spec!r} not valid; expected 'email[,name]'"
            )
        entry = {"email": email}
        if len(parts) == 2 and parts[1].strip():
            entry["name"] = parts[1].strip()
        out.append(entry)
    return out


# ============================================================
# expand (US-007)
# ============================================================

@app.command("expand")
def calendar_expand(
    ctx: typer.Context,
    horizon_weeks: int = typer.Option(
        8, "--horizon-weeks", "-w",
        help="展开到未来 N 周 (default 8, 与 cfg.meeting_expansion_horizon_weeks 默认一致)",
    ),
    dry_run: bool = typer.Option(
        True, "--dry-run/--no-dry-run",
        help="列 series 待展开; --no-dry-run 直接执行一次 expansion tick",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """单次触发周期会议 occurrence 滚动展开 (main.py 中 _meeting_expansion_loop 的单次版)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if horizon_weeks <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--horizon-weeks must be > 0, got {horizon_weeks}",
        ))

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        data = svc.expand_recurring(
            sync_store=cli.sync_store,
            horizon_weeks=horizon_weeks,
            dry_run=dry_run,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"calendar expansion tick failed: {e}",
            hint="检查 recurring_series 数据、Notion 日历配置和网络连接",
        ))

    if not dry_run:
        if cli.output.lower() == "text":
            print(
                f"calendar expand inline horizon_weeks={horizon_weeks} "
                f"series={data['series_scanned']} "
                f"occurrences_synced={data['occurrences_synced']} "
                f"errors={len(data['errors'])}"
            )
        else:
            emit(cli, data)
        if data["errors"]:
            raise typer.Exit(code=6)
        return

    if cli.output.lower() == "text":
        print(
            f"horizon_weeks={horizon_weeks} cutoff={data['cutoff_iso']}"
        )
        print(f"pending series={data['total_series']}")
        for p in data["expanded"][:20]:
            print(
                f"  uid={p['series_uid']} last_occ={p['last_occurrence_dtstart']} "
                f"subj={(p['subject'] or '')[:40]}"
            )
    else:
        emit(cli, data)


# ============================================================
# recurring discover (US-007)
# ============================================================

@recurring_app.command("discover")
def calendar_recurring_discover(
    ctx: typer.Context,
    since: Optional[str] = typer.Option(
        None, "--since",
        help="dtstart 起始日期 YYYY-MM-DD; 留空 = 全部 RRULE master 事件 "
             "(Phase 1.5: 默认不再 fallback SYNC_START_DATE, 因为 master 的 "
             "dtstart 可能远早于今天但 RRULE 仍 valid)",
    ),
    discover_limit: int = typer.Option(
        2000, "--discover-limit",
        help="最多返回 N 行 calendar_event (按 dtstart DESC 排, default 2000)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """扫 SyncStore 找带 RRULE 的会议邀请 (read-only, 不写 Notion)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    svc = _build_service(cli)
    try:
        data = svc.discover_recurring_series(
            sync_store=cli.sync_store,
            since=since,
            limit=discover_limit,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"discover_recurring failed: {e}",
            hint="检查 SyncStore schema (calendar_event 表需 v15+); "
                 "若 worker 未启用 CALENDAR_CALDAV_SYNC_ENABLED, 该表会是空的",
        ))

    if cli.output.lower() == "text":
        print(
            f"series={data['total_series']} matches={data['matches_total']} "
            f"since={data['since']} limit={data['limit']}"
        )
        for s in data["series"][:30]:
            print(
                f"  uid={s['series_uid']} master={s['master_dtstart']} "
                f"iids={s['internal_ids']} subj={(s['summary'] or '')[:40]}"
            )
    else:
        emit(cli, data)


# ============================================================
# recurring replay (US-007)
# ============================================================

@recurring_app.command("replay")
def calendar_recurring_replay(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Argument(
        None, help="单封邀请 internal_id (RFC §4.10 positional, 与 --ids 互斥)",
    ),
    ids: Optional[str] = typer.Option(
        None, "--ids", help="逗号分隔: 53120,53121",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="仅列 plan 不实跑"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """重跑指定 internal_id 的会议邀请 (修复历史 recurring mis-sync)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    explicit: list[int] = []
    if internal_id is not None:
        explicit.append(internal_id)
    if ids:
        try:
            for part in ids.split(","):
                if not part.strip():
                    continue
                explicit.append(int(part.strip()))
        except ValueError as e:
            raise emit_cli_error(cli, CliInvalidArgError(
                f"--ids must be comma-separated integers: {e}",
            ))
    if not explicit:
        raise emit_cli_error(cli, CliInvalidArgError(
            "need --internal-id N or --ids N1,N2,...",
        ))

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    if dry_run:
        svc = _build_service(cli)
        data = svc.recurring_replay_by_internal_ids(
            internal_ids=explicit,
            sync_store=cli.sync_store,
            arm=None,  # dry_run 不调 arm
            dry_run=True,
        )
        if cli.output.lower() == "text":
            print(f"[dry-run] would replay {len(explicit)} invites")
            for iid in explicit:
                print(f"  internal_id={iid}")
        else:
            emit(cli, data)
        return

    try:
        arm = cli.backend.arm
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"backend probe failed: {e}",
            hint="检查 MAILAGENT_BACKEND env 和后端可达性",
        ))

    svc = _build_service(cli)
    data = svc.recurring_replay_by_internal_ids(
        internal_ids=explicit,
        sync_store=cli.sync_store,
        arm=arm,
        dry_run=False,
    )
    if cli.output.lower() == "text":
        print(
            f"replay total={data['total']} succeeded={data['succeeded']} "
            f"failed={data['failed']}"
        )
        for it in data["replayed"]:
            print(f"  iid={it['internal_id']} action={it['action']}")
    else:
        emit(cli, data)


# ============================================================
# Phase 2 — Calendar SSoT 查询 (走 calendar_event 表)
# ============================================================

@app.command("events")
def calendar_events(
    ctx: typer.Context,
    from_date: Optional[str] = typer.Option(
        None, "--from", help="窗口起 YYYY-MM-DD (UTC, default 今天 00:00)",
    ),
    to_date: Optional[str] = typer.Option(
        None, "--to", help="窗口止 YYYY-MM-DD (UTC, default 7 天后)",
    ),
    calendar_name: Optional[str] = typer.Option(
        None, "--calendar", help="只看指定 calendar (e.g. 'Personal')",
    ),
    source: Optional[str] = typer.Option(
        None, "--source",
        help=f"过滤 source ∈ {VALID_EVENT_SOURCES}; 留空 = 全部",
    ),
    limit: int = typer.Option(500, "--limit", help="最多返回 N 个 occurrence"),
    no_expand: bool = typer.Option(
        False, "--no-expand",
        help="不展开 RRULE (仅返主事件); 默认展开",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """读 calendar_event 表的 occurrences (RRULE 已展开). Phase 2 §2.1."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    try:
        ws = _parse_iso_date_opt(from_date, field_name="from")
        we = _parse_iso_date_opt(to_date, field_name="to")
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)
    if ws is None:
        ws = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
    if we is None:
        we = ws + timedelta(days=7)

    svc = _build_service(cli)
    try:
        data = svc.list_events_in_window(
            window_start=ws, window_end=we,
            calendar_name=calendar_name, source=source, limit=limit,
            expand_recurrences=not no_expand,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))

    if cli.output.lower() == "text":
        print(
            f"events total={data['total']} "
            f"window=[{ws.isoformat()}, {we.isoformat()}) "
            f"calendar={calendar_name!r} source={source!r}"
        )
        for ev in data["events"][:20]:
            print(
                f"  {ev['occurrence_start_iso']} → {ev['occurrence_end_iso']} "
                f"{ev['summary'][:50]!r}"
            )
        if len(data["events"]) > 20:
            print(f"  ... ({len(data['events']) - 20} more truncated; use -o json)")
    else:
        emit(cli, data)


@app.command("today")
def calendar_today(
    ctx: typer.Context,
    calendar_name: Optional[str] = typer.Option(None, "--calendar"),
    source: Optional[str] = typer.Option(None, "--source"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """快捷: 拉今天 [00:00, 24:00) 内的 occurrences."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    svc = _build_service(cli)
    try:
        data = svc.list_today(calendar_name=calendar_name, source=source)
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))

    if cli.output.lower() == "text":
        print(f"today events: {data['total']}")
        for ev in data["events"]:
            print(
                f"  {ev['occurrence_start_iso'][11:16]} → "
                f"{ev['occurrence_end_iso'][11:16]} {ev['summary'][:60]!r}"
            )
    else:
        emit(cli, data)


@app.command("week")
def calendar_week(
    ctx: typer.Context,
    calendar_name: Optional[str] = typer.Option(None, "--calendar"),
    source: Optional[str] = typer.Option(None, "--source"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """快捷: 今天起未来 7 天."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    svc = _build_service(cli)
    try:
        data = svc.list_week(calendar_name=calendar_name, source=source)
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))

    if cli.output.lower() == "text":
        print(f"week events: {data['total']}")
        for ev in data["events"]:
            print(
                f"  {ev['occurrence_start_iso'][:16]} {ev['summary'][:60]!r}"
            )
    else:
        emit(cli, data)


# ============================================================
# event-get — 单事件详情
# ============================================================

@app.command("event-get")
def calendar_event_get(
    ctx: typer.Context,
    ical_uid: str = typer.Argument(..., help="vEvent UID (RFC 5545)"),
    recurrence_id: Optional[str] = typer.Option(
        None, "--recurrence-id",
        help="非空 = 拿单次跳脱 occurrence; 留空 = 主事件",
    ),
    source: str = typer.Option(
        "caldav", "--source",
        help=f"source ∈ {VALID_EVENT_SOURCES}",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """按 (ical_uid, recurrence_id, source) 拿单 event 完整 row."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    svc = _build_service(cli)
    try:
        data = svc.get_event(
            ical_uid=ical_uid, source=source, recurrence_id=recurrence_id,
        )
    except ValueError as e:
        msg = str(e)
        if "not found" in msg:
            raise emit_cli_error(cli, CliNotFoundError(
                msg,
                hint="check sync-status / events listings, may be soft-deleted or wrong source",
            ))
        raise emit_cli_error(cli, CliInvalidArgError(msg))

    if cli.output.lower() == "text":
        event = data["event"]
        print(
            f"event id={event['id']} uid={event['ical_uid']!r} "
            f"recurrence_id={event['recurrence_id']!r}"
        )
        print(f"  summary: {event['summary']}")
        print(f"  start:   {event['dtstart_iso'] or '—'}")
        print(f"  end:     {event['dtend_iso'] or '—'}")
        print(f"  rrule:   {event['rrule'] or '—'}")
        print(f"  status:  {event['status']}  response: {event['response_status']}")
        print(f"  attendees: {len(event['attendees'])}")
        print(f"  source: {event['source']}  calendar: {event['calendar_name']}")
        if event["notion_page_id"]:
            print(f"  notion: {event['notion_page_id']}")
    else:
        emit(cli, data)


# ============================================================
# sync-status — 列 calendar_sync_state 表
# ============================================================

@app.command("sync-status")
def calendar_sync_status(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出所有 calendar 的 CalDAV sync 状态 (ctag / sync_token / 时间戳)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    svc = _build_service(cli)
    worker_enabled = bool(
        getattr(cli.cli_config, "calendar_caldav_sync_enabled", False)
    )
    data = svc.list_sync_states(worker_enabled=worker_enabled)

    if cli.output.lower() == "text":
        print(
            f"sync-status: {data['total']} calendars, "
            f"worker_enabled={data['worker_enabled']}"
        )
        for c in data["calendars"]:
            err = f" [ERR: {c['last_error']}]" if c["last_error"] else ""
            print(
                f"  {c['calendar_name']!r}  ctag={c['ctag']}  "
                f"last_inc={c['last_incremental_sync_at_iso']}{err}"
            )
    else:
        emit(cli, data)


# ============================================================
# sync-now — 手动触发一次全窗口 sync
# ============================================================

@app.command("sync-now")
def calendar_sync_now(
    ctx: typer.Context,
    full: bool = typer.Option(
        True, "--full/--incremental",
        help="--full (default) 全窗口 re-read; --incremental 走 sync-collection (DavMail 支持有限).",
    ),
    calendar_name: Optional[str] = typer.Option(
        None, "--calendar", help="只 sync 指定 calendar; 留空 = 全部 calendars",
    ),
    past_days: int = typer.Option(30, "--past-days"),
    future_days: int = typer.Option(180, "--future-days"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """手动跑一次 CalDAV → SQLite sync (admin/debug; mail-sync 进程内 worker 自动跑)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        data = svc.sync_now(
            full=full, calendar_name=calendar_name,
            past_days=past_days, future_days=future_days,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"CalDAV connect failed: {e}",
            hint="检查 DavMail 1080 端口是否 online + .env 里 DAVMAIL_CIPHER_KEY",
        ))

    ws_iso = data["window"]["from_iso"]
    we_iso = data["window"]["to_iso"]
    if cli.output.lower() == "text":
        print(
            f"sync-now mode={data['mode']} "
            f"calendars={data['total_calendars']} "
            f"window=[{ws_iso[:10]}, {we_iso[:10]})"
        )
        for r in data["results"]:
            if "error" in r:
                print(f"  ✗ {r['calendar_name']!r}: {r['error'][:80]}")
            else:
                print(
                    f"  ✓ {r['calendar_name']!r}: upserted={r.get('upserted', '?')} "
                    f"soft_deleted={r.get('soft_deleted', '?')} "
                    f"ctag={r.get('ctag', '—')}"
                )
    else:
        emit(cli, data)


# ============================================================
# Phase 2.4 — replay 单 calendar_event 行到 Notion mirror
# ============================================================

@app.command("replay")
def calendar_replay(
    ctx: typer.Context,
    ical_uid: str = typer.Argument(..., help="vEvent UID (RFC 5545)"),
    recurrence_id: Optional[str] = typer.Option(
        None, "--recurrence-id",
        help="非空 = replay 单次跳脱 occurrence; 留空 = 主事件",
    ),
    source: Optional[str] = typer.Option(
        None, "--source",
        help=f"限定 source ∈ {VALID_EVENT_SOURCES}; "
             "留空 = 按 caldav→email_ics→legacy 顺序自动查",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="仅查 row + 列 plan, 不写 Notion (无需 auth)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """重导出 SQLite calendar_event 行到 Notion (Phase 2.4)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        data = svc.replay_event_to_notion(
            ical_uid=ical_uid, recurrence_id=recurrence_id,
            source=source, dry_run=dry_run,
        )
    except ValueError as e:
        msg = str(e)
        if "not found" in msg:
            raise emit_cli_error(cli, CliNotFoundError(
                msg,
                hint="check `mailagent calendar event-get` or run sync-now first",
            ))
        raise emit_cli_error(cli, CliInvalidArgError(msg))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"replay failed: {e}",
            hint="检查 Notion token / 网络 / calendar_event row 完整性",
        ))

    if cli.output.lower() == "text":
        if dry_run:
            print(
                f"[dry-run] would replay: id={data['row_id']} "
                f"source={data['source']} "
                f"summary={(data['summary'] or '')[:60]!r} "
                f"current_page_id={data['current_notion_page_id']!r}"
            )
        else:
            print(
                f"replay {data['action']}: ical_uid={data['ical_uid']!r} "
                f"source={data['source']} page_id={data['page_id']}"
            )
    else:
        emit(cli, data)


# ============================================================
# Phase 2.1 — RSVP
# ============================================================

@app.command("rsvp")
def calendar_rsvp(
    ctx: typer.Context,
    ical_uid: str = typer.Argument(..., help="vEvent UID (RFC 5545)"),
    response: str = typer.Argument(
        ..., help="accept / tentative / decline (大小写不敏感; 接受常见同义词)",
    ),
    recurrence_id: Optional[str] = typer.Option(
        None, "--recurrence-id",
        help="非空 = RSVP 单次跳脱 occurrence; 留空 = 整系列",
    ),
    source: Optional[str] = typer.Option(
        None, "--source",
        help=f"限定 source ∈ {VALID_EVENT_SOURCES}; "
             "留空 = 按 caldav→email_ics→legacy 顺序自动查",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="仅查 row + 拼 plan, 不发 SMTP (无需 auth, 返回 body_preview)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """发 iTIP REPLY (接受/暂定/拒绝) 给原 invite 的 organizer (Phase 2.1)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    response_key = response.strip().lower()
    response_status = RSVP_RESPONSE_ALIAS.get(response_key)
    if response_status is None:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"response={response!r} unknown; valid: "
            f"{sorted(set(RSVP_RESPONSE_ALIAS.keys()))}",
        ))

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        result = svc.send_rsvp(
            ical_uid=ical_uid, response_status=response_status,
            recurrence_id=recurrence_id, source=source, dry_run=dry_run,
        )
    except ValueError as e:
        msg = str(e)
        if "not found" in msg or "missing" in msg.lower():
            raise emit_cli_error(cli, CliNotFoundError(msg))
        raise emit_cli_error(cli, CliInvalidArgError(msg))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"rsvp failed: {e}",
            hint="检查 DavMail SMTP 端口可达 (127.0.0.1:1025) + cipher key 正确 + organizer 邮箱有效",
        ))

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
    # Phase 3 §P1-e: surface organizer freshness warning (email_ics 源邮件可能 stale)
    if result.get("organizer_freshness_warning"):
        data["organizer_freshness_warning"] = result["organizer_freshness_warning"]

    if cli.output.lower() == "text":
        if dry_run:
            print(
                f"[dry-run] would send RSVP: status={result['response_status']} "
                f"to={result['to_email']} source={result['source']}"
            )
            print(f"  body preview:\n{result['body_preview']}")
        else:
            print(
                f"rsvp sent: status={result['response_status']} "
                f"to={result['to_email']} ical_uid={result['ical_uid']!r}"
            )
        if result.get("organizer_freshness_warning"):
            print(f"  ⚠ {result['organizer_freshness_warning']}")
    else:
        emit(cli, data)


# ============================================================
# Phase 2.2/2.3 — event CRUD (CalDAV PUT/DELETE)
# ============================================================

@app.command("create")
def calendar_create(
    ctx: typer.Context,
    summary: str = typer.Option(..., "--summary", help="事件标题 (必填)"),
    start: str = typer.Option(
        ..., "--start",
        help="ISO datetime 含 tz; e.g. '2026-05-30T14:00:00+08:00' 或 'Z' 结尾",
    ),
    end: str = typer.Option(..., "--end", help="ISO datetime 含 tz (同上)"),
    location: Optional[str] = typer.Option(None, "--location"),
    description: Optional[str] = typer.Option(None, "--description"),
    attendee: list[str] = typer.Option(
        None, "--attendee",
        help="附加 attendee, 格式 'email[,name]'; 可多次传",
    ),
    calendar_name: Optional[str] = typer.Option(
        None, "--calendar", help="目标 calendar 名; 留空 = 默认 (Outlook 主日历)",
    ),
    status: str = typer.Option(
        "CONFIRMED", "--status", help=f"事件状态 ∈ {VALID_EVENT_STATUS}",
    ),
    rrule: Optional[str] = typer.Option(
        None, "--rrule",
        help="RFC 5545 RRULE (不含 'RRULE:' 前缀, 如 'FREQ=WEEKLY;BYDAY=MO'); "
             "留空 = 单次事件 (Phase 4·#3)",
    ),
    all_day: bool = typer.Option(
        False, "--all-day",
        help="全天事件 (Phase 4·#2): DTSTART/DTEND 用 VALUE=DATE (取 start/end "
             "ISO 的 date 部分); end 为 exclusive (单日传次日, 如 5/30 全天 → "
             "--start ...05-30T00:00:00Z --end ...05-31T00:00:00Z)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """通过 CalDAV PUT 在 Exchange 创建新事件 (Phase 2.2)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    try:
        dtstart = _parse_iso_datetime_strict(start, "start")
        dtend = _parse_iso_datetime_strict(end, "end")
        attendees = _parse_attendees(attendee or [])
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        result = svc.create_event(
            summary=summary,
            dtstart_utc=dtstart, dtend_utc=dtend,
            location=location, description=description,
            attendees=attendees, calendar_name=calendar_name,
            status=status, rrule=rrule, is_all_day=all_day,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"calendar create failed: {e}",
            hint="检查 DavMail CalDAV (1080) 可达 + cipher key + calendar 名是否存在",
        ))

    if cli.output.lower() == "text":
        print(
            f"created event uid={result['ical_uid']} "
            f"summary={summary!r} "
            f"calendar={result['calendar_name']!r} "
            f"start={result['dtstart_iso']}"
        )
    else:
        emit(cli, result)


@app.command("update")
def calendar_update(
    ctx: typer.Context,
    ical_uid: str = typer.Argument(..., help="vEvent UID (RFC 5545)"),
    summary: Optional[str] = typer.Option(None, "--summary"),
    start: Optional[str] = typer.Option(None, "--start"),
    end: Optional[str] = typer.Option(None, "--end"),
    location: Optional[str] = typer.Option(None, "--location"),
    description: Optional[str] = typer.Option(None, "--description"),
    attendee: list[str] = typer.Option(
        None, "--attendee",
        help="完整 attendee 列表 (会替换原列表; 不传 → 不写 ATTENDEE 行)",
    ),
    status: Optional[str] = typer.Option(None, "--status"),
    calendar_name: Optional[str] = typer.Option(None, "--calendar"),
    no_sequence_bump: bool = typer.Option(
        False, "--no-sequence-bump",
        help="不 +1 SEQUENCE (默认 +1, RFC 5545 标准: 任何 update 都要 bump)",
    ),
    rrule: Optional[str] = typer.Option(
        None, "--rrule",
        help="改整系列 RRULE (Phase 4·#3): 不传 = 保留原值; 'FREQ=...' 覆盖; "
             "'' (空串) 删除 RRULE 把周期变单次",
    ),
    all_day: Optional[bool] = typer.Option(
        None, "--all-day/--no-all-day",
        help="全天状态 (Phase 4·#2): 不传 = 保持原状态; --all-day 改全天; "
             "--no-all-day 改定时事件",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """通过 CalDAV PUT update 现有事件 (Phase 2.3). 不传的字段保留原值."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    dtstart_utc: Optional[datetime] = None
    dtend_utc: Optional[datetime] = None
    attendees: Optional[list[dict]] = None
    try:
        if start:
            dtstart_utc = _parse_iso_datetime_strict(start, "start")
        if end:
            dtend_utc = _parse_iso_datetime_strict(end, "end")
        if attendee:
            attendees = _parse_attendees(attendee)
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        result = svc.update_event(
            ical_uid=ical_uid,
            summary=summary,
            dtstart_utc=dtstart_utc, dtend_utc=dtend_utc,
            location=location, description=description,
            attendees=attendees, status=status,
            calendar_name=calendar_name,
            sequence_bump=not no_sequence_bump,
            rrule=rrule, is_all_day=all_day,
        )
    except ValueError as e:
        msg = str(e)
        if "not found" in msg:
            raise emit_cli_error(cli, CliNotFoundError(msg))
        raise emit_cli_error(cli, CliInvalidArgError(msg))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"calendar update failed: {e}",
            hint="检查 ical_uid 存在 + DavMail CalDAV 可达",
        ))

    if cli.output.lower() == "text":
        print(
            f"updated event uid={result['ical_uid']} "
            f"sequence={result['sequence']} calendar={result['calendar_name']!r}"
        )
    else:
        emit(cli, result)


@app.command("delete")
def calendar_delete(
    ctx: typer.Context,
    ical_uid: str = typer.Argument(..., help="vEvent UID (RFC 5545)"),
    calendar_name: Optional[str] = typer.Option(None, "--calendar"),
    yes: bool = typer.Option(
        False, "--yes",
        help="确认删除 (必填, 防误删); 留空 = 拒绝执行",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """通过 CalDAV DELETE 删除事件 (Phase 2.3). 不可撤销, 必须 --yes."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "calendar delete is destructive; pass --yes to confirm",
        ))

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    svc = _build_service(cli)
    try:
        result = svc.delete_event(
            ical_uid=ical_uid, calendar_name=calendar_name,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliNotFoundError(str(e)))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"calendar delete failed: {e}",
            hint="检查 ical_uid 存在 + DavMail CalDAV 可达",
        ))

    if cli.output.lower() == "text":
        print(
            f"deleted event uid={result['ical_uid']} "
            f"calendar={result['calendar_name']!r}"
        )
    else:
        emit(cli, result)
