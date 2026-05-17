"""mailagent init — fetch-cache / analyze / fix-* / update-parents / sync-new / all
(RFC v2 §4.9 / PR-4 US-007).
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import time
from typing import Any, Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.output import apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext


app = typer.Typer(
    name="init",
    help="初始化同步 (fetch-cache / analyze / fix-* / sync-new / all)",
    no_args_is_help=True,
)


# 仅这些 action 是写命令 (调 Notion / Mail.app), 需 auth + pm2 check
WRITE_ACTIONS = {"fix-properties", "fix-critical", "update-parents", "sync-new", "all"}


async def _close_initial_sync(sync_instance: Any) -> None:
    notion_sync = getattr(sync_instance, "notion_sync", None)
    notion_client = getattr(notion_sync, "client", None)
    close = getattr(notion_client, "close", None)
    if close is None:
        return

    result = close()
    if inspect.isawaitable(result):
        await result


async def _dispatch_action(
    sync_instance: Any,
    *,
    action: str,
    yes: bool,
    skip_fetch: bool,
    report_out: Optional[str],
    limit: Optional[int],
) -> None:
    try:
        if action == "fetch-cache":
            await sync_instance._fetch_emails_from_applescript()
        elif action == "analyze":
            await sync_instance.analyze_only(skip_fetch=skip_fetch)
            if report_out:
                sync_instance.report.save(report_out)
        elif action == "fix-properties":
            await sync_instance.fix_properties(auto_confirm=yes)
        elif action == "fix-critical":
            await sync_instance.fix_critical_mismatch(auto_confirm=yes)
        elif action == "update-parents":
            await sync_instance.update_all_parent_items(auto_confirm=yes)
        elif action == "sync-new":
            await sync_instance.sync_new_emails(limit=limit, auto_confirm=yes)
        elif action == "all":
            await sync_instance.run(auto_confirm=yes, limit=limit)
            if report_out:
                sync_instance.report.save(report_out)
        else:
            raise CliInvalidArgError(f"Unsupported init action: {action}")
    finally:
        await _close_initial_sync(sync_instance)


def _run_action_inline(
    cli: "CliContext",
    *,
    action: str,
    yes: bool = False,
    inbox_count: Optional[int] = None,
    sent_count: Optional[int] = None,
    skip_fetch: bool = False,
    input_path: Optional[str] = None,
    report_out: Optional[str] = None,
    report_in: Optional[str] = None,
    limit: Optional[int] = None,
    requires_auth: bool,
    allow_concurrent: bool,
    runner=None,
) -> dict:
    if requires_auth:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        from src.cli.pm2_check import check_pm2_conflict
        try:
            check_pm2_conflict(cli, allow_concurrent=allow_concurrent)
        except CliError as e:
            raise emit_cli_error(cli, e)

    mailbox_limits: dict[str, int] = {}
    if inbox_count is not None:
        mailbox_limits["收件箱"] = inbox_count
    if sent_count is not None:
        mailbox_limits["发件箱"] = sent_count

    InitialSyncCls = runner
    if InitialSyncCls is None:
        from src.init.initial_sync import InitialSync
        InitialSyncCls = InitialSync

    t0 = time.monotonic()
    error: Optional[str] = None
    try:
        sync_instance = InitialSyncCls(
            mailbox_limits=mailbox_limits if mailbox_limits else None,
        )

        report_path = input_path or report_in
        if report_path:
            from src.init.initial_sync import AnalysisReport
            sync_instance.report = AnalysisReport.load(report_path)

        asyncio.run(_dispatch_action(
            sync_instance,
            action=action,
            yes=yes,
            skip_fetch=skip_fetch,
            report_out=report_out,
            limit=limit,
        ))
    except Exception as exc:  # noqa: BLE001 - CLI returns structured failure JSON.
        error = f"{type(exc).__name__}: {exc}"

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    return {
        "action": f"init-{action}",
        "duration_ms": elapsed_ms,
        "mode": "inline",
        "ok": error is None,
        **({"error": error} if error else {}),
    }


def _emit_and_exit(cli: "CliContext", data: dict) -> None:
    if cli.output.lower() == "text":
        ok_marker = "ok" if data["ok"] else f"failed: {data.get('error', '?')}"
        print(f"[init {data['action']}] {ok_marker} ({data['duration_ms']}ms)", file=sys.stderr)
    else:
        emit(cli, data)
    if not data["ok"]:
        raise typer.Exit(code=1)


# ============================================================
# fetch-cache
# ============================================================


@app.command("fetch-cache")
def init_fetch_cache(
    ctx: typer.Context,
    inbox_count: Optional[int] = typer.Option(None, "--inbox-count"),
    sent_count: Optional[int] = typer.Option(None, "--sent-count"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _run_action_inline(
        cli,
        action="fetch-cache",
        inbox_count=inbox_count,
        sent_count=sent_count,
        requires_auth=False,
        allow_concurrent=allow_concurrent,
        runner=runner,
    )
    _emit_and_exit(cli, data)


# ============================================================
# analyze
# ============================================================


@app.command("analyze")
def init_analyze(
    ctx: typer.Context,
    input_: Optional[str] = typer.Option(None, "--input"),
    report_out: Optional[str] = typer.Option(None, "--report-out"),
    skip_fetch: bool = typer.Option(False, "--skip-fetch"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _run_action_inline(
        cli,
        action="analyze",
        input_path=input_,
        report_out=report_out,
        skip_fetch=skip_fetch,
        requires_auth=False,
        allow_concurrent=False,
        runner=runner,
    )
    _emit_and_exit(cli, data)


# ============================================================
# fix-properties / fix-critical / update-parents (写命令)
# ============================================================


def _fix_runner(
    cli: "CliContext",
    *,
    action: str,
    yes: bool,
    report_in: Optional[str],
    allow_concurrent: bool,
    runner,
) -> dict:
    return _run_action_inline(
        cli,
        action=action,
        yes=yes,
        report_in=report_in,
        requires_auth=True,
        allow_concurrent=allow_concurrent,
        runner=runner,
    )


@app.command("fix-properties")
def init_fix_properties(
    ctx: typer.Context,
    yes: bool = typer.Option(False, "--yes"),
    report_in: Optional[str] = typer.Option(None, "--report-in"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _fix_runner(
        cli, action="fix-properties", yes=yes, report_in=report_in,
        allow_concurrent=allow_concurrent, runner=runner,
    )
    _emit_and_exit(cli, data)


@app.command("fix-critical")
def init_fix_critical(
    ctx: typer.Context,
    yes: bool = typer.Option(False, "--yes"),
    report_in: Optional[str] = typer.Option(None, "--report-in"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _fix_runner(
        cli, action="fix-critical", yes=yes, report_in=report_in,
        allow_concurrent=allow_concurrent, runner=runner,
    )
    _emit_and_exit(cli, data)


@app.command("update-parents")
def init_update_parents(
    ctx: typer.Context,
    yes: bool = typer.Option(False, "--yes"),
    report_in: Optional[str] = typer.Option(None, "--report-in"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _fix_runner(
        cli, action="update-parents", yes=yes, report_in=report_in,
        allow_concurrent=allow_concurrent, runner=runner,
    )
    _emit_and_exit(cli, data)


# ============================================================
# sync-new
# ============================================================


@app.command("sync-new")
def init_sync_new(
    ctx: typer.Context,
    yes: bool = typer.Option(False, "--yes"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _run_action_inline(
        cli,
        action="sync-new",
        yes=yes,
        requires_auth=True,
        allow_concurrent=allow_concurrent,
        runner=runner,
    )
    _emit_and_exit(cli, data)


# ============================================================
# all (pipeline)
# ============================================================


@app.command("all")
def init_all(
    ctx: typer.Context,
    yes: bool = typer.Option(False, "--yes"),
    inbox_count: Optional[int] = typer.Option(None, "--inbox-count"),
    sent_count: Optional[int] = typer.Option(None, "--sent-count"),
    report_out: Optional[str] = typer.Option(None, "--report-out"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    data = _run_action_inline(
        cli,
        action="all",
        yes=yes,
        inbox_count=inbox_count,
        sent_count=sent_count,
        report_out=report_out,
        requires_auth=True,
        allow_concurrent=allow_concurrent,
        runner=runner,
    )
    _emit_and_exit(cli, data)
