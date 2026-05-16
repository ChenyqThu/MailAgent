"""mailagent project-progress — sync (RFC v2 §4.7 / PR-4 US-006).

首版 subprocess wrap scripts/sync_project_progress.py 透传所有 sub-flags.
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
    name="project-progress",
    help="项目周报同步外挂",
    no_args_is_help=True,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "sync_project_progress.py"

VALID_SHEETS = {"ongoing", "shipped", "suspended", "all"}


@app.command("sync")
def project_progress_sync(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Option(
        None, "--internal-id", help="指定单封邮件",
    ),
    all_history: bool = typer.Option(False, "--all-history"),
    limit: int = typer.Option(10, "--limit", help="--all-history 时的上限"),
    sheets: str = typer.Option(
        "all", "--sheets",
        help=f"过滤 sheet: {sorted(VALID_SHEETS)}",
    ),
    dry_run: bool = typer.Option(False, "--dry-run"),
    force: bool = typer.Option(False, "--force"),
    backfill_project_start: bool = typer.Option(
        False, "--backfill-project-start",
        help="回填项目开始时间 (一次性 migration)",
    ),
    first_migration_dry_run: bool = typer.Option(
        False, "--first-migration-dry-run",
        help="迁移 dry-run, 不写 Notion 仅打印估算",
    ),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover — 测试注入用
) -> None:
    """同步项目周报邮件 → Notion 项目进度库 (调 scripts/sync_project_progress.py)."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    # 互斥校验
    if internal_id is not None and all_history:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--internal-id and --all-history are mutually exclusive"
        ))
    if sheets.lower() not in VALID_SHEETS:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--sheets must be one of {sorted(VALID_SHEETS)}, got {sheets!r}"
        ))

    # 写动作判定: 非 dry-run + 非 first-migration-dry-run 才是真写
    is_real_write = not (dry_run or first_migration_dry_run)
    if is_real_write:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        from src.cli.pm2_check import check_pm2_conflict
        try:
            check_pm2_conflict(cli, allow_concurrent=allow_concurrent)
        except CliError as e:
            raise emit_cli_error(cli, e)

    extra: List[str] = []
    if internal_id is not None:
        extra += ["--internal-id", str(internal_id)]
    if all_history:
        extra += ["--all-history", "--limit", str(limit)]
    if sheets and sheets.lower() != "all":
        extra += ["--sheets", sheets.lower()]
    if dry_run:
        extra.append("--dry-run")
    if force:
        extra.append("--force")
    if backfill_project_start:
        extra.append("--backfill-project-start")
    if first_migration_dry_run:
        extra.append("--first-migration-dry-run")

    run = runner or subprocess.run
    cmd = [sys.executable, str(SCRIPT_PATH), *extra]
    t0 = time.monotonic()
    try:
        result = run(cmd, capture_output=True, text=True, cwd=str(REPO_ROOT))
    except FileNotFoundError as exc:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"sync_project_progress.py not found: {SCRIPT_PATH}",
            hint=str(exc),
        ))
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    data = {
        "action": "project-progress-sync",
        "command": shlex.join(cmd),
        "internal_id": internal_id,
        "all_history": all_history,
        "limit": limit,
        "sheets": sheets,
        "dry_run": dry_run,
        "first_migration_dry_run": first_migration_dry_run,
        "script_returncode": result.returncode,
        "duration_ms": elapsed_ms,
        "stdout_tail": (result.stdout or "")[-500:],
        "stderr_tail": (result.stderr or "")[-500:],
        "mode": "subprocess",
    }
    if cli.output.lower() == "text":
        print(
            f"[project-progress sync] subprocess rc={result.returncode} "
            f"({elapsed_ms}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if result.returncode != 0:
        raise typer.Exit(code=result.returncode)
