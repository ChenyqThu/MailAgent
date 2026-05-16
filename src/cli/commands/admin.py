"""mailagent admin — 统计 / 健康 / db-version (RFC v2 §4.8).

US-006: stats / health / db-version (PR-2 MVP)

PR-4 范围: watcher / handlers / v4_rollout 真实指标 (来源 stats_reporter 持久化 SQLite stats 表)。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliSchemaError
from src.cli.output import emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(name="admin", help="统计 / 健康 / db-version", no_args_is_help=True)


EXPECTED_DB_VERSION = 5
REQUIRED_TABLES = (
    "email_metadata",
    "email_body",
    "email_attachment",
    "email_body_fts",
)


def _apply_local_output(ctx: typer.Context, output: Optional[str]) -> None:
    if output is not None and ctx.obj is not None:
        ctx.obj.output = output


# ============================================================
# stats (US-006)
# ============================================================

@app.command("stats")
def admin_stats(
    ctx: typer.Context,
    section: Optional[str] = typer.Option(
        None, "--section",
        help="watcher / sync_store / handlers / v4_rollout / all",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """汇总服务运行状态 — PR-2 MVP: 仅 sync_store live_query 段填充, 其余 not_implemented_in_pr2."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    ss_stats = cli.sync_store.get_stats()

    sync_store_section = {
        "total_emails": ss_stats.get("total_emails", 0),
        "by_status": ss_stats.get("by_status", {}),
        "by_mailbox": ss_stats.get("by_mailbox", {}),
        "failure_queue": ss_stats.get("failure_queue", 0),
        "last_max_row_id": ss_stats.get("last_max_row_id"),
        "last_sync_time": ss_stats.get("last_sync_time"),
        "db_size_mb": ss_stats.get("db_size_mb", 0),
        "db_size_bytes": ss_stats.get("db_size_bytes", 0),
        "_source": "live_query",
    }

    full_data = {
        "watcher": {"_source": "not_implemented_in_pr2"},
        "sync_store": sync_store_section,
        "handlers": {"_source": "not_implemented_in_pr2"},
        "v4_rollout": {"_source": "not_implemented_in_pr2"},
    }

    if section and section.lower() != "all":
        sec = section.lower()
        if sec not in full_data:
            raise emit_cli_error(cli, CliError(
                f"Unknown --section {section!r}; valid: {list(full_data.keys())} + 'all'"
            ))
        data: dict = {sec: full_data[sec]}
    else:
        data = full_data

    if cli.output.lower() == "text":
        _render_stats_text(data)
    else:
        emit(cli, data)


def _render_stats_text(data: dict) -> None:
    for sec_name, sec_data in data.items():
        print(f"== {sec_name} ==")
        if sec_data.get("_source") == "not_implemented_in_pr2":
            print("  (not implemented in PR-2 — PR-4 R-06 范围)")
            continue
        for key, value in sec_data.items():
            if key.startswith("_"):
                print(f"  {key:24}{value}")
            elif isinstance(value, dict):
                print(f"  {key}:")
                for sub_k, sub_v in value.items():
                    print(f"    {sub_k:22}{sub_v}")
            else:
                print(f"  {key:24}{value}")


# ============================================================
# health (US-006)
# ============================================================

@app.command("health")
def admin_health(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """SQLite 连通性 + db_version + 必备表存在性检查."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    cfg = cli.cli_config
    db_path = cfg.sync_store_db_path
    db_accessible = False
    db_version: Optional[int] = None
    tables_present: list[str] = []
    error_message: Optional[str] = None

    try:
        if not Path(db_path).exists():
            raise FileNotFoundError(db_path)
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            db_accessible = True
            cursor = conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            )
            row = cursor.fetchone()
            if row:
                try:
                    db_version = int(row[0])
                except (TypeError, ValueError):
                    db_version = None
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            )
            tables_present = [r[0] for r in cursor.fetchall()]
        finally:
            conn.close()
    except Exception as exc:
        error_message = f"{type(exc).__name__}: {exc}"

    missing = [t for t in REQUIRED_TABLES if t not in tables_present]
    schema_ok = (
        db_accessible
        and db_version == EXPECTED_DB_VERSION
        and not missing
    )
    healthy = schema_ok

    data = {
        "db_path": db_path,
        "db_accessible": db_accessible,
        "db_version": db_version,
        "db_version_expected": EXPECTED_DB_VERSION,
        "schema_ok": schema_ok,
        "tables_present": tables_present,
        "tables_missing": missing,
        "healthy": healthy,
    }
    if error_message:
        data["error"] = error_message

    if cli.output.lower() == "text":
        print(f"db_path        {db_path}")
        print(f"db_accessible  {db_accessible}")
        print(f"db_version     {db_version} (expected: {EXPECTED_DB_VERSION})")
        print(f"schema_ok      {schema_ok}")
        if missing:
            print(f"tables_missing {missing}")
        if error_message:
            print(f"error          {error_message}")
        print(f"healthy        {healthy}")
    else:
        emit(cli, data)

    if not healthy:
        raise typer.Exit(code=1)


# ============================================================
# db-version (US-006)
# ============================================================

@app.command("db-version")
def admin_db_version(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """打印 sync_store.db 当前 db_version."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    cfg = cli.cli_config
    db_path = cfg.sync_store_db_path

    version: Optional[int] = None
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()
            if row:
                version = int(row[0])
        finally:
            conn.close()
    except Exception as exc:
        raise emit_cli_error(cli, CliSchemaError(
            f"Failed to read db_version from {db_path}: {exc}"
        ))

    compatible = version == EXPECTED_DB_VERSION
    data = {
        "version": version,
        "expected": EXPECTED_DB_VERSION,
        "compatible": compatible,
        "db_path": db_path,
    }

    if cli.output.lower() == "text":
        compat_word = "yes" if compatible else "no"
        print(f"{version} (expected: {EXPECTED_DB_VERSION}, compatible: {compat_word})")
    else:
        emit(cli, data)

    if not compatible:
        raise typer.Exit(code=5)
