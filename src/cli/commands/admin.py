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

from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliNotFoundError,
    CliSchemaError,
)
from src.cli.output import apply_local_output, emit, emit_cli_error
# 跟 SyncStore.DB_VERSION 同步避免漂移 (Sprint 16 v13: dual-backend 加 imap_uid/
# imap_uidvalidity/backend_origin 三列). 导入而非硬编码, 后续 ALTER TABLE 升版本时不会漏改 CLI 端.
from src.mail.sync_store import SyncStore as _SyncStore

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(name="admin", help="统计 / 健康 / db-version", no_args_is_help=True)


EXPECTED_DB_VERSION = _SyncStore.DB_VERSION
REQUIRED_TABLES = (
    "email_metadata",
    "email_body",
    "email_attachment",
    "email_body_fts",
    "cli_checkpoints",
    "v4_rollout_stats",
    "island_dispatch",  # v7: ping-island Sprint 2 派发审计
    "email_outbox",     # v10: SQLite SSoT inversion (Sprint 15)
)


# ============================================================
# stats (US-006)
# ============================================================

@app.command("stats")
def admin_stats(
    ctx: typer.Context,
    section: Optional[str] = typer.Option(
        None, "--section",
        help="watcher / sync_store / handlers / v4_rollout / outbox / all",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """汇总服务运行状态 — PR-2 MVP: 仅 sync_store live_query 段填充, 其余 not_implemented_in_pr2.

    Sprint 15 Stage 4 加 outbox section: OutboxRepository.get_stats() 反查
    by_status / by_target / age_buckets / total。
    """
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

    # Sprint 15: outbox 队列分布
    outbox_section = _build_outbox_section(cli)

    full_data = {
        "watcher": {"_source": "not_implemented_in_pr2"},
        "sync_store": sync_store_section,
        "handlers": {"_source": "not_implemented_in_pr2"},
        "v4_rollout": v4_section,
        "outbox": outbox_section,
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
    outbox_backlog = 0

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
            # outbox 积压 (未派发完成的写 intent)。派发器关闭 + 积压 > 0 =
            # 配置缺陷 (写操作静默永不同步), 下方暴露 outbox_warning。
            if "email_outbox" in tables_present:
                row = conn.execute(
                    "SELECT COUNT(*) FROM email_outbox "
                    "WHERE status IN ('pending', 'processing', 'failed')"
                ).fetchone()
                outbox_backlog = int(row[0]) if row else 0
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

    outbox_enabled = bool(cfg.mailagent_outbox_enabled)
    outbox_warning: Optional[str] = None
    if not outbox_enabled and outbox_backlog > 0:
        outbox_warning = (
            f"派发器关闭 (MAILAGENT_OUTBOX_ENABLED=false) 但 email_outbox 积压 "
            f"{outbox_backlog} 条 — 旗标/已读/完成等写操作不会同步到 Mail 后端与 "
            f"Notion; 设 MAILAGENT_OUTBOX_ENABLED=true 后重启"
        )

    data = {
        "db_path": db_path,
        "db_accessible": db_accessible,
        "db_version": db_version,
        "db_version_expected": EXPECTED_DB_VERSION,
        "schema_ok": schema_ok,
        "tables_present": tables_present,
        "tables_missing": missing,
        "outbox_dispatch_enabled": outbox_enabled,
        "outbox_backlog": outbox_backlog,
        "healthy": healthy,
    }
    if outbox_warning:
        data["outbox_warning"] = outbox_warning
    if error_message:
        data["error"] = error_message

    if cli.output.lower() == "text":
        print(f"db_path        {db_path}")
        print(f"db_accessible  {db_accessible}")
        print(f"db_version     {db_version} (expected: {EXPECTED_DB_VERSION})")
        print(f"schema_ok      {schema_ok}")
        if missing:
            print(f"tables_missing {missing}")
        print(f"outbox_dispatch_enabled {outbox_enabled}")
        print(f"outbox_backlog {outbox_backlog}")
        if outbox_warning:
            print(f"outbox_warning {outbox_warning}")
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
            hint=(
                f"Run migration to bring schema to v{EXPECTED_DB_VERSION}; "
                "restart mail-sync to trigger SyncStore._init_database() auto-migrate. "
                "See docs/architecture_v4_sqlite_ssot.md + SPRINT15-HANDOFF.md."
            ),
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
    from src.cleanup.syncstore import reset_sync_status, show_stats
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

    from src.cleanup.duplicate_message_ids import (
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

    from src.cleanup.notion_db import NotionDBCleaner

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


# ============================================================
# Sprint 15 Stage 3: admin config show / get / set
# ============================================================
#
# 让前端 / agent / 看板能 typed-access 所有 .env 配置；前端「设置」页直接走
# `admin config show` / `set` 不用手工编辑 .env。
#
# 敏感字段自动脱敏（name 含 token/secret/password/api_key），`--show-secrets`
# 显示原值（需要 auth, 即使是 show / get 命令）。`set` 是写命令, 全场要 auth。
#
# 详 SPRINT15-HANDOFF.md scope 决策 #3: 写 .env 文件持久化, restart 生效
# (不做运行时 hot-reload)。

config_app = typer.Typer(
    name="config",
    help="读 / 写 .env 配置 (Sprint 15)",
    no_args_is_help=True,
)

# 字段名包含这几个 suffix 自动 mask 输出 (不区分大小写)
SENSITIVE_FIELD_PARTS = ("token", "secret", "password", "api_key")


def _is_sensitive(field_name: str) -> bool:
    n = field_name.lower()
    return any(part in n for part in SENSITIVE_FIELD_PARTS)


def _mask_value(value) -> str:
    if value is None or value == "":
        return "<unset>"
    s = str(value)
    if len(s) <= 6:
        return "***"
    return f"***{s[-4:]}"


def _collect_settings(cli, *, show_secrets: bool) -> dict:
    """反射 cli.cli_config 拿所有字段值. 敏感字段按 flag 决定 mask."""
    cfg = cli.cli_config
    fields_info = cfg.model_fields
    out: dict[str, dict] = {}
    for name, field_info in fields_info.items():
        try:
            value = getattr(cfg, name)
        except Exception:
            value = None
        env_var = (field_info.alias or name).upper()
        if _is_sensitive(name) and not show_secrets:
            display_value = _mask_value(value)
        else:
            display_value = value
        out[name] = {
            "env_var": env_var,
            "value": display_value,
            "default": field_info.default,
            "description": field_info.description or "",
            "sensitive": _is_sensitive(name),
        }
    return out


def _coerce_value(value: str, annotation):
    """字符串 → annotation 类型 (bool / int / float / str / Optional[T])."""
    import typing as _typing

    origin = _typing.get_origin(annotation)
    if origin is _typing.Union:
        args = [a for a in _typing.get_args(annotation) if a is not type(None)]
        if args:
            annotation = args[0]

    if annotation is bool:
        v = value.strip().lower()
        if v in ("true", "1", "yes", "on"):
            return True
        if v in ("false", "0", "no", "off", ""):
            return False
        raise ValueError(f"cannot coerce {value!r} to bool")
    if annotation is int:
        return int(value)
    if annotation is float:
        return float(value)
    return str(value)


def _resolve_env_file(cli) -> Path:
    """找 .env 文件实际路径. config_path > MAILAGENT_CONFIG env > 项目根 .env."""
    import os

    config_path = (
        getattr(cli, "config_path", None)
        or os.environ.get("MAILAGENT_CONFIG")
        or ".env"
    )
    return Path(config_path).resolve()


@config_app.command("show")
def admin_config_show(
    ctx: typer.Context,
    key: Optional[str] = typer.Option(None, "--key", help="只显示指定字段"),
    show_secrets: bool = typer.Option(
        False, "--show-secrets",
        help="显示敏感字段原值 (token / secret / password / api_key; 需 auth)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出所有 Settings 字段 + 当前值. 敏感字段默认脱敏 (***last4)."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    if show_secrets:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    all_settings = _collect_settings(cli, show_secrets=show_secrets)

    if key:
        if key not in all_settings:
            raise emit_cli_error(cli, CliNotFoundError(
                f"Unknown config key: {key!r}",
                hint="Run `mailagent admin config show` to list all valid keys.",
            ))
        emit(cli, {"key": key, **all_settings[key]})
    else:
        emit(cli, {"settings": all_settings, "count": len(all_settings)})


@config_app.command("get")
def admin_config_get(
    ctx: typer.Context,
    key: str = typer.Argument(..., help="配置字段名 (Pydantic field name)"),
    show_secrets: bool = typer.Option(
        False, "--show-secrets", help="显示敏感字段原值 (需 auth)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """读单个配置字段."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    if show_secrets:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    all_settings = _collect_settings(cli, show_secrets=show_secrets)
    if key not in all_settings:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Unknown config key: {key!r}",
            hint="Run `mailagent admin config show` to list all valid keys.",
        ))
    emit(cli, {"key": key, **all_settings[key]})


@config_app.command("set")
def admin_config_set(
    ctx: typer.Context,
    key: str = typer.Argument(..., help="配置字段名 (Pydantic field name)"),
    value: str = typer.Argument(..., help="新值 (字符串; bool / int / float 自动 coerce)"),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="只显示 diff, 不实际写 .env; 跳过 auth",
    ),
    yes: bool = typer.Option(
        False, "--yes", help="跳过 diff 确认 (CLI 当前无交互, 该 flag 为 future-proof)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """写 .env 文件持久化配置. set 后需 `pm2 restart mail-sync` 才能让运行时生效.

    流程: 字段名校验 → 类型 coerce → diff → auth → atomic .env write (python-dotenv).
    Atomic guarantee 来自 dotenv set_key 的 tmp + replace 模式。保留注释 / 空行 / 段落。

    敏感字段（token / secret / password / api_key）的 old_value / new_value 在
    返回 envelope 中 mask, 避免 log 落盘泄漏 (text mode 也走 mask)。
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    cfg = cli.cli_config
    fields_info = cfg.model_fields
    if key not in fields_info:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Unknown config key: {key!r}",
            hint="Run `mailagent admin config show` to list all valid keys.",
        ))

    field_info = fields_info[key]
    env_var = (field_info.alias or key).upper()

    # 类型 coerce + validate
    try:
        coerced = _coerce_value(value, field_info.annotation)
    except (ValueError, TypeError) as exc:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"Type validation failed for {key}: {exc}",
            hint=(
                f"Field {key} expects type {field_info.annotation}; "
                "for bool use true/false/yes/no/on/off."
            ),
        ))

    old_value = getattr(cfg, key, None)
    sensitive = _is_sensitive(key)

    diff = {
        "key": key,
        "env_var": env_var,
        "old_value": _mask_value(old_value) if sensitive else old_value,
        "new_value": _mask_value(coerced) if sensitive else coerced,
        "sensitive": sensitive,
    }

    if dry_run:
        emit(cli, {"dry_run": True, **diff})
        return

    # 写命令 auth (dry-run 跳过)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    # 找 .env 文件 + atomic write
    env_file = _resolve_env_file(cli)
    if not env_file.exists():
        env_file.touch()  # python-dotenv set_key 要求文件存在

    try:
        from dotenv import set_key as _dotenv_set_key
        # dotenv 把所有值都序列化成 str; bool True → "True" 是 pydantic 能 parse 的
        _dotenv_set_key(str(env_file), env_var, str(coerced), quote_mode="auto")
    except Exception as exc:
        raise emit_cli_error(cli, CliInvalidArgError(
            f".env write failed: {exc}",
        ))

    emit(cli, {
        "dry_run": False,
        **diff,
        "env_file": str(env_file),
        "restart_required": True,
    })


# 挂到 admin app
app.add_typer(config_app, name="config")


# ============================================================
# Sprint 15 Stage 4: 管理面补全
# ============================================================
#
# 新增 3 个独立命令 + admin stats --section outbox 扩展, 让前端 Dashboard 拿到
# 综合状态视图, 不再让 SQL 散落到 CLAUDE.md。
#
# - admin fts-health   FTS5 索引完整性 (body vs fts 行数 gap + integrity)
# - admin pm2-status   PM2 mail-sync 进程状态（前端避免与主进程冲突时用）
# - admin queue-depth  综合队列: sync_store / outbox / llm_processing


def _build_outbox_section(cli: "CliContext") -> dict:
    """OutboxRepository.get_stats() → admin stats outbox section."""
    try:
        from src.sync.outbox import OutboxRepository
        cfg = cli.cli_config
        repo = OutboxRepository(cfg.sync_store_db_path)
        stats = repo.get_stats()
        return {
            "_source": "live_query",
            "total": stats.total,
            "by_status": stats.by_status,
            "by_target": stats.by_target,
            "age_buckets": stats.age_buckets,
        }
    except Exception as exc:
        return {
            "_source": "error",
            "_error": f"{type(exc).__name__}: {exc}",
        }


@app.command("fts-health")
def admin_fts_health(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """FTS5 索引健康度: email_body vs email_body_fts 行数对比 + integrity_check.

    返回:
      body_rows / fts_rows / gap (>0 表示 reindex 落后) /
      integrity_check ('ok' or error msg) / fts_size_bytes (近似).
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    cfg = cli.cli_config
    db_path = cfg.sync_store_db_path
    data: dict = {}
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            body_rows = conn.execute("SELECT COUNT(*) FROM email_body").fetchone()[0]
            fts_rows = conn.execute("SELECT COUNT(*) FROM email_body_fts").fetchone()[0]
            data["body_rows"] = int(body_rows)
            data["fts_rows"] = int(fts_rows)
            data["gap"] = int(body_rows) - int(fts_rows)

            # FTS5 integrity-check
            try:
                conn.execute(
                    "INSERT INTO email_body_fts(email_body_fts) VALUES('integrity-check')"
                )
                data["integrity_check"] = "ok"
            except sqlite3.OperationalError as exc:
                data["integrity_check"] = str(exc)[:200]

            # 文件大小 (粗略, fts 与 main DB 共享文件)
            try:
                data["fts_size_bytes"] = Path(db_path).stat().st_size
            except OSError:
                data["fts_size_bytes"] = None
        finally:
            conn.close()
    except Exception as exc:
        raise emit_cli_error(cli, CliError(
            f"fts-health failed: {type(exc).__name__}: {exc}",
        ))

    data["healthy"] = data["gap"] == 0 and data["integrity_check"] == "ok"

    if cli.output.lower() == "text":
        print(f"body_rows         {data['body_rows']}")
        print(f"fts_rows          {data['fts_rows']}")
        print(f"gap               {data['gap']}")
        print(f"integrity_check   {data['integrity_check']}")
        print(f"healthy           {data['healthy']}")
    else:
        emit(cli, data)


@app.command("pm2-status")
def admin_pm2_status(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """PM2 mail-sync 主进程状态. 前端避免与主进程并发冲突时用.

    返回:
      pm2_available (CLI 是否安装) /
      mail_sync (online/pid/uptime_sec/memory_mb/cpu_percent/restart_count) | null
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    import json as _json
    import subprocess as _subprocess
    import time as _time

    data: dict = {
        "pm2_available": False,
        "mail_sync": None,
        "checked_at": _time.time(),
    }
    try:
        result = _subprocess.run(
            ["pm2", "jlist"],
            capture_output=True, text=True, timeout=5.0,
        )
        data["pm2_available"] = result.returncode == 0
        if result.returncode != 0:
            data["error"] = f"pm2 jlist exit {result.returncode}: {result.stderr[:200]}"
        else:
            try:
                procs = _json.loads(result.stdout or "[]")
            except _json.JSONDecodeError:
                data["error"] = "pm2 jlist output not JSON"
                procs = []
            for proc in procs:
                if not isinstance(proc, dict):
                    continue
                if proc.get("name") != "mail-sync":
                    continue
                env = proc.get("pm2_env") or {}
                monit = proc.get("monit") or {}
                uptime_sec = None
                if env.get("pm_uptime"):
                    uptime_sec = max(
                        0,
                        int(_time.time() - env["pm_uptime"] / 1000),
                    )
                data["mail_sync"] = {
                    "name": proc.get("name"),
                    "pid": proc.get("pid"),
                    "online": env.get("status") == "online",
                    "status": env.get("status"),
                    "uptime_sec": uptime_sec,
                    "memory_mb": (
                        round(monit.get("memory", 0) / 1024 / 1024, 2)
                        if monit.get("memory") else None
                    ),
                    "cpu_percent": monit.get("cpu"),
                    "restart_count": env.get("restart_time"),
                }
                break
    except FileNotFoundError:
        data["pm2_available"] = False
        data["error"] = "pm2 CLI not installed"
    except _subprocess.TimeoutExpired:
        data["pm2_available"] = False
        data["error"] = "pm2 jlist timeout (>5s)"
    except Exception as exc:
        data["pm2_available"] = False
        data["error"] = f"{type(exc).__name__}: {exc}"

    if cli.output.lower() == "text":
        print(f"pm2_available     {data['pm2_available']}")
        if data["mail_sync"]:
            ms = data["mail_sync"]
            print(f"mail-sync         {ms['status']} pid={ms['pid']} uptime={ms['uptime_sec']}s")
            print(f"  memory_mb       {ms['memory_mb']}")
            print(f"  cpu_percent     {ms['cpu_percent']}")
            print(f"  restart_count   {ms['restart_count']}")
        else:
            print("mail-sync         (not running)")
        if "error" in data:
            print(f"error             {data['error']}")
    else:
        emit(cli, data)


@app.command("queue-depth")
def admin_queue_depth(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """综合队列视图. 前端 Dashboard 一次拉所有 backlog 看一眼就清楚.

    返回:
      sync_store: {pending, fetch_failed, failed, dead_letter}
      outbox:     {pending, processing, failed, dead_letter}
      llm_processing: {pending, failed, gave_up}
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)

    cfg = cli.cli_config
    data: dict = {}

    # sync_store
    try:
        ss_stats = cli.sync_store.get_stats()
        by_status = ss_stats.get("by_status", {}) or {}
        data["sync_store"] = {
            "pending": int(by_status.get("pending", 0)),
            "fetch_failed": int(by_status.get("fetch_failed", 0)),
            "failed": int(by_status.get("failed", 0)),
            "dead_letter": int(by_status.get("dead_letter", 0)),
            "synced": int(by_status.get("synced", 0)),
            "skipped": int(by_status.get("skipped", 0)),
        }
    except Exception as exc:
        data["sync_store"] = {"_error": f"{type(exc).__name__}: {exc}"}

    # outbox
    try:
        from src.sync.outbox import OutboxRepository
        repo = OutboxRepository(cfg.sync_store_db_path)
        outbox_stats = repo.get_stats()
        data["outbox"] = {
            "pending": outbox_stats.by_status.get("pending", 0),
            "processing": outbox_stats.by_status.get("processing", 0),
            "failed": outbox_stats.by_status.get("failed", 0),
            "dead_letter": outbox_stats.by_status.get("dead_letter", 0),
            "done": outbox_stats.by_status.get("done", 0),
            "total": outbox_stats.total,
        }
    except Exception as exc:
        data["outbox"] = {"_error": f"{type(exc).__name__}: {exc}"}

    # llm_processing
    try:
        conn = sqlite3.connect(cfg.sync_store_db_path, timeout=5.0)
        try:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_processing'"
            )
            has_table = cursor.fetchone() is not None
            if has_table:
                rows = conn.execute(
                    "SELECT status, COUNT(*) FROM llm_processing GROUP BY status"
                ).fetchall()
                llm = {r[0]: int(r[1]) for r in rows}
                data["llm_processing"] = {
                    "pending": llm.get("pending", 0),
                    "failed": llm.get("failed", 0),
                    "gave_up": llm.get("gave_up", 0),
                    "success": llm.get("success", 0),
                    "total": sum(llm.values()),
                }
            else:
                data["llm_processing"] = {"_source": "table_missing"}
        finally:
            conn.close()
    except Exception as exc:
        data["llm_processing"] = {"_error": f"{type(exc).__name__}: {exc}"}

    if cli.output.lower() == "text":
        for sec_name, sec_data in data.items():
            print(f"== {sec_name} ==")
            for k, v in sec_data.items():
                print(f"  {k:20}{v}")
    else:
        emit(cli, data)
