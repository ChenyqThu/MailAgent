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
    CliNotImplementedError,
)
from src.cli.output import emit, emit_cli_error

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


_VALID_LEAF_OUTPUT = ("text", "json", "yaml", "ndjson")


def _apply_local_output(ctx: typer.Context, output: Optional[str]) -> None:
    if output is None or ctx.obj is None:
        return
    if output.lower() not in _VALID_LEAF_OUTPUT:
        raise typer.BadParameter(
            f"--output must be one of {_VALID_LEAF_OUTPUT}, got {output!r}",
            param_hint="-o/--output",
        )
    ctx.obj.output = output.lower()


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
    pending: list[dict] = []
    try:
        for row in sync_store.iter_series_needing_expansion(cutoff_iso):
            pending.append({
                "series_uid": row.get("series_uid"),
                "master_dtstart": row.get("master_dtstart"),
                "last_occurrence_dtstart": row.get("last_occurrence_dtstart"),
                "notion_page_id": row.get("notion_page_id"),
                "subject": row.get("subject"),
            })
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"sync_store.iter_series_needing_expansion failed: {e}",
            hint="检查 SyncStore schema (recurring_series 表是否存在)",
        ))

    data = {
        "horizon_weeks": horizon_weeks,
        "cutoff_iso": cutoff_iso,
        "pending_series": pending,
        "total_pending": len(pending),
        "dry_run": True,
    }

    if cli.output.lower() == "text":
        print(f"horizon_weeks={horizon_weeks} cutoff={cutoff_iso}")
        print(f"pending series={len(pending)}")
        for p in pending[:20]:
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

    arm = AppleScriptArm()
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

    data = {
        "matches": matches,
        "total_matches": len(matches),
        "since": since_eff,
        "discover_limit": discover_limit,
    }

    if cli.output.lower() == "text":
        print(f"matches={len(matches)} since={since_eff} limit={discover_limit}")
        for m in matches[:30]:
            print(
                f"  iid={m.get('internal_id')} uid={m.get('uid')} "
                f"rrule={(m.get('rrule') or '')[:30]} "
                f"subj={(m.get('subject') or '')[:40]}"
            )
    else:
        emit(cli, data)


# ============================================================
# recurring replay (US-007)
# ============================================================

@recurring_app.command("replay")
def calendar_recurring_replay(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Option(
        None, "--internal-id", help="单封邀请 internal_id",
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
