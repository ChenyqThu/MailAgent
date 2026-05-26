"""mailagent calendar — 日历相关 (RFC v2 §4.10).

PR-3 US-007:
    expand              手动触发周期会议 occurrence 展开 (PR-3 仅 dry-run plan).
    recurring discover  扫 Mail.app 周期邀请 (RRULE) — 走 scripts.replay_recurring_invite.
    recurring replay    重跑指定 internal_id 的邀请 (修复历史 mis-sync).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

import typer

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
    help="日历: expand (周期会议展开) + recurring discover/replay (RFC §4.10)",
    no_args_is_help=True,
)

recurring_app = typer.Typer(
    name="recurring",
    help="周期会议 (RRULE) discover / replay 子组",
    no_args_is_help=True,
)
app.add_typer(recurring_app, name="recurring")


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

    sync_store = cli.sync_store

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

        from src.calendar_notion.expansion import run_expansion_tick

        meeting_sync = _build_meeting_sync(sync_store)
        try:
            result = asyncio.run(
                run_expansion_tick(
                    sync_store,
                    meeting_sync,
                    horizon_weeks,
                    dry_run=False,
                )
            )
        except Exception as e:
            raise emit_cli_error(cli, CliError(
                f"calendar expansion tick failed: {e}",
                hint="检查 recurring_series 数据、Notion 日历配置和网络连接",
            ))

        data = {
            "action": "calendar-expand",
            "mode": "inline",
            "horizon_weeks": horizon_weeks,
            "series_scanned": result.get("series_scanned", 0),
            "occurrences_synced": result.get("occurrences_synced", 0),
            "errors": result.get("errors", []),
        }
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

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(weeks=horizon_weeks)
    cutoff_iso = cutoff.isoformat()

    expanded: list[dict] = []
    try:
        for row in sync_store.iter_series_needing_expansion(cutoff_iso):
            # PR-3 dry-run: PRD §US-007 / RFC §4.10 — 列出待 expand 的 series,
            # occurrences_added=0 因为 dry-run 不实跑展开 (实跑路径走 main.py loop).
            expanded.append({
                "series_uid": row.get("series_uid"),
                "master_dtstart": row.get("master_dtstart"),
                "last_occurrence_dtstart": row.get("last_occurrence_dtstart"),
                "notion_page_id": row.get("notion_page_id"),
                "subject": row.get("subject"),
                "occurrences_added": 0,
            })
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"sync_store.iter_series_needing_expansion failed: {e}",
            hint="检查 SyncStore schema (recurring_series 表是否存在)",
        ))

    data = {
        "action": "calendar-expand",
        "mode": "dry_run",
        "horizon_weeks": horizon_weeks,
        "cutoff_iso": cutoff_iso,
        "expanded": expanded,
        "total_series": len(expanded),
        "total_occurrences_added": 0,
        "dry_run": True,
    }

    if cli.output.lower() == "text":
        print(f"horizon_weeks={horizon_weeks} cutoff={cutoff_iso}")
        print(f"pending series={len(expanded)}")
        for p in expanded[:20]:
            print(
                f"  uid={p['series_uid']} last_occ={p['last_occurrence_dtstart']} "
                f"subj={(p['subject'] or '')[:40]}"
            )
    else:
        emit(cli, data)


def _build_meeting_sync(sync_store):
    from src.mail.meeting_sync import MeetingInviteSync

    return MeetingInviteSync(sync_store=sync_store)


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

    if discover_limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--discover-limit must be > 0, got {discover_limit}",
        ))

    # Phase 1.5: 不再 fallback sync_start_date — discover 现在查 calendar_event 表的
    # RRULE master, dtstart 可能远早于 today 但 RRULE 仍 valid. 用户想筛窗口显式传 --since.
    since_eff = since

    # Phase 1.5 重构: discover_recurring 改读 calendar_event 表 (CalendarSyncWorker
    # 已落库 SSoT), 不再 IMAP fetch 邮件 .ics. 不需要 cli.backend.arm, 也不再触发
    # davmail probe — 命令变成纯 SQLite 查询.
    from src.calendar_notion.recurring_invite import discover_recurring

    sync_store = cli.sync_store
    try:
        matches = asyncio.run(discover_recurring(
            sync_store, since=since_eff, limit=discover_limit,
        ))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"discover_recurring failed: {e}",
            hint="检查 SyncStore schema (calendar_event 表需 v15+); "
                 "若 worker 未启用 CALENDAR_CALDAV_SYNC_ENABLED, 该表会是空的",
        ))

    # Phase 1.5: scanned = 总 calendar_event rows with rrule != '' (跟新 discover_recurring
    # 的 source 集 + filter 对齐). 用 SQL 直查, 不依赖 discover_limit 近似.
    import sqlite3 as _sql
    from datetime import datetime, timezone

    _scanned_sql = (
        "SELECT COUNT(*) FROM calendar_event "
        "WHERE rrule != '' AND deleted_at IS NULL "
        "AND source IN ('caldav', 'email_ics')"
    )
    _params: list = []
    if since_eff:
        try:
            _d = datetime.fromisoformat(since_eff)
            if _d.tzinfo is None:
                _d = _d.replace(tzinfo=timezone.utc)
            _params.append(_d.astimezone(timezone.utc).timestamp())
            _scanned_sql += " AND dtstart_utc >= ?"
        except (ValueError, TypeError):
            pass
    _conn = _sql.connect(cli.cli_config.sync_store_db_path)
    try:
        actual_scanned = int(_conn.execute(_scanned_sql, _params).fetchone()[0])
    except Exception:
        actual_scanned = 0
    finally:
        _conn.close()

    # PRD §US-007 / RFC §4.10: series 是 GROUPED 输出 (per-series_uid 合并多封
    # invite). PR-3 round-7 fix (codex MAJOR 3): master_dtstart 应该是 group 内
    # **最早 METHOD=REQUEST 的 dtstart**, 不是第一条 (discover_recurring 按
    # date_received DESC 排序, 第一条往往是最新更新而非 master). 先 group, 然后
    # canonical record 选择: 优先 earliest parseable dtstart 中 method=REQUEST 的;
    # 否则 earliest parseable dtstart; 都解析失败 fallback 任意一个.
    grouped: dict[str, list[dict]] = {}
    for m in matches:
        uid = (m.get("uid") or "").strip() or f"__no_uid_iid_{m.get('internal_id')}"
        grouped.setdefault(uid, []).append(m)

    def _safe_dt(s: Optional[str]) -> Optional[str]:
        """返回 ISO 字符串 (lex-sortable) 或 None — 不抛."""
        if not s:
            return None
        return s.strip() or None

    series_list: list[dict] = []
    for uid, group in grouped.items():
        # 先找 method=REQUEST 中最早 dtstart 的
        request_candidates = [
            (g, _safe_dt(g.get("dtstart")))
            for g in group
            if (g.get("method") or "").upper() == "REQUEST"
        ]
        request_candidates = [(g, dt) for g, dt in request_candidates if dt]
        if request_candidates:
            request_candidates.sort(key=lambda t: t[1])
            master = request_candidates[0][0]
        else:
            # 没有 REQUEST 或全无可解析 dtstart: 取所有 group 中最早 dtstart
            all_with_dt = [(g, _safe_dt(g.get("dtstart"))) for g in group]
            all_with_dt = [(g, dt) for g, dt in all_with_dt if dt]
            if all_with_dt:
                all_with_dt.sort(key=lambda t: t[1])
                master = all_with_dt[0][0]
            else:
                master = group[0]  # 全部 dtstart 无法解析 — fallback

        series_list.append({
            "series_uid": uid,
            "master_dtstart": master.get("dtstart"),
            "summary": master.get("subject"),
            "sender": master.get("sender"),
            "organizer": master.get("sender"),  # placeholder; 真 ORGANIZER 留 PR-4
            "rrule": master.get("rrule"),
            "method": master.get("method"),
            "internal_ids": [int(g.get("internal_id")) for g in group],
        })

    matches_total = len(matches)
    data = {
        "series": series_list,
        "total_series": len(series_list),
        "matches_total": matches_total,
        "scanned": actual_scanned,
        "since": since_eff,
        "limit": discover_limit,
    }

    if cli.output.lower() == "text":
        print(
            f"series={len(series_list)} matches={matches_total} "
            f"since={since_eff} limit={discover_limit}"
        )
        for s in series_list[:30]:
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
    """重跑指定 internal_id 的会议邀请 (修复历史 recurring mis-sync).

    RFC §4.10: ``recurring replay [<internal_id> | --ids LIST] [flags]``.
    单封 positional 或 ``--ids`` 逗号批量; 互斥取并集.
    """
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
        data = {
            "replayed": [],
            "total": len(explicit),
            "succeeded": 0,
            "failed": 0,
            "dry_run": True,
            "candidate_internal_ids": explicit,
        }
        if cli.output.lower() == "text":
            print(f"[dry-run] would replay {len(explicit)} invites")
            for iid in explicit:
                print(f"  internal_id={iid}")
        else:
            emit(cli, data)
        return

    # 走 backend factory (plan Phase 0.1) — 同 discover_recurring 修复, 避免硬编码
    # AppleScriptArm 在 davmail 模式下唤起 Mail.app.
    from src.calendar_notion.recurring_invite import replay_one
    from src.mail.meeting_sync import MeetingInviteSync

    sync_store = cli.sync_store
    try:
        arm = cli.backend.arm
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"backend probe failed: {e}",
            hint="检查 MAILAGENT_BACKEND env 和后端可达性",
        ))
    meeting_sync = MeetingInviteSync(sync_store=sync_store)

    items: list[dict] = []
    succeeded = 0
    failed = 0
    for iid in explicit:
        meeting_sync.reset_stats()
        try:
            page_id = asyncio.run(replay_one(iid, sync_store, arm, meeting_sync))
        except Exception as e:  # pragma: no cover - 兜底
            items.append({"internal_id": iid, "action": "error", "error": str(e)})
            failed += 1
            continue
        if page_id is None:
            items.append({
                "internal_id": iid, "action": "skipped",
                "error": "no calendar invite or fetch failed",
            })
            failed += 1
        else:
            items.append({"internal_id": iid, "action": "replayed", "page_id": page_id})
            succeeded += 1

    data = {
        "replayed": items,
        "total": len(explicit),
        "succeeded": succeeded,
        "failed": failed,
        "dry_run": False,
        "candidate_internal_ids": explicit,
    }
    if cli.output.lower() == "text":
        print(f"replay total={len(explicit)} succeeded={succeeded} failed={failed}")
        for it in items:
            print(f"  iid={it['internal_id']} action={it['action']}")
    else:
        emit(cli, data)


# ============================================================
# Phase 2 — Calendar SSoT 查询命令 (走 calendar_event 表)
# 数据源: src/calendar_sync.CalendarEventRepository
# 主要给前端 / agent / 调试用; 不直接调 CalDAV (那是 worker 的事).
# ============================================================

def _parse_iso_date_opt(s: Optional[str], *, field_name: str) -> Optional[datetime]:
    """YYYY-MM-DD → tz-aware UTC datetime (00:00). 留空返回 None. 失败 raise."""
    if not s:
        return None
    try:
        # 容忍 YYYY-MM-DD 或 ISO 完整形式
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise CliInvalidArgError(
            f"--{field_name}={s!r} not a valid ISO date (expected YYYY-MM-DD)"
        ) from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _occurrence_to_dict(occ) -> dict:
    """CalendarEventOccurrence → JSON-serializable dict (CLI output)."""
    r = occ.row
    return {
        "id": r.id,
        "ical_uid": r.ical_uid,
        "recurrence_id": r.recurrence_id,
        "sequence": r.sequence,
        "summary": r.summary,
        "occurrence_start_iso": occ.occurrence_start_utc.isoformat(),
        "occurrence_end_iso": occ.occurrence_end_utc.isoformat(),
        "is_recurrence_instance": occ.is_recurrence_instance,
        "is_all_day": r.is_all_day,
        "calendar_name": r.calendar_name,
        "organizer": r.organizer,
        "attendees": r.attendees,
        "location": r.location,
        "url": r.url,
        "status": r.status,
        "response_status": r.response_status,
        "source": r.source,
        "notion_page_id": r.notion_page_id,
        "related_email_internal_id": r.related_email_internal_id,
    }


def _row_to_dict(r) -> dict:
    """CalendarEventRow → JSON-serializable dict (含原始 dtstart/dtend + ics_raw)."""
    return {
        "id": r.id,
        "ical_uid": r.ical_uid,
        "recurrence_id": r.recurrence_id,
        "sequence": r.sequence,
        "summary": r.summary,
        "description": r.description,
        "location": r.location,
        "organizer": r.organizer,
        "attendees": r.attendees,
        "dtstart_iso": r.dtstart_utc.isoformat() if r.dtstart_utc else None,
        "dtend_iso": r.dtend_utc.isoformat() if r.dtend_utc else None,
        "is_all_day": r.is_all_day,
        "rrule": r.rrule,
        "exdates": r.exdates,
        "rdates": r.rdates,
        "status": r.status,
        "response_status": r.response_status,
        "url": r.url,
        "calendar_name": r.calendar_name,
        "source": r.source,
        "notion_page_id": r.notion_page_id,
        "related_email_internal_id": r.related_email_internal_id,
        "ics_raw": r.ics_raw,
        "last_synced_at_iso": r.last_synced_at.isoformat() if r.last_synced_at else None,
        "created_at_iso": r.created_at.isoformat() if r.created_at else None,
        "updated_at_iso": r.updated_at.isoformat() if r.updated_at else None,
    }


# ============================================================
# events / today / week — 时间窗口查询
# ============================================================

_VALID_EVENT_SOURCES = ("caldav", "email_ics", "legacy_calendar_app")


def _list_events_impl(
    cli: "CliContext",
    *,
    window_start: datetime,
    window_end: datetime,
    calendar_name: Optional[str],
    source: Optional[str],
    limit: int,
    expand_recurrences: bool,
) -> dict:
    from src.calendar_sync import CalendarEventRepository

    repo = CalendarEventRepository(cli.cli_config.sync_store_db_path)
    occs = repo.list_event_occurrences(
        start_utc=window_start,
        end_utc=window_end,
        source=source,
        calendar_name=calendar_name,
        expand_recurrences=expand_recurrences,
    )
    # CLI 层 limit (occurrence count, 跟 repo 内部的 max_per_series 是两回事)
    if len(occs) > limit:
        occs = occs[:limit]
    return {
        "events": [_occurrence_to_dict(o) for o in occs],
        "total": len(occs),
        "window": {
            "from_iso": window_start.isoformat(),
            "to_iso": window_end.isoformat(),
        },
        "filters": {
            "calendar_name": calendar_name,
            "source": source,
            "expand_recurrences": expand_recurrences,
        },
    }


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
        help=f"过滤 source ∈ {_VALID_EVENT_SOURCES}; 留空 = 全部",
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

    if limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be > 0, got {limit}",
        ))
    if source and source not in _VALID_EVENT_SOURCES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source={source!r} not in {_VALID_EVENT_SOURCES}",
        ))

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
    if we <= ws:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--to ({we.isoformat()}) must be > --from ({ws.isoformat()})",
        ))

    data = _list_events_impl(
        cli, window_start=ws, window_end=we,
        calendar_name=calendar_name, source=source, limit=limit,
        expand_recurrences=not no_expand,
    )
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

    if source and source not in _VALID_EVENT_SOURCES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source={source!r} not in {_VALID_EVENT_SOURCES}",
        ))

    ws = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    we = ws + timedelta(days=1)
    data = _list_events_impl(
        cli, window_start=ws, window_end=we,
        calendar_name=calendar_name, source=source, limit=500,
        expand_recurrences=True,
    )
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

    if source and source not in _VALID_EVENT_SOURCES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source={source!r} not in {_VALID_EVENT_SOURCES}",
        ))

    ws = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    we = ws + timedelta(days=7)
    data = _list_events_impl(
        cli, window_start=ws, window_end=we,
        calendar_name=calendar_name, source=source, limit=500,
        expand_recurrences=True,
    )
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
        help=f"source ∈ {_VALID_EVENT_SOURCES}",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """按 (ical_uid, recurrence_id, source) 拿单 event 完整 row."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if source not in _VALID_EVENT_SOURCES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source={source!r} not in {_VALID_EVENT_SOURCES}",
        ))

    from src.calendar_sync import CalendarEventRepository
    repo = CalendarEventRepository(cli.cli_config.sync_store_db_path)

    row = repo.get_by_ical_uid(
        ical_uid, source=source, recurrence_id=recurrence_id,
    )
    if row is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"event not found: ical_uid={ical_uid!r} "
            f"recurrence_id={recurrence_id!r} source={source!r}",
            hint="check sync-status / events listings, may be soft-deleted or wrong source",
        ))

    data = {"event": _row_to_dict(row)}
    if cli.output.lower() == "text":
        print(
            f"event id={row.id} uid={row.ical_uid!r} "
            f"recurrence_id={row.recurrence_id!r}"
        )
        print(f"  summary: {row.summary}")
        print(f"  start:   {row.dtstart_utc.isoformat() if row.dtstart_utc else '—'}")
        print(f"  end:     {row.dtend_utc.isoformat() if row.dtend_utc else '—'}")
        print(f"  rrule:   {row.rrule or '—'}")
        print(f"  status:  {row.status}  response: {row.response_status}")
        print(f"  attendees: {len(row.attendees)}")
        print(f"  source: {row.source}  calendar: {row.calendar_name}")
        if row.notion_page_id:
            print(f"  notion: {row.notion_page_id}")
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

    from src.calendar_sync import CalendarEventRepository
    repo = CalendarEventRepository(cli.cli_config.sync_store_db_path)

    states = repo.list_sync_states()
    calendars = [
        {
            "calendar_name": s.calendar_name,
            "ctag": s.ctag,
            "sync_token": s.sync_token,
            "last_full_sync_at_iso": (
                s.last_full_sync_at.isoformat() if s.last_full_sync_at else None
            ),
            "last_incremental_sync_at_iso": (
                s.last_incremental_sync_at.isoformat()
                if s.last_incremental_sync_at else None
            ),
            "last_error": s.last_error,
        }
        for s in states
    ]
    data = {
        "calendars": calendars,
        "total": len(calendars),
        "worker_enabled": bool(
            getattr(cli.cli_config, "calendar_caldav_sync_enabled", False)
        ),
    }
    if cli.output.lower() == "text":
        print(
            f"sync-status: {data['total']} calendars, "
            f"worker_enabled={data['worker_enabled']}"
        )
        for c in calendars:
            err = f" [ERR: {c['last_error']}]" if c["last_error"] else ""
            print(
                f"  {c['calendar_name']!r}  ctag={c['ctag']}  "
                f"last_inc={c['last_incremental_sync_at_iso']}{err}"
            )
    else:
        emit(cli, data)


# ============================================================
# sync-now — 手动触发一次全窗口 sync (admin/debug 用)
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
    """手动跑一次 CalDAV → SQLite sync (admin/debug; mail-sync 进程内 worker 自动跑).

    与 worker 并发安全 (SQLite WAL + ON CONFLICT 幂等), 但避免无意义的重复请求.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    if past_days < 0 or future_days <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--past-days >= 0 and --future-days > 0; got "
            f"past={past_days} future={future_days}"
        ))

    from src.calendar_notion.caldav_reader import CalDAVReader
    from src.calendar_sync import CalendarEventRepository, CalendarReconciler
    from src.config import config as global_cfg

    reader = CalDAVReader(global_cfg)
    repo = CalendarEventRepository(cli.cli_config.sync_store_db_path)
    reconciler = CalendarReconciler(repo)

    now_utc = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    ws = now_utc - timedelta(days=past_days)
    we = now_utc + timedelta(days=future_days)

    # 决定要 sync 哪些 calendar
    try:
        if calendar_name:
            cals = [calendar_name]
        else:
            cals = reader.list_calendar_names_for_sync()
            if not cals:
                cals = ["calendar"]  # 单 calendar 默认
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"CalDAV connect failed: {e}",
            hint="检查 DavMail 1080 端口是否 online + .env 里 DAVMAIL_CIPHER_KEY",
        ))

    results: list[dict] = []
    for cal in cals:
        try:
            if full:
                events = reader.list_events_with_full_detail(
                    ws, we, calendar_name=cal,
                )
                stats = reconciler.reconcile_full_window(
                    events, calendar_name=cal,
                    window_start=ws, window_end=we,
                )
                ctag = reader.get_collection_ctag(cal)
                repo.upsert_sync_state(
                    cal, ctag=ctag, full_sync=True, last_error=None,
                )
                results.append({
                    "calendar_name": cal,
                    "mode": "full",
                    "upserted": stats.upserted,
                    "soft_deleted": stats.soft_deleted,
                    "errors": stats.errors,
                    "ctag": ctag,
                })
            else:
                state = repo.get_sync_state(cal)
                old_token = state.sync_token if state else None
                changed, deleted, new_token = reader.sync_collection(cal, old_token)
                if new_token is None:
                    results.append({
                        "calendar_name": cal,
                        "mode": "incremental",
                        "status": "not_supported_by_server",
                        "hint": "DavMail sync-collection 支持有限; 改用 --full",
                    })
                    continue
                stats = reconciler.reconcile_incremental(
                    changed, deleted, calendar_name=cal,
                )
                ctag = reader.get_collection_ctag(cal)
                repo.upsert_sync_state(
                    cal, ctag=ctag, sync_token=new_token, last_error=None,
                )
                results.append({
                    "calendar_name": cal,
                    "mode": "incremental",
                    "upserted": stats.upserted,
                    "soft_deleted": stats.soft_deleted,
                    "errors": stats.errors,
                    "ctag": ctag,
                    "sync_token": new_token,
                })
        except Exception as e:
            repo.upsert_sync_state(cal, last_error=str(e)[:500])
            results.append({
                "calendar_name": cal,
                "mode": "full" if full else "incremental",
                "error": str(e)[:500],
            })

    data = {
        "results": results,
        "total_calendars": len(results),
        "window": {"from_iso": ws.isoformat(), "to_iso": we.isoformat()},
        "mode": "full" if full else "incremental",
    }
    if cli.output.lower() == "text":
        print(
            f"sync-now mode={'full' if full else 'incremental'} "
            f"calendars={len(results)} "
            f"window=[{ws.date().isoformat()}, {we.date().isoformat()})"
        )
        for r in results:
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
# 跟老 `recurring replay <internal_id>` 区别:
#   老命令: 基于邮件 .ics 重派生 CalendarEvent — 只对 source='email_ics' 有效
#   新命令: 基于 SQLite calendar_event 行 — 任何 source 都可 (caldav-only 也能)
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
        help=f"限定 source ∈ {_VALID_EVENT_SOURCES}; "
             "留空 = 按 caldav→email_ics→legacy 顺序自动查",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="仅查 row + 列 plan, 不写 Notion (无需 auth)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """重导出 SQLite calendar_event 行到 Notion (Phase 2.4).

    跟 ``recurring replay <internal_id>`` 区别: 老命令基于邮件 .ics 重派生
    (只对 ``source='email_ics'`` 有效); 新命令基于 SQLite ``calendar_event`` 行
    (任何 source 都可, 包括 ``caldav`` 单独走 CalDAV 拉的事件).
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if source and source not in _VALID_EVENT_SOURCES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source={source!r} not in {_VALID_EVENT_SOURCES}",
        ))

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.calendar_sync import CalendarEventRepository
    repo = CalendarEventRepository(cli.cli_config.sync_store_db_path)

    if dry_run:
        # dry-run: 只查 row 不写 Notion. 跟 replay_calendar_event 内部 try-order
        # 一致 (caldav → email_ics → legacy_calendar_app); 找不到报 NotFound.
        from src.calendar_sync._common import SOURCES_TRY_ORDER  # F30
        candidates = [source] if source else list(SOURCES_TRY_ORDER)
        row = None
        found_source = None
        for s in candidates:
            if not s:
                continue
            candidate = repo.get_by_ical_uid(
                ical_uid, source=s, recurrence_id=recurrence_id,
            )
            if candidate is not None:
                row = candidate
                found_source = s
                break
        if row is None:
            raise emit_cli_error(cli, CliNotFoundError(
                f"calendar_event not found: ical_uid={ical_uid!r} "
                f"recurrence_id={recurrence_id!r}",
                hint=f"tried sources: {candidates}; "
                     "check `mailagent calendar event-get` or run sync-now first",
            ))
        data = {
            "action": "would_replay",
            "dry_run": True,
            "ical_uid": ical_uid,
            "recurrence_id": recurrence_id,
            "source": found_source,
            "row_id": row.id,
            "summary": row.summary,
            "current_notion_page_id": row.notion_page_id,
        }
        if cli.output.lower() == "text":
            print(
                f"[dry-run] would replay: id={row.id} source={found_source} "
                f"summary={(row.summary or '')[:60]!r} "
                f"current_page_id={row.notion_page_id!r}"
            )
        else:
            emit(cli, data)
        return

    from src.calendar_notion.replay import replay_calendar_event
    from src.calendar_notion.sync import CalendarNotionSync

    notion_sync = CalendarNotionSync()
    try:
        result = asyncio.run(replay_calendar_event(
            repo, notion_sync,
            ical_uid=ical_uid, recurrence_id=recurrence_id, source=source,
        ))
    except ValueError as e:
        raise emit_cli_error(cli, CliNotFoundError(str(e)))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"replay failed: {e}",
            hint="检查 Notion token / 网络 / calendar_event row 完整性",
        ))

    data = {
        "action": result["action"],
        "page_id": result["page_id"],
        "ical_uid": result["ical_uid"],
        "recurrence_id": result["recurrence_id"],
        "source": result["source"],
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(
            f"replay {result['action']}: ical_uid={result['ical_uid']!r} "
            f"source={result['source']} page_id={result['page_id']}"
        )
    else:
        emit(cli, data)


# ============================================================
# Phase 2.1 — RSVP (接受/暂定/拒绝 iTIP REPLY)
# 通过 DavMail SMTP 把回应发回原 invite 的 organizer.
# ============================================================

_RSVP_ALIAS = {
    "accept": "ACCEPTED",
    "accepted": "ACCEPTED",
    "yes": "ACCEPTED",
    "tentative": "TENTATIVE",
    "tent": "TENTATIVE",
    "maybe": "TENTATIVE",
    "decline": "DECLINED",
    "declined": "DECLINED",
    "no": "DECLINED",
    "reject": "DECLINED",
}


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
        help=f"限定 source ∈ {_VALID_EVENT_SOURCES}; "
             "留空 = 按 caldav→email_ics→legacy 顺序自动查",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="仅查 row + 拼 plan, 不发 SMTP (无需 auth, 返回 body_preview)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """发 iTIP REPLY (接受/暂定/拒绝) 给原 invite 的 organizer (Phase 2.1).

    通过 DavMail SMTP (127.0.0.1:1025) 把 ``text/calendar; method=REPLY``
    邮件发给组织者. Outlook/Exchange Calendar Assistant 异步更新 organizer
    端 attendee 的 PARTSTAT.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    # 1. 标准化 response → PARTSTAT
    response_key = response.strip().lower()
    response_status = _RSVP_ALIAS.get(response_key)
    if response_status is None:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"response={response!r} unknown; valid: "
            f"{sorted(set(_RSVP_ALIAS.keys()))}",
        ))

    # 2. source 校验
    if source and source not in _VALID_EVENT_SOURCES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source={source!r} not in {_VALID_EVENT_SOURCES}",
        ))

    # 3. auth check (write op, dry-run 跳过)
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.calendar_sync import CalendarEventRepository
    from src.calendar_sync.rsvp import send_rsvp
    from src.config import config as global_cfg

    repo = CalendarEventRepository(cli.cli_config.sync_store_db_path)

    try:
        result = send_rsvp(
            repo, global_cfg,
            ical_uid=ical_uid,
            response_status=response_status,
            recurrence_id=recurrence_id,
            source=source,
            dry_run=dry_run,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliNotFoundError(str(e)))
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
    else:
        emit(cli, data)


# ============================================================
# Phase 2.2/2.3 — calendar event CRUD (CalDAV PUT/DELETE)
# 通过 DavMail CalDAV (1080) 在 Exchange 端 create / update / delete events.
# 跟 RSVP 不同: owner 自己改日历资源, EWS 异步通知 attendees; 跟 iTIP REPLY 是
# attendee 给 organizer 回应 PARTSTAT 两个独立路径.
# ============================================================

_VALID_EVENT_STATUS = ("CONFIRMED", "TENTATIVE", "CANCELLED")


def _parse_iso_datetime_strict(s: str, field: str) -> datetime:
    """ISO datetime with tz required; naive 拒绝. 'Z' 后缀 → '+00:00'."""
    s_clean = s.strip()
    # Python 3.11 fromisoformat 接受 'Z', 老版本要替换
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
        help="附加 attendee, 格式 'email[,name]'; 可多次传 (--attendee a@x.com --attendee 'b@y.com,Bob')",
    ),
    calendar_name: Optional[str] = typer.Option(
        None, "--calendar", help="目标 calendar 名; 留空 = 默认 (Outlook 主日历)",
    ),
    status: str = typer.Option(
        "CONFIRMED", "--status", help=f"事件状态 ∈ {_VALID_EVENT_STATUS}",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """通过 CalDAV PUT 在 Exchange 创建新事件 (Phase 2.2)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if status not in _VALID_EVENT_STATUS:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--status={status!r} not in {_VALID_EVENT_STATUS}",
        ))
    try:
        dtstart = _parse_iso_datetime_strict(start, "start")
        dtend = _parse_iso_datetime_strict(end, "end")
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)
    if dtend <= dtstart:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--end ({dtend.isoformat()}) must be > --start ({dtstart.isoformat()})",
        ))
    try:
        attendees = _parse_attendees(attendee or [])
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    from src.calendar_sync.caldav_writer import CalDAVWriter
    from src.config import config as global_cfg

    writer = CalDAVWriter(global_cfg)
    try:
        result = writer.create_event(
            summary=summary,
            dtstart_utc=dtstart,
            dtend_utc=dtend,
            location=location,
            description=description,
            attendees=attendees,
            calendar_name=calendar_name,
            status=status,
        )
    except (ValueError,) as e:
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
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """通过 CalDAV PUT update 现有事件 (Phase 2.3). 不传的字段保留原值."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if status and status not in _VALID_EVENT_STATUS:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--status={status!r} not in {_VALID_EVENT_STATUS}",
        ))

    dtstart_utc: Optional[datetime] = None
    dtend_utc: Optional[datetime] = None
    try:
        if start:
            dtstart_utc = _parse_iso_datetime_strict(start, "start")
        if end:
            dtend_utc = _parse_iso_datetime_strict(end, "end")
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)
    if dtstart_utc and dtend_utc and dtend_utc <= dtstart_utc:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--end ({dtend_utc.isoformat()}) must be > "
            f"--start ({dtstart_utc.isoformat()})",
        ))
    try:
        attendees = _parse_attendees(attendee or []) if attendee else None
    except CliInvalidArgError as e:
        raise emit_cli_error(cli, e)

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    from src.calendar_sync.caldav_writer import CalDAVWriter
    from src.config import config as global_cfg

    writer = CalDAVWriter(global_cfg)
    try:
        result = writer.update_event(
            ical_uid=ical_uid,
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            location=location,
            description=description,
            attendees=attendees,
            status=status,
            calendar_name=calendar_name,
            sequence_bump=not no_sequence_bump,
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliNotFoundError(str(e)))
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

    from src.calendar_sync.caldav_writer import CalDAVWriter
    from src.config import config as global_cfg

    writer = CalDAVWriter(global_cfg)
    try:
        result = writer.delete_event(
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
