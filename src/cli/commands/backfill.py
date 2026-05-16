"""mailagent backfill — body / derivatives (RFC v2 §4.5 / PR-4 US-005).

首版按 PR-4 §2.4 commit 5 + 风险表批准: ``subprocess.run`` 转发参数给
``scripts/backfill_email_body.py`` / ``scripts/backfill_derivatives.py``,
PR-5 才把脚本逻辑迁进 CLI 模块.

特性:
- 长任务: 写命令默认 require_auth() + pm2_check(), ``--dry-run`` 跳过
- 退出码: subprocess 返回码透传, 自身的参数校验失败 = exit 2 (E_INVALID_ARG)
- 输出: text 直传 subprocess 输出; json 用 {status, data: {script_returncode,
  stdout_tail, mode: 'subprocess'}, meta} wrapper
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
    name="backfill",
    help="历史回填工具 (body / derivatives)",
    no_args_is_help=True,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_BODY = REPO_ROOT / "scripts" / "backfill_email_body.py"
SCRIPT_DERIVATIVES = REPO_ROOT / "scripts" / "backfill_derivatives.py"


def _run_script(
    cli: "CliContext",
    script_path: Path,
    extra_args: List[str],
    *,
    runner=None,
) -> dict:
    """subprocess 调子脚本, 返回 {script_returncode, stdout_tail, stderr_tail}."""
    run = runner or subprocess.run
    cmd = [sys.executable, str(script_path), *extra_args]
    t0 = time.monotonic()
    try:
        result = run(
            cmd, capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
    except FileNotFoundError as e:
        raise CliInvalidArgError(
            f"backfill script not found: {script_path}",
            hint=f"Check path / venv: {e}",
        )
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    stdout_tail = (result.stdout or "")[-500:]
    stderr_tail = (result.stderr or "")[-500:]
    return {
        "command": shlex.join(cmd),
        "script_returncode": result.returncode,
        "duration_ms": elapsed_ms,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "mode": "subprocess",
    }


def _common_auth_and_pm2(
    cli: "CliContext", *, dry_run: bool, allow_concurrent: bool,
) -> None:
    """thin wrapper — 把 ``auth.require_auth_and_pm2`` 的异常包成 ``emit_cli_error``."""
    from src.cli.auth import require_auth_and_pm2

    try:
        require_auth_and_pm2(
            cli, dry_run=dry_run, allow_concurrent=allow_concurrent,
        )
    except CliError as e:
        raise emit_cli_error(cli, e)


# ============================================================
# backfill body
# ============================================================


@app.command("body")
def backfill_body(
    ctx: typer.Context,
    since_date: Optional[str] = typer.Option(
        None, "--since-date", help="YYYY-MM-DD",
    ),
    until_date: Optional[str] = typer.Option(
        None, "--until-date", help="YYYY-MM-DD",
    ),
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    internal_ids: Optional[str] = typer.Option(
        None, "--internal-ids",
        help="逗号分隔的 internal_id 列表",
    ),
    all_: bool = typer.Option(
        False, "--all", help="全量回填 (与其他过滤互斥)",
    ),
    limit: Optional[int] = typer.Option(None, "--limit"),
    force: bool = typer.Option(
        False, "--force", help="覆盖已 backfilled 的邮件",
    ),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(
        20, "--max-failures", help="连续失败熔断阈值 (传递给底层脚本)",
    ),
    progress_every: int = typer.Option(10, "--progress-every"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """v4 历史邮件正文 backfill (调 scripts/backfill_email_body.py)."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    # 互斥校验: --all 与其他过滤互斥
    other_filters = any(
        x is not None for x in (since_date, until_date, mailbox, internal_ids, limit)
    )
    if all_ and other_filters:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--all is mutually exclusive with --since-date / --until-date / "
            "--mailbox / --internal-ids / --limit"
        ))
    if not all_ and not other_filters:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Provide --all or at least one filter (--since-date / --limit / etc.)"
        ))

    _common_auth_and_pm2(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    extra: List[str] = []
    if all_:
        extra.append("--all")
    if since_date:
        extra += ["--since-date", since_date]
    if until_date:
        extra += ["--until-date", until_date]
    if mailbox:
        extra += ["--mailbox", mailbox]
    if internal_ids:
        extra += ["--internal-ids", internal_ids]
    if limit is not None:
        extra += ["--limit", str(limit)]
    if force:
        extra.append("--force")
    if dry_run:
        extra.append("--dry-run")
    if max_failures is not None:
        extra += ["--max-failures", str(max_failures)]
    if progress_every is not None:
        extra += ["--progress-every", str(progress_every)]

    result_meta = _run_script(cli, SCRIPT_BODY, extra)

    data = {
        "action": "backfill-body",
        "dry_run": dry_run,
        **result_meta,
    }
    if cli.output.lower() == "text":
        # text mode: 已经把 subprocess stdout/stderr 透传到当前进程,
        # 末尾打一行总结即可
        print(
            f"[backfill body] subprocess rc={result_meta['script_returncode']} "
            f"({result_meta['duration_ms']}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if result_meta["script_returncode"] != 0:
        raise typer.Exit(code=result_meta["script_returncode"])


# ============================================================
# backfill derivatives
# ============================================================


@app.command("derivatives")
def backfill_derivatives(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Option(
        None, "--internal-id", help="仅补单封",
    ),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(20, "--max-failures"),
    progress_every: int = typer.Option(10, "--progress-every"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """v4 衍生附件 (docx→PDF / xlsx→CSV) 补齐 (调 scripts/backfill_derivatives.py)."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    _common_auth_and_pm2(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    extra: List[str] = []
    if internal_id is not None:
        extra += ["--internal-id", str(internal_id)]
    if dry_run:
        extra.append("--dry-run")
    if max_failures is not None:
        extra += ["--max-failures", str(max_failures)]
    if progress_every is not None:
        extra += ["--progress-every", str(progress_every)]

    result_meta = _run_script(cli, SCRIPT_DERIVATIVES, extra)

    data = {
        "action": "backfill-derivatives",
        "dry_run": dry_run,
        **result_meta,
    }
    if cli.output.lower() == "text":
        print(
            f"[backfill derivatives] subprocess rc={result_meta['script_returncode']} "
            f"({result_meta['duration_ms']}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if result_meta["script_returncode"] != 0:
        raise typer.Exit(code=result_meta["script_returncode"])
