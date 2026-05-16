"""mailagent project-progress — sync (PR-5 US-002 inline runner)."""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, is_dataclass
from typing import Any, Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.output import apply_local_output, emit, emit_cli_error
from src.project_progress.runner import ProjectProgressRunner
from src.project_progress.xlsx_parser import SheetKind

if TYPE_CHECKING:
    from src.cli.context import CliContext


app = typer.Typer(
    name="project-progress",
    help="项目周报同步外挂",
    no_args_is_help=True,
)


VALID_SHEETS = {"ongoing", "shipped", "suspended", "all"}


def _parse_sheets(raw: str) -> set[SheetKind] | None:
    """Parse --sheets into runner sheet filters.

    ``None`` means "all sheets" for ProjectProgressRunner.
    """
    value = (raw or "all").strip().lower()
    if value == "all":
        return None

    sheets: set[SheetKind] = set()
    invalid: list[str] = []
    for token in value.split(","):
        token = token.strip().lower()
        if not token:
            continue
        if token == "all":
            invalid.append(token)
            continue
        try:
            sheets.add(SheetKind(token))
        except ValueError:
            invalid.append(token)

    if invalid or not sheets:
        expected = "all or comma-separated ongoing/shipped/suspended"
        raise CliInvalidArgError(
            f"--sheets must be {expected}, got {raw!r}",
        )
    return sheets


def _serialize_sheets(sheets: set[SheetKind] | None) -> list[str] | None:
    if sheets is None:
        return None
    return sorted(sheet.value for sheet in sheets)


def _summary_to_dict(summary: Any) -> dict[str, Any]:
    if isinstance(summary, dict):
        return summary
    if is_dataclass(summary):
        return asdict(summary)
    return dict(vars(summary))


def _resolve_targets(
    *,
    runner: ProjectProgressRunner,
    internal_id: Optional[int],
    all_history: bool,
    limit: int,
    backfill_project_start: bool,
) -> tuple[list[int], str]:
    if internal_id is not None:
        return [internal_id], "internal-id"

    if all_history:
        return runner.find_all_history(limit=limit), "all-history"

    latest = runner.find_latest_pending()
    if latest is not None:
        return [latest], "latest-pending"

    if backfill_project_start:
        history = runner.find_all_history(limit=1)
        if history:
            return [history[-1]], "latest-history-backfill"

    return [], "latest-pending"


def _base_data(
    *,
    internal_id: Optional[int],
    all_history: bool,
    limit: int,
    sheets: str,
    sheets_set: set[SheetKind] | None,
    dry_run: bool,
    force: bool,
    backfill_project_start: bool,
    first_migration_dry_run: bool,
    effective_dry_run: bool,
    targets: list[int],
    target_mode: str,
    elapsed_ms: int,
) -> dict[str, Any]:
    return {
        "action": "project-progress-sync",
        "mode": "inline",
        "internal_id": internal_id,
        "all_history": all_history,
        "limit": limit,
        "sheets": sheets,
        "parsed_sheets": _serialize_sheets(sheets_set),
        "dry_run": dry_run,
        "effective_dry_run": effective_dry_run,
        "force": force,
        "backfill_project_start": backfill_project_start,
        "first_migration_dry_run": first_migration_dry_run,
        "targets": targets,
        "target_mode": target_mode,
        "duration_ms": elapsed_ms,
    }


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
) -> None:
    """同步项目周报邮件 → Notion 项目进度库."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    if internal_id is not None and all_history:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--internal-id and --all-history are mutually exclusive"
        ))

    try:
        sheets_set = _parse_sheets(sheets)
    except CliError as e:
        raise emit_cli_error(cli, e)

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

    effective_dry_run = dry_run or first_migration_dry_run
    started = time.monotonic()

    try:
        runner = ProjectProgressRunner()
        targets, target_mode = _resolve_targets(
            runner=runner,
            internal_id=internal_id,
            all_history=all_history,
            limit=limit,
            backfill_project_start=backfill_project_start,
        )

        if backfill_project_start:
            backfills = [
                asyncio.run(runner.backfill_project_start(
                    internal_id=iid,
                    dry_run=dry_run,
                ))
                for iid in targets
            ]
            summaries: list[dict[str, Any]] = []
            any_failed = any(int(item.get("failed", 0)) > 0 for item in backfills)
        else:
            summary_objects = [
                asyncio.run(runner.sync_from_email(
                    internal_id=iid,
                    force=force,
                    dry_run=effective_dry_run,
                    sheets=sheets_set,
                ))
                for iid in targets
            ]
            summaries = [_summary_to_dict(summary) for summary in summary_objects]
            backfills = []
            any_failed = any(item.get("status") == "failed" for item in summaries)
    except CliError as e:
        raise emit_cli_error(cli, e)
    except Exception as e:
        raise emit_cli_error(cli, CliError(
            f"ProjectProgressRunner unexpected error: {e!r}",
        ))

    elapsed_ms = int((time.monotonic() - started) * 1000)
    data = _base_data(
        internal_id=internal_id,
        all_history=all_history,
        limit=limit,
        sheets=sheets,
        sheets_set=sheets_set,
        dry_run=dry_run,
        force=force,
        backfill_project_start=backfill_project_start,
        first_migration_dry_run=first_migration_dry_run,
        effective_dry_run=effective_dry_run,
        targets=targets,
        target_mode=target_mode,
        elapsed_ms=elapsed_ms,
    )
    data.update({
        "status": "noop" if not targets else ("failed" if any_failed else "completed"),
        "message": "No project-progress email found" if not targets else None,
        "summaries": summaries,
        "backfills": backfills,
        "any_failed": any_failed,
    })

    if cli.output.lower() == "text":
        print(
            f"[project-progress sync] inline status={data['status']} "
            f"targets={len(targets)} ({elapsed_ms}ms)"
        )
        for item in summaries:
            print(
                f"  [{item.get('status')}] internal_id={item.get('internal_id')} "
                f"week={item.get('week_tag')} projects={item.get('projects_total')} "
                f"failed={item.get('failed')}"
            )
        for iid, item in zip(targets, backfills):
            print(f"  [backfill] internal_id={iid} {item}")
    else:
        emit(cli, data)

    if any_failed:
        raise typer.Exit(code=1)
