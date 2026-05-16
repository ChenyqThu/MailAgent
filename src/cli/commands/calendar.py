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
    CliNotImplementedError,
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
        help="PR-3 仅 dry-run (列 series 待展开); 实跑路径推迟 (走 main.py loop)",
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
        raise emit_cli_error(cli, CliNotImplementedError(
            "calendar expand non-dry-run path not implemented in PR-3.",
            hint=(
                "PR-3 仅 dry-run 列待展开 series; 实跑由 main.py "
                "_meeting_expansion_loop 持续运行; 如需手动触发可 pm2 restart "
                "mail-sync 或等下个 tick。完整 CLI expand 实现留 PR-4."
            ),
        ))

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(weeks=horizon_weeks)
    cutoff_iso = cutoff.isoformat()

    sync_store = cli.sync_store
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


# ============================================================
# recurring discover (US-007)
# ============================================================

@recurring_app.command("discover")
def calendar_recurring_discover(
    ctx: typer.Context,
    since: Optional[str] = typer.Option(
        None, "--since", help="起始日期 YYYY-MM-DD (default SYNC_START_DATE)",
    ),
    discover_limit: int = typer.Option(
        2000, "--discover-limit",
        help="最多扫 N 个 synced 邮件 (default 2000)",
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

    since_eff = since or cli.cli_config.sync_start_date or None

    # delegate to scripts.replay_recurring_invite.discover_recurring (现成的 API)
    from scripts.replay_recurring_invite import discover_recurring
    from src.mail.applescript_arm import AppleScriptArm

    # PR-3 round-7 fix: 从 CLI cfg 显式注入 mail account / inbox (即使
    # AppleScriptArm 默认走 cfg fallback, 也明示意图)
    cfg = cli.cli_config
    arm = AppleScriptArm(
        account_name=cfg.mail_account_name,
        inbox_name=cfg.mail_inbox_name,
    )
    sync_store = cli.sync_store
    try:
        matches = asyncio.run(discover_recurring(
            sync_store, arm, since=since_eff, limit=discover_limit,
        ))
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"discover_recurring failed: {e}",
            hint="可能 AppleScript 不可用 (mac/Mail.app 缺) 或权限不足",
        ))

    # PR-3 round-7 fix (codex MAJOR 2): 用 SQL 算实际 scanned count
    # discover_recurring 内部 LIMIT discover_limit + sync_status='synced' [+ since].
    # 复现同条件在 CLI 层算 actual scanned, 而不是用 discover_limit 作近似。
    import sqlite3 as _sql

    _scanned_sql = (
        "SELECT COUNT(*) FROM (SELECT 1 FROM email_metadata "
        "WHERE sync_status = 'synced'"
    )
    _params: list = []
    if since_eff:
        _scanned_sql += " AND date_received >= ?"
        _params.append(since_eff)
    _scanned_sql += " ORDER BY date_received DESC LIMIT ?)"
    _params.append(discover_limit)
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

    # 实跑: delegate to scripts.replay_recurring_invite.replay_one
    from scripts.replay_recurring_invite import replay_one
    from src.mail.applescript_arm import AppleScriptArm
    from src.mail.meeting_sync import MeetingInviteSync

    sync_store = cli.sync_store
    arm = AppleScriptArm()
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
