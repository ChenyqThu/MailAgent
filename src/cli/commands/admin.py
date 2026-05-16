"""mailagent admin — 统计 / 健康 / db-version (RFC v2 §4.8).

US-006: stats / health / db-version (PR-2 MVP)

PR-4 范围:
- watcher / handlers / v4_rollout 真实指标 (来源 stats_reporter 持久化 SQLite stats 表)
- dead-letter list/retry, cleanup-deadletter, cleanup-syncstore, cleanup-duplicates,
  repair-parents — 写命令 (RFC §4.8 / PR-4 US-009, PR-5 inline cleanup)
"""

from __future__ import annotations

import sqlite3
import sys
import time
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from typing import List, Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliSchemaError
from src.cli.output import apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(name="admin", help="统计 / 健康 / db-version", no_args_is_help=True)


EXPECTED_DB_VERSION = 6
REQUIRED_TABLES = (
    "email_metadata",
    "email_body",
    "email_attachment",
    "email_body_fts",
    "cli_checkpoints",
    "v4_rollout_stats",
)


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
    apply_local_output(ctx, output)

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

    # PR-4 R-06: v4_rollout 真实数据 (RFC §8 选项 A).
    v4_section = _build_v4_rollout_section(cli)

    full_data = {
        "watcher": {"_source": "not_implemented_in_pr2"},
        "sync_store": sync_store_section,
        "handlers": {"_source": "not_implemented_in_pr2"},
        "v4_rollout": v4_section,
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


def _build_v4_rollout_section(cli: "CliContext") -> dict:
    """读最新 v4_rollout_stats 行 + staleness 判定 (PR-4 R-06).

    返回值:
        无数据时 ``{_source: 'no_data_yet'}``
        有数据时 含 from_sqlite_hit / fallback_miss / fallback_error /
        route_latency_p99_ms / body_miss_internal_ids / _snapshot_at /
        _staleness_seconds / _warn_stale (when > 300)
    """
    import time as _time

    try:
        store = cli.sync_store
        latest = store.get_latest_v4_rollout()
    except Exception as exc:  # pragma: no cover - DB 异常
        return {
            "_source": "error",
            "_error": f"{type(exc).__name__}: {exc}",
        }

    if latest is None:
        return {
            "_source": "no_data_yet",
            "_hint": "PM2 mail-sync 启动后约 1 min 会写第一条快照",
        }

    flushed_at = latest.get("flushed_at", 0)
    now = _time.time()
    staleness = max(0, int(now - flushed_at)) if flushed_at else None

    out = {
        "from_sqlite_hit": latest.get("from_sqlite_hit", 0),
        "fallback_miss": latest.get("fallback_miss", 0),
        "fallback_error": latest.get("fallback_error", 0),
        "route_latency_p99_ms": latest.get("route_latency_p99_ms", 0.0),
        "body_miss_internal_ids": latest.get("body_miss_internal_ids", []),
        "window_seconds": latest.get("window_seconds", 60),
        "_snapshot_at": flushed_at,
        "_staleness_seconds": staleness,
        "_source": "stats_reporter_last_snapshot",
    }
    if staleness is not None and staleness > 300:
        out["_warn_stale"] = (
            f"Last snapshot is {staleness}s old (> 300s threshold); "
            f"check if mail-sync watcher / flush loop is alive"
        )
    return out


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
    apply_local_output(ctx, output)

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
    apply_local_output(ctx, output)

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

    # R-17 / PR-2 critic fix #3: 不兼容时输出 error wrapper (E_SCHEMA_MISMATCH),
    # 不再用 status: success + compatible: false (语义矛盾)。
    if not compatible:
        raise emit_cli_error(cli, CliSchemaError(
            f"db_version={version} mismatch (expected {EXPECTED_DB_VERSION})",
            hint="Run migration to bring schema to v6; see docs/architecture_v4_sqlite_ssot.md",
            context={
                "db_path": db_path,
                "version": version,
                "expected": EXPECTED_DB_VERSION,
            },
        ))

    data = {
        "version": version,
        "expected": EXPECTED_DB_VERSION,
        "compatible": compatible,
        "db_path": db_path,
    }

    if cli.output.lower() == "text":
        print(f"{version} (expected: {EXPECTED_DB_VERSION}, compatible: yes)")
    else:
        emit(cli, data)


# ============================================================
# admin dead-letter (PR-4 US-009)
# ============================================================

dead_letter_app = typer.Typer(
    name="dead-letter", help="dead_letter 队列 list / retry",
    no_args_is_help=True,
)


@dead_letter_app.command("list")
def admin_dead_letter_list(
    ctx: typer.Context,
    limit: int = typer.Option(50, "--limit", help="最多返回 N 行 (max 500)"),
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出 sync_status='dead_letter' 的邮件 (读命令, 无 auth)."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    if limit <= 0 or limit > 500:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be in (0, 500], got {limit}"
        ))

    cfg = cli.cli_config
    db_path = cfg.sync_store_db_path
    query = (
        "SELECT internal_id, subject, sender, mailbox, retry_count, "
        "sync_error, updated_at FROM email_metadata "
        "WHERE sync_status='dead_letter'"
    )
    params: List = []
    if mailbox:
        query += " AND mailbox = ?"
        params.append(mailbox)
    query += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)

    rows: list[dict] = []
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            for r in conn.execute(query, params).fetchall():
                rows.append({
                    "internal_id": r["internal_id"],
                    "subject": r["subject"],
                    "sender": r["sender"],
                    "mailbox": r["mailbox"],
                    "retry_count": r["retry_count"],
                    "last_error": r["sync_error"],
                    "updated_at": r["updated_at"],
                })
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise emit_cli_error(cli, CliSchemaError(
            f"dead-letter list query failed: {exc}"
        ))

    if cli.output.lower() == "text":
        print(f"=== dead_letter list ({len(rows)} rows) ===")
        for r in rows:
            print(
                f"  [{r['internal_id']:>7}] retry={r['retry_count']} "
                f"{(r['subject'] or '')[:50]}  err={(r['last_error'] or '')[:40]}"
            )
    else:
        emit(cli, rows, meta_extra={"count": len(rows), "limit": limit})


@dead_letter_app.command("retry")
def admin_dead_letter_retry(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="dead_letter 邮件 internal_id"),
    allow_concurrent: bool = typer.Option(
        False, "--allow-concurrent",
        help="跳过 PM2 mail-sync 冲突检测 (写命令默认拒并行)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """把 dead_letter 邮件重置为 pending (下次 poll 重跑). 写命令, 需 auth + PM2 检测.

    PR-4 codex critic round 1: 写命令加 PM2 检测 (与 cleanup-* 一致).
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    _common_cleanup_auth(cli, dry_run=False, allow_concurrent=allow_concurrent)

    cfg = cli.cli_config
    db_path = cfg.sync_store_db_path
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            cur = conn.execute(
                "SELECT sync_status FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if cur is None:
                raise emit_cli_error(cli, CliInvalidArgError(
                    f"internal_id={internal_id} not found in email_metadata"
                ))
            old_status = cur[0]
            conn.execute(
                "UPDATE email_metadata SET sync_status='pending', "
                "retry_count=0, next_retry_at=NULL, sync_error=NULL, "
                "updated_at=? WHERE internal_id = ?",
                (time.time(), internal_id),
            )
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise emit_cli_error(cli, CliSchemaError(
            f"retry update failed: {exc}"
        ))

    data = {
        "internal_id": internal_id,
        "old_status": old_status,
        "new_status": "pending",
    }
    if cli.output.lower() == "text":
        print(f"reset {internal_id}: {old_status} → pending")
    else:
        emit(cli, data)


app.add_typer(dead_letter_app, name="dead-letter")


# ============================================================
# admin cleanup-* + repair-parents (PR-5 US-004, inline script helpers)
# ============================================================

def _common_cleanup_auth(cli: "CliContext", *, dry_run: bool, allow_concurrent: bool) -> None:
    """thin wrapper — 把 ``auth.require_auth_and_pm2`` 的异常包成 ``emit_cli_error``."""
    from src.cli.auth import require_auth_and_pm2

    try:
        require_auth_and_pm2(
            cli, dry_run=dry_run, allow_concurrent=allow_concurrent,
        )
    except CliError as e:
        raise emit_cli_error(cli, e)


def _format_inline_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"


def _call_cleanup_helper(func, *args, **kwargs) -> tuple[object, str]:
    """Run legacy cleanup helper while keeping JSON output clean."""
    buf = StringIO()
    with redirect_stdout(buf):
        result = func(*args, **kwargs)
    return result, buf.getvalue()


async def _run_repair_parents_inline(cleaner, *, dry_run: bool, thread_id: Optional[str]):
    """Use the cleanup_notion_db repair path in-process.

    Current ``scripts.cleanup_notion_db.NotionDBCleaner`` exposes parent repair via
    ``run(parent_only=True)``. If a narrower ``repair_parents`` helper is added later
    or injected by tests, prefer it so ``--thread-id`` can be passed through.
    """
    repair = getattr(cleaner, "repair_parents", None)
    if callable(repair):
        return await repair(thread_id=thread_id, dry_run=dry_run)

    if thread_id:
        # The current legacy script has no thread-id-scoped public entry point.
        # Reuse its existing steps and keep the message_id index complete so
        # parent lookup still works for the selected thread.
        if not await cleaner.init_notion():
            return False
        await cleaner.fetch_all_pages()
        cleaner.all_pages = [
            page for page in cleaner.all_pages
            if page.get("thread_id") == thread_id
        ]
        await cleaner.step2_set_parent(dry_run)
        return True

    return await cleaner.run(dry_run=dry_run, parent_only=True)


@app.command("cleanup-deadletter")
def admin_cleanup_deadletter(
    ctx: typer.Context,
    older_than: int = typer.Option(
        30, "--older-than", help="清理超过 N 天的 dead_letter (默认 30)",
    ),
    yes: bool = typer.Option(False, "--yes"),
    dry_run: bool = typer.Option(True, "--dry-run/--no-dry-run"),
    allow_concurrent: bool = typer.Option(
        False, "--allow-concurrent",
        help="跳过 PM2 mail-sync 冲突检测 (写命令默认拒并行)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """清理 dead_letter 超过 N 天的记录 (内置实现, 不 subprocess).

    PR-4 codex critic round 1: 加 PM2 检测 + --allow-concurrent (写命令安全规范).
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    real_write = not dry_run
    if real_write and not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Non-dry-run cleanup requires --yes (refusing to silently delete)",
            hint="--no-dry-run --yes",
        ))
    if real_write:
        _common_cleanup_auth(cli, dry_run=False, allow_concurrent=allow_concurrent)

    cutoff = time.time() - (older_than * 86400)
    db_path = cli.cli_config.sync_store_db_path
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            cur = conn.execute(
                "SELECT COUNT(*) FROM email_metadata "
                "WHERE sync_status='dead_letter' AND updated_at < ?",
                (cutoff,),
            ).fetchone()
            candidates = int(cur[0])
            deleted = 0
            if real_write and candidates > 0:
                conn.execute(
                    "DELETE FROM email_metadata "
                    "WHERE sync_status='dead_letter' AND updated_at < ?",
                    (cutoff,),
                )
                deleted = candidates
                conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise emit_cli_error(cli, CliSchemaError(
            f"cleanup-deadletter failed: {exc}"
        ))

    data = {
        "action": "cleanup-deadletter",
        "older_than_days": older_than,
        "candidates": candidates,
        "deleted": deleted,
        "dry_run": dry_run,
        "mode": "inline",
        "ok": True,
    }
    if cli.output.lower() == "text":
        print(
            f"cleanup-deadletter: {candidates} candidates, "
            f"{'would delete' if dry_run else 'deleted'} {deleted if not dry_run else candidates}"
        )
    else:
        emit(cli, data)


@app.command("cleanup-syncstore")
def admin_cleanup_syncstore(
    ctx: typer.Context,
    dry_run: bool = typer.Option(True, "--dry-run/--no-dry-run"),
    yes: bool = typer.Option(False, "--yes"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    """扫 SyncStore 状态。

    默认 dry-run 仅显示统计；``--no-dry-run --yes`` 会把非 pending 状态重置为 pending。
    """
    from scripts.cleanup_syncstore import reset_sync_status, show_stats
    from src.mail.sync_store import SyncStore

    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    if not dry_run and not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Non-dry-run cleanup requires --yes"
        ))
    _common_cleanup_auth(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    store_cls = runner or SyncStore
    store = store_cls(cli.cli_config.sync_store_db_path)
    t0 = time.monotonic()
    error = None
    stdout = ""
    try:
        if dry_run:
            _, stdout = _call_cleanup_helper(show_stats, store)
        else:
            _, stdout = _call_cleanup_helper(
                reset_sync_status, store, mailbox=None, auto_confirm=True,
            )
    except Exception as exc:
        error = _format_inline_error(exc)
    duration_ms = int((time.monotonic() - t0) * 1000)

    data = {
        "action": "cleanup-syncstore",
        "dry_run": dry_run,
        "mode": "inline",
        "duration_ms": duration_ms,
        "ok": error is None,
    }
    if stdout:
        data["stdout_tail"] = stdout[-500:]
    if error:
        data["error"] = error
    if cli.output.lower() == "text":
        marker = "ok" if data["ok"] else f"failed: {error}"
        print(
            f"[cleanup-syncstore] {marker} ({duration_ms}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if not data["ok"]:
        raise typer.Exit(code=1)


@app.command("cleanup-duplicates")
def admin_cleanup_duplicates(
    ctx: typer.Context,
    dry_run: bool = typer.Option(True, "--dry-run/--no-dry-run"),
    yes: bool = typer.Option(False, "--yes"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    """扫 Notion 中 Message ID 重复的邮件页，默认 dry-run 只统计。"""
    import asyncio
    from collections import defaultdict

    from notion_client import AsyncClient

    from scripts.cleanup_duplicate_message_ids import (
        archive_page,
        extract_page_info,
        get_all_pages,
    )
    from src.config import config

    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    if not dry_run and not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Non-dry-run cleanup requires --yes"
        ))
    _common_cleanup_auth(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    async def _scan_and_clean() -> dict:
        client = AsyncClient(auth=config.notion_token)
        pages = await get_all_pages(client, config.email_database_id)
        message_id_map = defaultdict(list)
        for page in pages:
            info = extract_page_info(page)
            message_id = info.get("message_id")
            if message_id:
                message_id_map[message_id].append(info)

        duplicates = {
            message_id: entries
            for message_id, entries in message_id_map.items()
            if len(entries) > 1
        }
        archived = []
        failed = []
        if not dry_run:
            for entries in duplicates.values():
                sorted_entries = sorted(entries, key=lambda item: item["created_time"])
                for entry in sorted_entries[1:]:
                    ok = await archive_page(client, entry["page_id"])
                    (archived if ok else failed).append(entry["page_id"])
                    await asyncio.sleep(0.3)

        return {
            "duplicate_message_ids": len(duplicates),
            "duplicate_pages": sum(len(entries) - 1 for entries in duplicates.values()),
            "archived": archived,
            "failed": failed,
        }

    t0 = time.monotonic()
    error = None
    result = None
    try:
        result = asyncio.run(runner() if runner else _scan_and_clean())
    except Exception as exc:
        error = _format_inline_error(exc)
    duration_ms = int((time.monotonic() - t0) * 1000)

    data = {
        "action": "cleanup-duplicates",
        "dry_run": dry_run,
        "mode": "inline",
        "duration_ms": duration_ms,
        "ok": error is None,
    }
    if result:
        data.update(result)
    if error:
        data["error"] = error
    if cli.output.lower() == "text":
        marker = "ok" if data["ok"] else f"failed: {error}"
        print(
            f"[cleanup-duplicates] {marker} ({duration_ms}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if not data["ok"]:
        raise typer.Exit(code=1)


@app.command("repair-parents")
def admin_repair_parents(
    ctx: typer.Context,
    dry_run: bool = typer.Option(True, "--dry-run/--no-dry-run"),
    thread_id: Optional[str] = typer.Option(None, "--thread-id"),
    yes: bool = typer.Option(False, "--yes"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    runner=None,  # pragma: no cover
) -> None:
    """修复 Notion Parent Item 断链关系，默认 dry-run 只预览。"""
    import asyncio

    from scripts.cleanup_notion_db import NotionDBCleaner

    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    if not dry_run and not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Non-dry-run repair-parents requires --yes"
        ))
    _common_cleanup_auth(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    cleaner_cls = runner or NotionDBCleaner
    t0 = time.monotonic()
    error = None
    summary = None
    stdout = ""
    try:
        cleaner = cleaner_cls()
        buf = StringIO()
        with redirect_stdout(buf):
            result = asyncio.run(
                _run_repair_parents_inline(
                    cleaner, dry_run=dry_run, thread_id=thread_id,
                )
            )
        stdout = buf.getvalue()
        summary = {
            "result": result,
            "stats": getattr(cleaner, "stats", None),
        }
        if result is False:
            error = "NotionDBCleaner returned False"
    except Exception as exc:
        error = _format_inline_error(exc)
    duration_ms = int((time.monotonic() - t0) * 1000)

    data = {
        "action": "repair-parents", "dry_run": dry_run, "thread_id": thread_id,
        "mode": "inline",
        "duration_ms": duration_ms,
        "ok": error is None,
    }
    if summary:
        data["summary"] = summary
    if stdout:
        data["stdout_tail"] = stdout[-500:]
    if error:
        data["error"] = error
    if cli.output.lower() == "text":
        marker = "ok" if data["ok"] else f"failed: {error}"
        print(
            f"[repair-parents] {marker} ({duration_ms}ms)",
            file=sys.stderr,
        )
    else:
        emit(cli, data)
    if not data["ok"]:
        raise typer.Exit(code=1)
