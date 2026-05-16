"""mailagent init — fetch-cache / analyze / fix-* / update-parents / sync-new / all
(RFC v2 §4.9 / PR-4 US-007).

首版 subprocess wrap scripts/initial_sync.py --action <name>.
"""

from __future__ import annotations

import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional, TYPE_CHECKING

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


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "initial_sync.py"

# 全部 actions 对应 scripts/initial_sync.py --action 值
ACTION_MAP = {
    "fetch-cache": "fetch-cache",
    "analyze": "analyze",
    "fix-properties": "fix-properties",
    "fix-critical": "fix-critical",
    "update-parents": "update-all-parents",
    "sync-new": "sync-new",
    "all": "all",
}

# 仅这些 action 是写命令 (调 Notion / Mail.app), 需 auth + pm2 check
WRITE_ACTIONS = {"fix-properties", "fix-critical", "update-parents", "sync-new", "all"}


def _common_run(
    cli: "CliContext",
    *,
    action: str,
    extra: List[str],
    requires_auth: bool,
    allow_concurrent: bool,
    runner=None,
    dry_run: bool = False,
) -> dict:
    if requires_auth and not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        from src.cli.pm2_check import check_pm2_conflict
        try:
            check_pm2_conflict(cli, allow_concurrent=allow_concurrent)
        except CliError as e:
            raise emit_cli_error(cli, e)

    script_action = ACTION_MAP[action]
    args = [sys.executable, str(SCRIPT_PATH), "--action", script_action, *extra]
    run = runner or subprocess.run
    t0 = time.monotonic()
    try:
        result = run(args, capture_output=True, text=True, cwd=str(REPO_ROOT))
    except FileNotFoundError as exc:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"initial_sync.py not found: {SCRIPT_PATH}",
            hint=str(exc),
        ))
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    return {
        "action": f"init-{action}",
        "command": shlex.join(args),
        "script_returncode": result.returncode,
        "duration_ms": elapsed_ms,
        "stdout_tail": (result.stdout or "")[-500:],
        "stderr_tail": (result.stderr or "")[-500:],
        "mode": "subprocess",
    }


def _emit_and_exit(cli: "CliContext", data: dict) -> None:
    if cli.output.lower() == "text":
        print(
            f"[init {data['action']}] subprocess rc={data['script_returncode']} "
            f"({data['duration_ms']}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if data["script_returncode"] != 0:
        raise typer.Exit(code=data["script_returncode"])


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
    extra: List[str] = []
    if inbox_count is not None:
        extra += ["--inbox-count", str(inbox_count)]
    if sent_count is not None:
        extra += ["--sent-count", str(sent_count)]
    data = _common_run(
        cli, action="fetch-cache", extra=extra,
        requires_auth=False, allow_concurrent=allow_concurrent,
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
    extra: List[str] = []
    if input_:
        extra += ["--input", input_]
    if report_out:
        extra += ["--report-out", report_out]
    if skip_fetch:
        extra.append("--skip-fetch")
    data = _common_run(
        cli, action="analyze", extra=extra,
        requires_auth=False, allow_concurrent=False,
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
    extra: List[str] = []
    if yes:
        extra.append("--yes")
    if report_in:
        extra += ["--report-in", report_in]
    return _common_run(
        cli, action=action, extra=extra,
        requires_auth=True, allow_concurrent=allow_concurrent,
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
    extra: List[str] = ["--yes"] if yes else []
    data = _common_run(
        cli, action="sync-new", extra=extra,
        requires_auth=True, allow_concurrent=allow_concurrent,
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
    extra: List[str] = []
    if yes:
        extra.append("--yes")
    if inbox_count is not None:
        extra += ["--inbox-count", str(inbox_count)]
    if sent_count is not None:
        extra += ["--sent-count", str(sent_count)]
    if report_out:
        extra += ["--report-out", report_out]
    data = _common_run(
        cli, action="all", extra=extra,
        requires_auth=True, allow_concurrent=allow_concurrent,
        runner=runner,
    )
    _emit_and_exit(cli, data)
