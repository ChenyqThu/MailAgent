"""mailagent backfill — inline body / derivatives backfills (PR-5 US-001)."""

from __future__ import annotations

import json
import sys
from typing import Any, Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.long_task import LongTaskContext, LongTaskSummary, UnitResult
from src.cli.output import apply_local_output, emit, emit_cli_error
from src.config import config as cfg
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync
from src.repository import AttachmentStore, EmailRepository
from src.sync.backfill_builders import (
    _body_row_count,
    _dead_count,
    _ensure_dead_table,
    _find_candidates,
    _hydrate_internal_ids,
    _hydrate_metadata_records,
    _list_dead,
    _make_body_units,
    _make_derivative_units,
    _make_metadata_units,
    _pick_candidates,
    _pick_metadata_candidates,
    _reset_dead,
)

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.mail.backend.base import IMailBackend

app = typer.Typer(
    name="backfill",
    help="历史回填工具 (body / derivatives)",
    no_args_is_help=True,
)


# ============================================================
# Shared CLI helpers
# ============================================================


def _common_auth_and_pm2(
    cli: "CliContext", *, dry_run: bool, allow_concurrent: bool,
) -> None:
    """Apply the write-command safety gate and render CliError consistently."""
    from src.cli.auth import require_auth_and_pm2

    try:
        require_auth_and_pm2(
            cli, dry_run=dry_run, allow_concurrent=allow_concurrent,
        )
    except CliError as exc:
        raise emit_cli_error(cli, exc)


def _parse_internal_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            ids.append(int(value))
        except ValueError as exc:
            raise CliInvalidArgError(
                f"invalid internal_id in --internal-ids: {value!r}"
            ) from exc
    if not ids:
        raise CliInvalidArgError("--internal-ids must contain at least one integer")
    return ids


def _body_target(
    *,
    all_: bool,
    internal_ids: Optional[str],
    since_date: Optional[str],
    until_date: Optional[str],
    mailbox: Optional[str],
    limit: Optional[int],
) -> tuple[str, str]:
    if internal_ids:
        ids = ",".join(str(i) for i in _parse_internal_ids(internal_ids))
        return "ids", f"ids:{ids}"
    if all_:
        return "all", "all"

    suffix = f":mailbox:{mailbox}" if mailbox else ""
    if since_date or until_date:
        key = f"date:{since_date or ''}..{until_date or ''}"
        if limit is not None:
            key += f":limit:{limit}"
        return "range", f"{key}{suffix}"
    if limit is not None:
        return "limit", f"limit:{limit}{suffix}"
    if mailbox:
        return "range", f"mailbox:{mailbox}"
    return "all", "all"


def _render_backfill_results(
    cli: "CliContext",
    results: list[UnitResult],
    summary: LongTaskSummary,
    *,
    action: str,
    dry_run: bool,
    target_kind: str,
    target_key: str,
    data_extra: Optional[dict[str, Any]] = None,
) -> typer.Exit:
    """Render LongTaskContext output with the PR-5 backfill JSON contract.

    ``emit_long_task_results`` keeps caller metadata under ``meta``. PR-5's
    backfill contract needs ``data.mode`` and ``data.action``, so this mirrors
    the helper while keeping that data shape local to this command.
    """
    succeeded = [
        {
            "internal_id": r.internal_id,
            "duration_ms": r.duration_ms,
            **(r.data or {}),
        }
        for r in results if r.status == "success"
    ]
    failed = [
        {
            "internal_id": r.internal_id,
            "duration_ms": r.duration_ms,
            "error": {"code": r.error_code, "message": r.error_message},
        }
        for r in results if r.status == "failed"
    ]
    data = {
        "action": action,
        "mode": "inline",
        "dry_run": dry_run,
        "target_kind": target_kind,
        "target_key": target_key,
        "succeeded": succeeded,
        "failed": failed,
        "summary": summary.as_dict(),
    }
    if data_extra:
        data.update(data_extra)
    meta = {
        "duration_ms": cli.elapsed_ms(),
        "aborted_by": summary.aborted_reason if summary.aborted else None,
    }
    status = _status_for_summary(summary)
    error = _error_for_summary(summary, failed)

    if cli.output.lower() == "ndjson":
        line = {"_meta": {**meta, **summary.as_dict(), "action": action, "mode": "inline"}}
        if error:
            line["_error"] = error
        print(json.dumps(line, ensure_ascii=False))
        return typer.Exit(code=summary.exit_code)

    if cli.output.lower() in ("json", "yaml"):
        wrapper: dict[str, Any] = {
            "status": status,
            "schema_version": 1,
            "data": data,
            "meta": meta,
        }
        if error:
            wrapper["error"] = error
        if cli.output.lower() == "json":
            print(json.dumps(wrapper, ensure_ascii=False, default=str))
        else:
            import yaml

            yaml.safe_dump(
                json.loads(json.dumps(wrapper, default=str)),
                sys.stdout, allow_unicode=True, sort_keys=False,
            )
        return typer.Exit(code=summary.exit_code)

    for item in succeeded:
        marker = "dead" if item.get("dead") else "ok"
        print(f"  {marker} {item['internal_id']} ({item.get('duration_ms', 0)}ms)")
    for item in failed:
        err = item["error"]
        print(
            f"  fail {item['internal_id']} ({item['duration_ms']}ms) "
            f"[{err['code']}] {err['message']}",
            file=sys.stderr,
        )
    print(
        f"[backfill] action={action} mode=inline total={summary.total} "
        f"succeeded={summary.succeeded} failed={summary.failed}",
        file=sys.stderr,
    )
    if error:
        print(f"Error [{error['code']}]: {error['message']}", file=sys.stderr)
    return typer.Exit(code=summary.exit_code)


def _status_for_summary(summary: LongTaskSummary) -> str:
    if summary.max_failures_hit or summary.aborted:
        return "error"
    if summary.failed > 0 and summary.succeeded > 0:
        return "partial_failure"
    if summary.failed > 0:
        return "error"
    return "success"


def _error_for_summary(
    summary: LongTaskSummary, failed: list[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if summary.max_failures_hit:
        return {
            "code": "E_MAX_FAILURES",
            "message": summary.aborted_reason or "max failures hit",
        }
    if summary.aborted:
        return {
            "code": "E_ABORTED",
            "message": summary.aborted_reason or "aborted",
        }
    if summary.failed > 0 and summary.succeeded == 0:
        first = failed[0]["error"] if failed else {}
        return {
            "code": first.get("code") or "E_INTERNAL",
            "message": first.get("message") or "all units failed",
        }
    return None


# ============================================================
# Body / derivative builders → src/sync/backfill_builders.py (D2a 下沉)
# 命令体经文件顶部 import 复用; job_runners.py 同样直接 import 该 engine 模块。
# ============================================================


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
        None, "--internal-ids", help="逗号分隔的 internal_id 列表",
    ),
    all_: bool = typer.Option(
        False, "--all", help="全量回填 (与其他过滤互斥)",
    ),
    limit: Optional[int] = typer.Option(None, "--limit"),
    force: bool = typer.Option(False, "--force", help="覆盖已 backfilled 的邮件"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(
        20, "--max-failures", help="连续失败熔断阈值",
    ),
    progress_every: int = typer.Option(10, "--progress-every"),
    resume_from: Optional[int] = typer.Option(None, "--resume-from"),
    retry_dead: bool = typer.Option(False, "--retry-dead"),
    show_dead: bool = typer.Option(False, "--show-dead"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """v4 historical email body backfill, now executed inline."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    db_path = cli.cli_config.sync_store_db_path

    if show_dead:
        emit(cli, _list_dead(db_path))
        return

    other_filters = any(
        value is not None for value in (
            since_date, until_date, mailbox, internal_ids, limit,
        )
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

    _ensure_dead_table(db_path)
    cleared_dead = _reset_dead(db_path) if retry_dead else 0

    if internal_ids:
        ids = _parse_internal_ids(internal_ids)
        records = _hydrate_internal_ids(ids, cli.sync_store)
    else:
        records = _pick_candidates(
            db_path,
            force=force,
            since_date=since_date,
            until_date=until_date,
            mailbox=mailbox,
            limit=limit,
        )

    target_kind, target_key = _body_target(
        all_=all_,
        internal_ids=internal_ids,
        since_date=since_date,
        until_date=until_date,
        mailbox=mailbox,
        limit=limit,
    )
    initial_body_count = _body_row_count(db_path)
    initial_dead_count = _dead_count(db_path)

    # 走 cli.backend 工厂尊重 MAILAGENT_BACKEND: davmail 下按 imap_uid/message_id
    # IMAP 重抓, applescript 下委托真 AppleScriptArm — 否则 davmail 库的合成
    # internal_id 打到 Mail.app 报 "无效的索引" (同 1dcff6f 项目周报修过的坑)
    arm = cli.backend
    reader = EmailReader()
    repo = EmailRepository(
        db_path=db_path,
        attachment_store=AttachmentStore(cli.cli_config.attachment_storage_dir),
    )
    notion_sync = NotionSync(email_repo=repo, sync_store=cli.sync_store)

    units = _make_body_units(
        records,
        arm=arm,
        reader=reader,
        repo=repo,
        notion_sync=notion_sync,
        sync_store=cli.sync_store,
        db_path=db_path,
        dry_run=dry_run,
    )
    ltc = LongTaskContext(
        cli=cli,
        command="backfill-body",
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=progress_every,
        progress_every=max(1, progress_every // 5),
        resume_from=resume_from,
        payload={
            "force": force,
            "mailbox": mailbox,
            "since_date": since_date,
            "until_date": until_date,
            "limit": limit,
            "retry_dead_cleared": cleared_dead,
            "initial_body_count": initial_body_count,
            "initial_dead_count": initial_dead_count,
        },
    )
    results, summary = ltc.run(units, dry_run=dry_run)
    raise _render_backfill_results(
        cli,
        results,
        summary,
        action="backfill-body",
        dry_run=dry_run,
        target_kind=target_kind,
        target_key=target_key,
    )


# ============================================================
# backfill derivatives
# ============================================================


def _run_backfill_derivatives_inline(
    cli: "CliContext",
    *,
    internal_id: Optional[int],
    dry_run: bool,
    max_failures: int,
    progress_every: int,
    resume_from: Optional[int] = None,
    allow_concurrent: bool = False,
    data_extra: Optional[dict[str, Any]] = None,
) -> typer.Exit:
    """Run the inline derivatives backfill and return its rendered exit."""
    db_path = cli.cli_config.sync_store_db_path

    _common_auth_and_pm2(cli, dry_run=dry_run, allow_concurrent=allow_concurrent)

    candidates = _find_candidates(db_path, internal_id)
    repo = EmailRepository(
        db_path=db_path,
        attachment_store=AttachmentStore(cli.cli_config.attachment_storage_dir),
    )
    units = _make_derivative_units(candidates, repo=repo, dry_run=dry_run)
    target_kind = "ids" if internal_id is not None else "all"
    target_key = f"ids:{internal_id}" if internal_id is not None else "all"

    ltc = LongTaskContext(
        cli=cli,
        command="backfill-derivatives",
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=progress_every,
        progress_every=max(1, progress_every // 5),
        resume_from=resume_from,
        payload={"internal_id": internal_id},
    )
    results, summary = ltc.run(units, dry_run=dry_run)
    return _render_backfill_results(
        cli,
        results,
        summary,
        action="backfill-derivatives",
        dry_run=dry_run,
        target_kind=target_kind,
        target_key=target_key,
        data_extra=data_extra,
    )


@app.command("derivatives")
def backfill_derivatives(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Option(None, "--internal-id", help="仅补单封"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(20, "--max-failures"),
    progress_every: int = typer.Option(10, "--progress-every"),
    resume_from: Optional[int] = typer.Option(None, "--resume-from"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """Backfill missing Office-derived attachment rows inline."""
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    raise _run_backfill_derivatives_inline(
        cli,
        internal_id=internal_id,
        dry_run=dry_run,
        max_failures=max_failures,
        progress_every=progress_every,
        resume_from=resume_from,
        allow_concurrent=allow_concurrent,
    )


# ============================================================
# backfill metadata — Notion API 反拉 to/cc/sender_name
# ============================================================
#
# 历史背景: SQLite radar 首次写邮件只能从 AppleScript 的 surface 属性拿
# internal_id + subject + sender + date; to / cc / sender_name 等 MIME header
# 字段必须 reader.parse_email_source 解析完整 MIME 才有, 但旧 new_watcher
# 仅 update_after_fetch 写了 4 个字段, 导致 6000+ 历史邮件 SQLite to_addr /
# cc_addr 全空 (Sprint 18 #3 修复). 修复后新邮件 OK, 但历史邮件还是空,
# 需要回填. 两条路径:
#
#   1) ``mailagent backfill body`` — 已经会 AppleScript 重 fetch 拿完整
#      MIME, 顺手补 metadata (本文件 _backfill_one_body 里). 慢 (~1s/封)
#      但同时补 body + metadata + derivatives, 适合一次性全补.
#   2) ``mailagent backfill metadata`` (本段) — 走 Notion REST 拉 page
#      properties.To / .CC / .From Name 反向写回 SQLite. 仅补 metadata,
#      不动 body. 200-400ms/封, 6300+ 封 ~15-25 分钟. 跟 pm2 mail-sync
#      并发跑安全 (WAL + 仅读 Notion / 写 SQLite metadata).


# metadata builders (pick / hydrate / one-shot / make-units) → src/sync/backfill_builders.py
# (D2a 下沉; 命令体经文件顶部 import 复用)。


@app.command("metadata")
def backfill_metadata(
    ctx: typer.Context,
    source: str = typer.Option(
        "notion", "--source",
        help="数据源: 'notion' (REST 反拉 sender_name) 或 'applescript' "
             "(AppleScript fetch + reader.parse 拿完整 to/cc/sender_name/is_important)",
    ),
    since_date: Optional[str] = typer.Option(
        None, "--since-date", help="YYYY-MM-DD",
    ),
    until_date: Optional[str] = typer.Option(
        None, "--until-date", help="YYYY-MM-DD",
    ),
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    internal_ids: Optional[str] = typer.Option(
        None, "--internal-ids", help="逗号分隔的 internal_id 列表",
    ),
    all_: bool = typer.Option(
        False, "--all", help="全量回填 (与其他过滤互斥)",
    ),
    limit: Optional[int] = typer.Option(None, "--limit"),
    force: bool = typer.Option(
        False, "--force", help="覆盖已有 to/cc/sender_name (默认仅补空字段)",
    ),
    dry_run: bool = typer.Option(False, "--dry-run"),
    max_failures: int = typer.Option(
        20, "--max-failures", help="连续失败熔断阈值",
    ),
    progress_every: int = typer.Option(10, "--progress-every"),
    resume_from: Optional[int] = typer.Option(None, "--resume-from"),
    allow_concurrent: bool = typer.Option(False, "--allow-concurrent"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """补 SQLite metadata (to/cc/sender_name/is_important) — 不动 body.

    `--source` 选择数据源:

    - ``notion`` (默认): Notion REST 反拉 page properties. 快 (~200-400ms/封,
      6300 封 15-25min), 跟 pm2 mail-sync 并发跑安全 (WAL + 不抢 AppleScript).
      但若 NOTION_READ_FROM_SQLITE=true 启用后历史邮件 Notion 端 To/CC 也是
      空 (v4 路径从空 SQLite 读 → 写空 Notion), 此模式只能补 sender_name.

    - ``applescript``: AppleScript fetch + reader.parse, 拿到原始 MIME 头部
      解析出完整 to/cc/sender_name/is_important. 慢 (~500ms-1s/封, 6300 封
      ~1.5-2h), 期间应停 pm2 mail-sync 避免抢 AppleScript. 跟
      ``backfill body --force`` 时间相当但不重写已有完整 body.
    """
    cli: "CliContext" = ctx.obj
    apply_local_output(ctx, output)
    db_path = cli.cli_config.sync_store_db_path

    if source not in ("notion", "applescript"):
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source must be 'notion' or 'applescript', got {source!r}",
        ))

    other_filters = any(
        v is not None for v in (since_date, until_date, mailbox, internal_ids, limit)
    )
    if all_ and other_filters:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--all is mutually exclusive with --since-date / --until-date / "
            "--mailbox / --internal-ids / --limit",
        ))
    if not all_ and not other_filters:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Provide --all or at least one filter "
            "(--since-date / --limit / --internal-ids / etc.)",
        ))

    _common_auth_and_pm2(
        cli, dry_run=dry_run, allow_concurrent=allow_concurrent,
    )

    if internal_ids:
        ids = _parse_internal_ids(internal_ids)
        records = _hydrate_metadata_records(ids, cli.sync_store)
    else:
        records = _pick_metadata_candidates(
            db_path,
            force=force,
            since_date=since_date,
            until_date=until_date,
            mailbox=mailbox,
            limit=limit,
        )

    # 按 source 路由数据源 client
    notion_client: Optional[Any] = None
    arm: Optional["IMailBackend"] = None
    reader: Optional[EmailReader] = None
    if source == "notion":
        # notion-client 的 sync Client; AsyncClient 不能在 LongTaskContext sync
        # unit 里直接 await, 这里直接用 sync 版本省心.
        from notion_client import Client as NotionSyncClient
        notion_client = NotionSyncClient(auth=cfg.notion_token)
    else:  # applescript
        if getattr(cli.cli_config, "mailagent_backend", "applescript") == "davmail":
            raise emit_cli_error(cli, CliInvalidArgError(
                "backfill metadata --source=applescript unsupported when "
                "MAILAGENT_BACKEND=davmail (AppleScript `whose id` 无法定位 "
                "davmail id 空间 >=10^9 的 internal_id)",
                hint="改用 --source=notion (默认), 或临时切回 "
                "MAILAGENT_BACKEND=applescript 跑完本次回填",
            ))
        # E1 §3.1 Step 3: 走到这里已确保 mailagent_backend != davmail, cli.backend
        # 即等价的已 probe AppleScriptBackend 实例 (factory 收口, 不再裸构造)。
        arm = cli.backend
        reader = EmailReader()

    units = _make_metadata_units(
        records,
        source=source,
        notion_client=notion_client,
        arm=arm,
        reader=reader,
        sync_store=cli.sync_store,
        dry_run=dry_run,
    )

    if internal_ids:
        target_kind, target_key_base = "ids", internal_ids
    elif all_:
        target_kind, target_key_base = "all", "all"
    else:
        target_kind = "filtered"
        target_key_base = (
            f"f:{since_date or ''}:{until_date or ''}:"
            f"{mailbox or ''}:{limit or ''}"
        )
    # source 进 target_key, notion / applescript 两条路径不串 checkpoint
    target_key = f"{source}:{target_key_base}"

    ltc = LongTaskContext(
        cli=cli,
        command="backfill-metadata",
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=progress_every,
        progress_every=max(1, progress_every // 5),
        resume_from=resume_from,
        payload={
            "source": source,
            "force": force,
            "mailbox": mailbox,
            "since_date": since_date,
            "until_date": until_date,
            "limit": limit,
        },
    )
    results, summary = ltc.run(units, dry_run=dry_run)
    raise _render_backfill_results(
        cli,
        results,
        summary,
        action="backfill-metadata",
        dry_run=dry_run,
        target_kind=target_kind,
        target_key=target_key,
    )
