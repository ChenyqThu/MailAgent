"""mailagent email — CRUD / 搜索 / 重传 (RFC v2 §4.2).

US-003: get / body
US-004: list / search (text / json / ndjson)
US-005: resync (单封 + dry-run, 含 auth)
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any, Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliNotFoundError
from src.cli.output import emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.repository import (
        AttachmentRecord,
        EmailBodyRecord,
        EmailMetadataRecord,
    )

app = typer.Typer(name="email", help="邮件 CRUD / 搜索 / 重传", no_args_is_help=True)


_VALID_LEAF_OUTPUT = ("text", "json", "yaml", "ndjson")


def _apply_local_output(ctx: typer.Context, output: Optional[str]) -> None:
    """允许 `-o json` 写在 leaf command 后 (gh/kubectl 风格).

    parent typer App 的全局 -o 只在 subcommand **之前** 生效;
    每个 leaf 暴露同名 flag, 若用户在 leaf 后传则覆盖 ctx.obj.output。

    校验未知值 (PR-2 critic fix #5 / R-18): 拒绝 silent fallback 到 text。
    """
    if output is None or ctx.obj is None:
        return
    if output.lower() not in _VALID_LEAF_OUTPUT:
        raise typer.BadParameter(
            f"--output must be one of {_VALID_LEAF_OUTPUT}, got {output!r}",
            param_hint="-o/--output",
        )
    ctx.obj.output = output.lower()


# ============================================================
# Helpers (US-003)
# ============================================================

VALID_INCLUDE = {"body", "attachments", "all"}
VALID_BODY_FORMATS = {"markdown", "html", "raw"}


def _meta_to_dict(meta: "EmailMetadataRecord") -> dict:
    """EmailMetadataRecord → wire dict — 不含 body / attachments."""
    return {
        "internal_id": meta.internal_id,
        "message_id": meta.message_id,
        "thread_id": meta.thread_id,
        "subject": meta.subject,
        "sender": meta.sender,
        "sender_name": meta.sender_name,
        "to_addr": meta.to_addr,
        "cc_addr": meta.cc_addr,
        "date_received": meta.date_received,
        "mailbox": meta.mailbox,
        "is_read": meta.is_read,
        "is_flagged": meta.is_flagged,
        "sync_status": meta.sync_status,
        "notion_page_id": meta.notion_page_id,
        "notion_thread_id": meta.notion_thread_id,
        "notion_url": meta.notion_url,
        "sync_error": meta.sync_error,
        "retry_count": meta.retry_count,
    }


def _body_summary(body: Optional["EmailBodyRecord"]) -> Optional[dict]:
    if body is None:
        return None
    return {
        "format": body.body_format,
        "size_bytes": body.body_size_bytes,
        "has_inline_images": body.has_inline_images,
        "fetched_at": body.fetched_at,
        "fetched_source": body.fetched_source,
        "raw_mime_sha256": body.raw_mime_sha256,
    }


def _attachment_to_dict(att: "AttachmentRecord") -> dict:
    return {
        "id": att.id,
        "filename": att.filename,
        "size_bytes": att.size_bytes,
        "content_type": att.content_type,
        "is_inline": att.is_inline,
        "content_id": att.content_id,
        "sha256": att.sha256,
        "derived_from": att.derived_from,
        "derived_format": att.derived_format,
        "notion_file_id": att.notion_file_id,
        "notion_block_id": att.notion_block_id,
    }


def _parse_include(include: str) -> set[str]:
    """逗号分隔 → set。'all' 展开为 body+attachments。"""
    if not include:
        return set()
    parts = {p.strip().lower() for p in include.split(",") if p.strip()}
    unknown = parts - VALID_INCLUDE
    if unknown:
        raise CliInvalidArgError(
            f"Unknown --include value(s): {sorted(unknown)}; "
            f"valid: {sorted(VALID_INCLUDE)}"
        )
    if "all" in parts:
        return {"body", "attachments"}
    return parts


# ============================================================
# get (US-003)
# ============================================================

@app.command("get")
def email_get(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    include: str = typer.Option(
        "", "--include",
        help="逗号分隔: body / attachments / all (默认仅 metadata)",
    ),
    output: Optional[str] = typer.Option(
        None, "-o", "--output",
        help="覆盖全局 --output (允许 leaf 后跟 -o, gh/kubectl 风格)",
    ),
) -> None:
    """获取邮件 metadata（默认）+ 可选 body / attachments 摘要。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        parts = _parse_include(include)
    except CliError as e:
        raise emit_cli_error(cli, e)

    repo = cli.email_repo

    if parts:
        full = repo.get_email_full(internal_id)
        if full is None:
            raise emit_cli_error(cli, CliNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            ))
        data = _meta_to_dict(full.metadata)
        data["body"] = _body_summary(full.body) if "body" in parts else None
        data["attachments"] = (
            [_attachment_to_dict(a) for a in full.attachments]
            if "attachments" in parts else []
        )
    else:
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise emit_cli_error(cli, CliNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            ))
        data = _meta_to_dict(meta)
        data["body"] = None
        data["attachments"] = []

    if cli.output.lower() == "text":
        _render_email_text(data, parts)
    else:
        emit(cli, data)


def _render_email_text(data: dict, parts: set[str]) -> None:
    """Text 渲染 email get — 简洁键值对。"""
    print(f"internal_id   {data['internal_id']}")
    print(f"subject       {data['subject']}")
    print(f"sender        {data['sender_name'] or ''} <{data['sender']}>")
    print(f"to            {data['to_addr']}")
    if data["cc_addr"]:
        print(f"cc            {data['cc_addr']}")
    print(f"date          {data['date_received']}")
    print(f"mailbox       {data['mailbox']}")
    print(f"status        {data['sync_status']}")
    print(f"is_read       {data['is_read']}")
    print(f"is_flagged    {data['is_flagged']}")
    print(f"thread_id     {data['thread_id']}")
    print(f"message_id    {data['message_id']}")
    if data["notion_url"]:
        print(f"notion        {data['notion_url']}")
    if data["body"]:
        body = data["body"]
        print(
            f"body          format={body['format']} size={body['size_bytes']} "
            f"inline_img={body['has_inline_images']}"
        )
    elif "body" in parts:
        print("body          (none)")
    if data["attachments"]:
        print(f"attachments   {len(data['attachments'])}")
        for att in data["attachments"]:
            kind = "inline" if att["is_inline"] else "attach"
            print(
                f"  - [{att['id']}] {kind} {att['filename']} "
                f"({att['size_bytes']} bytes, {att['content_type']})"
            )
    elif "attachments" in parts:
        print("attachments   []")


# ============================================================
# body (US-003)
# ============================================================

@app.command("body")
def email_body(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    format_: str = typer.Option(
        "markdown", "--format", "-f",
        help="markdown (default) / html / raw",
    ),
    output: Optional[str] = typer.Option(
        None, "-o", "--output",
        help="覆盖全局 --output (gh/kubectl 风格)",
    ),
) -> None:
    """返回邮件正文 — markdown / html / raw_mime_sha256 (仅哈希)。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    fmt = format_.lower()
    if fmt not in VALID_BODY_FORMATS:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--format must be one of {sorted(VALID_BODY_FORMATS)}, got {format_!r}"
        ))

    repo = cli.email_repo
    body_record = repo.get_body(internal_id)
    if body_record is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"No body in SQLite for internal_id={internal_id}",
            hint="可能未经 v4 双写; 跑 `mailagent backfill body --internal-ids <id>` 回填",
        ))

    if fmt == "markdown":
        content = body_record.markdown
    elif fmt == "html":
        content = body_record.html
    else:  # raw
        content = body_record.raw_mime_sha256

    if content is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Body format {fmt!r} unavailable for internal_id={internal_id}",
            hint="可能仅 dual-write 了另一种 format; 试 --format html / markdown",
        ))

    if cli.output.lower() == "text":
        # text 模式直接 stdout 输出原文 (人类 / shell pipe 友好)
        print(content)
        return

    data = {
        "internal_id": internal_id,
        "format": fmt,
        "content": content,
        "size_bytes": (
            body_record.body_size_bytes
            if fmt != "raw" else len(content) if content else 0
        ),
        "fetched_at": body_record.fetched_at,
        "fetched_source": body_record.fetched_source,
    }
    emit(cli, data)


# ============================================================
# list (US-004)
# ============================================================

VALID_STATUSES = {"pending", "fetch_failed", "synced", "failed", "skipped", "dead_letter"}
VALID_TRIBOOL = {"true", "false", None}
LIST_LIMIT_DEFAULT = 50
LIST_LIMIT_MAX = 500


def _tribool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    v = value.strip().lower()
    if v == "true":
        return True
    if v == "false":
        return False
    raise CliInvalidArgError(
        f"Expected true/false, got {value!r}"
    )


@app.command("list")
def email_list(
    ctx: typer.Context,
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    status: Optional[str] = typer.Option(None, "--status"),
    since: Optional[str] = typer.Option(None, "--since", help="YYYY-MM-DD"),
    until: Optional[str] = typer.Option(None, "--until", help="YYYY-MM-DD"),
    from_: Optional[str] = typer.Option(None, "--from", help="sender 子串"),
    subject_substr: Optional[str] = typer.Option(None, "--subject"),
    is_read: Optional[str] = typer.Option(None, "--is-read"),
    is_flagged: Optional[str] = typer.Option(None, "--is-flagged"),
    has_notion: Optional[str] = typer.Option(None, "--has-notion"),
    limit: int = typer.Option(LIST_LIMIT_DEFAULT, "--limit"),
    offset: int = typer.Option(0, "--offset"),
    source: str = typer.Option(
        "syncstore", "--source",
        help="syncstore (default, 已同步邮件) / mail (Mail.app 全量, 暂未实现)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出邮件 — text 表格 / json wrapper / ndjson stream."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if limit <= 0 or limit > LIST_LIMIT_MAX:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be in (0, {LIST_LIMIT_MAX}], got {limit}"
        ))
    if offset < 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--offset must be >= 0, got {offset}"
        ))
    if status and status not in VALID_STATUSES:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--status must be one of {sorted(VALID_STATUSES)}, got {status!r}"
        ))

    try:
        is_read_bool = _tribool(is_read)
        is_flagged_bool = _tribool(is_flagged)
        has_notion_bool = _tribool(has_notion)
    except CliError as e:
        raise emit_cli_error(cli, e)

    source_norm = source.lower()
    if source_norm == "mail":
        raise emit_cli_error(cli, CliInvalidArgError(
            "--source mail not implemented in PR-2 "
            "(走 SQLiteRadar.search_all_emails, PR-3 范围)",
            hint="Use --source syncstore (default) or wait for PR-3",
        ))
    if source_norm != "syncstore":
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--source must be 'syncstore' or 'mail', got {source!r}"
        ))

    repo = cli.email_repo
    result = repo.list_metadata(
        mailbox=mailbox,
        status=status,
        date_from=since,
        date_to=until,
        sender_substr=from_,
        subject_substr=subject_substr,
        is_read=is_read_bool,
        is_flagged=is_flagged_bool,
        has_notion=has_notion_bool,
        limit=limit,
        offset=offset,
    )
    rows = result.get("emails", [])

    data = [_meta_record_to_list_item(r) for r in rows]
    meta_extra = {
        "total": result.get("total", len(rows)),
        "limit": result.get("limit", limit),
        "offset": result.get("offset", offset),
        "count": len(data),
    }

    if cli.output.lower() == "text":
        _render_list_text(data, meta_extra)
    else:
        emit(cli, data, meta_extra=meta_extra)


def _meta_record_to_list_item(meta: "EmailMetadataRecord") -> dict:
    """EmailMetadataRecord → list 输出 item (含 sync_status + thread_id)."""
    page_id = meta.notion_page_id
    notion_url = (
        f"https://www.notion.so/{page_id.replace('-', '')}"
        if page_id else None
    )
    return {
        "internal_id": meta.internal_id,
        "message_id": meta.message_id,
        "thread_id": meta.thread_id,
        "subject": meta.subject,
        "sender": meta.sender,
        "sender_name": meta.sender_name,
        "date_received": meta.date_received,
        "mailbox": meta.mailbox,
        "is_read": meta.is_read,
        "is_flagged": meta.is_flagged,
        "sync_status": meta.sync_status,
        "notion_page_id": page_id,
        "notion_url": notion_url,
    }


def _render_list_text(data: list[dict], meta: dict) -> None:
    """Rich 表格 fallback — 失败回到纯 ASCII."""
    try:
        from rich.console import Console
        from rich.table import Table

        table = Table(show_lines=False)
        table.add_column("internal_id", justify="right")
        table.add_column("subject", overflow="fold")
        table.add_column("sender")
        table.add_column("date")
        table.add_column("status")
        for row in data:
            sender = row["sender_name"] or row["sender"] or ""
            table.add_row(
                str(row["internal_id"]),
                (row["subject"] or "")[:60],
                sender[:30],
                (row["date_received"] or "")[:19],
                row["sync_status"] or "",
            )
        Console().print(table)
    except Exception:
        for row in data:
            print(
                f"{row['internal_id']}\t{(row['subject'] or '')[:50]}\t"
                f"{(row['sender'] or '')[:30]}\t{row['date_received']}\t{row['sync_status']}"
            )
    print(
        f"({meta['count']} shown, total={meta['total']}, "
        f"limit={meta['limit']}, offset={meta['offset']})",
        file=sys.stderr,
    )


# ============================================================
# search (US-004)
# ============================================================

SEARCH_LIMIT_DEFAULT = 50
SEARCH_LIMIT_MAX = 200


@app.command("search")
def email_search(
    ctx: typer.Context,
    query: str = typer.Argument(..., help="自然语言关键词 或 FTS5 query 语法"),
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    since: Optional[str] = typer.Option(None, "--since", help="YYYY-MM-DD"),
    until: Optional[str] = typer.Option(None, "--until", help="YYYY-MM-DD"),
    limit: int = typer.Option(SEARCH_LIMIT_DEFAULT, "--limit"),
    no_snippet: bool = typer.Option(False, "--no-snippet"),
    raw: bool = typer.Option(
        False,
        "--raw",
        help="不做 CJK smart wrapper, 直接交给 FTS5. 默认 smart (PR-2a)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """FTS5 全文搜索邮件正文 + subject + sender (RFC §4.2 / §7.2).

    默认 smart 模式 (PR-2a): 自然语言 query '产品' 自动改写成
    '(产品* OR (产* AND 品*))' 等, 解决 unicode61 chunk-level token
    命不中的中文搜索痛点. 用 --raw 关掉 wrapper 走原 FTS5 syntax.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if limit <= 0 or limit > SEARCH_LIMIT_MAX:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be in (0, {SEARCH_LIMIT_MAX}], got {limit}"
        ))

    repo = cli.email_repo
    if raw:
        hits = repo.search_email_bodies(
            query,
            limit=limit,
            mailbox=mailbox,
            since_date=since,
            until_date=until,
        )
        transformed_query = query
    else:
        from src.repository.email_repository import smart_query_transform
        transformed_query = smart_query_transform(query)
        hits = repo.search_email_bodies(
            transformed_query,
            limit=limit,
            mailbox=mailbox,
            since_date=since,
            until_date=until,
        )

    data = []
    for hit in hits:
        item = {
            "internal_id": hit.internal_id,
            "subject": hit.subject,
            "sender": hit.sender,
            "date_received": hit.date_received,
            "mailbox": hit.mailbox,
            "rank": hit.rank,
            "notion_page_id": hit.notion_page_id,
            "notion_url": hit.notion_url,
        }
        if not no_snippet:
            item["snippet"] = hit.snippet
        data.append(item)

    meta_extra = {
        "query": query,
        "mode": "raw" if raw else "smart",
        "total_hits": len(data),
        "limit": limit,
        "count": len(data),
    }
    if not raw and transformed_query != query:
        meta_extra["transformed_query"] = transformed_query

    if cli.output.lower() == "text":
        _render_search_text(data, meta_extra, no_snippet)
    else:
        emit(cli, data, meta_extra=meta_extra)


def _render_search_text(data: list[dict], meta: dict, no_snippet: bool) -> None:
    try:
        from rich.console import Console
        from rich.table import Table

        table = Table(show_lines=False)
        table.add_column("internal_id", justify="right")
        table.add_column("rank", justify="right")
        table.add_column("subject", overflow="fold")
        table.add_column("sender")
        if not no_snippet:
            table.add_column("snippet", overflow="fold")
        for row in data:
            cells = [
                str(row["internal_id"]),
                f"{row['rank']:.2f}",
                (row["subject"] or "")[:50],
                (row["sender"] or "")[:25],
            ]
            if not no_snippet:
                cells.append((row.get("snippet") or "")[:80])
            table.add_row(*cells)
        Console().print(table)
    except Exception:
        for row in data:
            print(
                f"{row['internal_id']}\t{row['rank']:.2f}\t"
                f"{(row['subject'] or '')[:50]}\t{row['sender']}"
            )
    print(
        f"(query={meta['query']!r}, hits={meta['total_hits']}, limit={meta['limit']})",
        file=sys.stderr,
    )


# ============================================================
# resync (PR-2 单封 + PR-4 batch flags)
# ============================================================


def _parse_id_range(spec: str) -> list[int]:
    """``--range 53000-53100`` → [53000, 53001, ..., 53100] (闭区间)."""
    if "-" not in spec:
        raise CliInvalidArgError(
            f"--range expects LO-HI (got {spec!r})",
            hint="Example: --range 53000-53100",
        )
    lo_s, hi_s = spec.split("-", 1)
    try:
        lo, hi = int(lo_s), int(hi_s)
    except ValueError:
        raise CliInvalidArgError(
            f"--range LO-HI must be integers (got {spec!r})"
        )
    if lo > hi:
        raise CliInvalidArgError(
            f"--range LO must be <= HI (got {lo}-{hi})"
        )
    return list(range(lo, hi + 1))


def _parse_id_list(spec: str) -> list[int]:
    """``--ids 53674,53675,53677`` → [53674, 53675, 53677] (去重保序)."""
    parts = [p.strip() for p in spec.split(",") if p.strip()]
    if not parts:
        raise CliInvalidArgError("--ids must list at least one internal_id")
    out: list[int] = []
    seen: set[int] = set()
    for p in parts:
        try:
            iid = int(p)
        except ValueError:
            raise CliInvalidArgError(
                f"--ids item must be integer (got {p!r})"
            )
        if iid not in seen:
            seen.add(iid)
            out.append(iid)
    return out


@app.command("resync")
def email_resync(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Argument(
        None, help="单封 internal_id (与 --range / --ids 互斥)",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="只打 plan, 不写 Notion"),
    replace_existing: bool = typer.Option(
        False, "--replace-existing",
        help="archive 老页 → 建新",
    ),
    no_parent: bool = typer.Option(
        False, "--no-parent",
        help="跳过 thread relations 重建 (diff 验证用)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
    # PR-4 batch flags
    range_: Optional[str] = typer.Option(
        None, "--range", help="LO-HI 闭区间 (PR-4): --range 53000-53100",
    ),
    ids: Optional[str] = typer.Option(
        None, "--ids", help="逗号分隔 ids (PR-4): --ids 53674,53675,53677",
    ),
    max_failures: int = typer.Option(
        5, "--max-failures",
        help="连续失败 N 次熔断 (RFC §5.2 exit 8). 0 = 不熔断",
    ),
    resume_from: Optional[int] = typer.Option(
        None, "--resume-from",
        help="batch 从 internal_id >= N 续跑 (优先于自动 checkpoint)",
    ),
    progress_every: int = typer.Option(
        50, "--progress-every",
        help="checkpoint + progress 频率 (每 N unit)",
    ),
    allow_concurrent: bool = typer.Option(
        False, "--allow-concurrent",
        help="跳过 PM2 mail-sync 冲突检测 (写命令默认拒并行)",
    ),
) -> None:
    """基于 SQLite SSoT 重传邮件到 Notion (RFC v2 §4.2 / §7.3 / PR-4 batch).

    三种 target 互斥:
      - 位置参数 ``<internal_id>`` (单封, PR-2 行为)
      - ``--range LO-HI`` (闭区间)
      - ``--ids 1,2,3`` (列表)

    Batch 模式走 ``LongTaskContext`` (SIGINT 二次 / max-failures 熔断 / checkpoint),
    退出码: 0 / 6 partial / 7 SIGINT / 8 max-failures / 9 PM2.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    targets_given = sum(1 for x in (internal_id, range_, ids) if x is not None)
    if targets_given == 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Must give <internal_id> or --range LO-HI or --ids 1,2,3"
        ))
    if targets_given > 1:
        raise emit_cli_error(cli, CliInvalidArgError(
            "<internal_id>, --range, --ids are mutually exclusive"
        ))

    # 解析 batch target
    batch_ids: Optional[list[int]] = None
    target_kind = "single"
    target_key = ""
    if range_ is not None:
        try:
            batch_ids = _parse_id_range(range_)
        except CliError as e:
            raise emit_cli_error(cli, e)
        target_kind = "range"
        target_key = range_
    elif ids is not None:
        try:
            batch_ids = _parse_id_list(ids)
        except CliError as e:
            raise emit_cli_error(cli, e)
        target_kind = "ids"
        target_key = f"ids:{','.join(str(i) for i in batch_ids[:5])}"
        if len(batch_ids) > 5:
            target_key += f"+{len(batch_ids) - 5}"

    # 写命令 auth: dry-run 跳过
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        # PM2 conflict 检测 (写命令)
        from src.cli.pm2_check import check_pm2_conflict
        try:
            check_pm2_conflict(cli, allow_concurrent=allow_concurrent)
        except CliError as e:
            raise emit_cli_error(cli, e)

    # Single-id 走原 PR-2 路径
    if batch_ids is None:
        return _resync_single(
            cli, internal_id,  # type: ignore[arg-type]
            dry_run=dry_run,
            replace_existing=replace_existing,
            no_parent=no_parent,
        )

    # Batch 模式
    return _resync_batch(
        cli,
        internal_ids=batch_ids,
        target_kind=target_kind,
        target_key=target_key,
        dry_run=dry_run,
        replace_existing=replace_existing,
        no_parent=no_parent,
        max_failures=max_failures,
        resume_from=resume_from,
        progress_every=progress_every,
    )


def _resync_single(
    cli: "CliContext",
    internal_id: int,
    *,
    dry_run: bool,
    replace_existing: bool,
    no_parent: bool,
) -> None:
    """PR-2 单封 resync 路径 (保留向后兼容)."""
    meta = cli.email_repo.get_metadata(internal_id)
    if meta is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email metadata not found for internal_id={internal_id}",
        ))

    if dry_run:
        plan = {
            "internal_id": internal_id,
            "subject": meta.subject,
            "current_page_id": meta.notion_page_id,
            "action": "replace" if replace_existing else "create_or_skip",
            "would_replace": replace_existing,
            "skip_parent_lookup": no_parent,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print("=== resync plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:24} {value}")
        else:
            emit(cli, plan)
        return

    notion_sync = cli.notion_sync
    try:
        result = asyncio.run(
            notion_sync.create_email_page_from_sqlite(
                internal_id,
                repo=cli.email_repo,
                sync_store=cli.sync_store,
                replace_existing=replace_existing,
                skip_parent_lookup=no_parent,
            )
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliNotFoundError(
            str(e),
            hint="Phase 1 之前的邮件正文未双写; 跑 `mailagent backfill body --internal-ids <id>` "
                 "回填后再 resync",
        ))

    data = {
        "internal_id": internal_id,
        "old_page_id": result.existing_page_id or meta.notion_page_id,
        "new_page_id": result.page_id,
        "archived_page_id": result.archived_page_id,
        "action": result.action,
        "dry_run": False,
    }

    if cli.output.lower() == "text":
        print(
            f"resync {result.action}: internal_id={internal_id} "
            f"new_page={result.page_id}"
        )
    else:
        emit(cli, data)


def _resync_batch(
    cli: "CliContext",
    *,
    internal_ids: list[int],
    target_kind: str,
    target_key: str,
    dry_run: bool,
    replace_existing: bool,
    no_parent: bool,
    max_failures: int,
    resume_from: Optional[int],
    progress_every: int,
) -> None:
    """PR-4 batch resync — 走 LongTaskContext."""
    from src.cli.long_task import LongTaskContext, emit_long_task_results

    repo = cli.email_repo

    if dry_run:
        # dry-run: 列出 (internal_id, current_page_id, planned_action)
        plan_items: list[dict] = []
        for iid in internal_ids:
            meta = repo.get_metadata(iid)
            plan_items.append({
                "internal_id": iid,
                "exists": meta is not None,
                "subject": meta.subject if meta else None,
                "current_page_id": meta.notion_page_id if meta else None,
                "action": (
                    "replace" if replace_existing else "create_or_skip"
                ) if meta else "skip_missing",
            })
        plan_data = {
            "target_kind": target_kind,
            "target_key": target_key,
            "total": len(internal_ids),
            "replace_existing": replace_existing,
            "skip_parent_lookup": no_parent,
            "items": plan_items,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print(f"=== resync batch plan (dry-run, {len(internal_ids)} items) ===")
            print(f"target: {target_kind}={target_key}")
            for it in plan_items:
                marker = "?" if not it["exists"] else ("R" if replace_existing else "C")
                print(
                    f"  {marker} {it['internal_id']:>7} "
                    f"page={(it['current_page_id'] or '-')[:36]} "
                    f"({(it['subject'] or '<missing>')[:50]})"
                )
        else:
            emit(cli, plan_data)
        return

    # 实跑 batch
    notion_sync = cli.notion_sync

    def _make_unit(iid: int):
        def _runner() -> dict:
            try:
                result = asyncio.run(
                    notion_sync.create_email_page_from_sqlite(
                        iid,
                        repo=repo,
                        sync_store=cli.sync_store,
                        replace_existing=replace_existing,
                        skip_parent_lookup=no_parent,
                    )
                )
            except ValueError as e:
                # body / metadata 缺 — 老邮件未双写
                raise CliNotFoundError(
                    f"internal_id={iid} not in SQLite SSoT: {e}",
                    hint="Run backfill body first",
                )
            return {
                "page_id": result.page_id,
                "archived_page_id": result.archived_page_id,
                "action": result.action,
            }
        return _runner

    units = [(iid, _make_unit(iid)) for iid in internal_ids]

    ltc = LongTaskContext(
        cli=cli,
        command="email-resync",
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=progress_every,
        progress_every=max(1, progress_every // 5),  # text progress 比 checkpoint 频
        resume_from=resume_from,
        payload={
            "replace_existing": replace_existing,
            "skip_parent_lookup": no_parent,
        },
    )
    results, summary = ltc.run(units)
    raise emit_long_task_results(
        cli, results, summary,
        extra_meta={
            "target_kind": target_kind,
            "target_key": target_key,
        },
    )


# ============================================================
# PIN (v8) — front-end "置顶" persistence
# ============================================================

def _emit_pin_result(
    cli: "CliContext",
    *,
    internal_id: int,
    pinned: bool,
    changed: bool,
    dry_run: bool,
) -> None:
    emit(cli, {
        "internal_id": internal_id,
        "is_pinned": pinned,
        "changed": changed,
        "dry_run": dry_run,
    })


@app.command("pin")
def email_pin(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只显示将要发生的状态, 不写 SQLite"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """置顶邮件（写 email_metadata.is_pinned=1 + pinned_at=now）。

    Mail.app 没有 pin 概念；该字段仅作本地 / 前端持久化，
    pm2 mail-sync 主进程不读不写它。Electron 也走同一份 SQLite，
    所以 CLI 改完前端 5s 内 refetch 自动看到。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    # v8 schema (is_pinned + pinned_at) is owned by SyncStore.__init__'s
    # ALTER TABLE migration; touching `cli.sync_store` here makes the pin
    # command self-sufficient when pm2 mail-sync hasn't been restarted yet
    # against the v8-aware codebase.
    _ = cli.sync_store
    repo = cli.email_repo

    meta = repo.get_metadata(internal_id)
    if meta is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email with internal_id={internal_id} not found",
            hint="Use 'mailagent email list' to find available IDs",
        ))
    already = bool(meta.is_pinned)

    if dry_run:
        _emit_pin_result(
            cli,
            internal_id=internal_id,
            pinned=True,
            changed=not already,
            dry_run=True,
        )
        return

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    result = repo.set_pin(internal_id, True)
    if result is None:
        # race: 写命令之间被删
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email with internal_id={internal_id} disappeared mid-write",
        ))
    _emit_pin_result(
        cli,
        internal_id=internal_id,
        pinned=True,
        changed=not already,
        dry_run=False,
    )


@app.command("unpin")
def email_unpin(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只显示将要发生的状态, 不写 SQLite"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """取消置顶（写 is_pinned=0, pinned_at=NULL）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _ = cli.sync_store  # ensure v8 schema (see email_pin docstring)
    repo = cli.email_repo

    meta = repo.get_metadata(internal_id)
    if meta is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email with internal_id={internal_id} not found",
        ))
    was = bool(meta.is_pinned)

    if dry_run:
        _emit_pin_result(
            cli,
            internal_id=internal_id,
            pinned=False,
            changed=was,
            dry_run=True,
        )
        return

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    repo.set_pin(internal_id, False)
    _emit_pin_result(
        cli,
        internal_id=internal_id,
        pinned=False,
        changed=was,
        dry_run=False,
    )


@app.command("list-pinned")
def email_list_pinned(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出当前所有置顶邮件的 internal_id（pinned_at DESC）。

    用于前端启动时拉取置顶列表（取代 localStorage）。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _ = cli.sync_store  # ensure v8 schema (see email_pin docstring)
    repo = cli.email_repo
    ids = repo.list_pinned_ids()
    if cli.output.lower() == "text":
        for iid in ids:
            print(iid)
    else:
        emit(cli, {"pinned_ids": ids, "count": len(ids)})


# ============================================================
# email archive — 收件箱邮件归档 (IMAP MOVE INBOX→Archive + Mailbox→存档). davmail-only.
# ============================================================

_ARCHIVE_MAILBOX = "存档"


def _folder_imap_reader(cli: "CliContext"):
    """构造 FolderImapReader (归档走 IMAP); 要求 davmail backend, 否则 raise CliError.

    与 folder.py _reader 同 gate (folder 级 IMAP 操作 applescript 模式不支持)。
    """
    from src.folder_sync.imap_folder_reader import FolderImapReader
    from src.mail.backend.davmail_backend import DavMailBackend

    backend = cli.backend
    if not isinstance(backend, DavMailBackend):
        raise CliInvalidArgError(
            "归档需要 MAILAGENT_BACKEND=davmail (IMAP MOVE); "
            f"当前 backend={getattr(backend, 'backend_origin', '?')!r} 不支持.",
            hint="在 .env 设 MAILAGENT_BACKEND=davmail 并确认 DavMail JVM 在跑.",
        )
    return FolderImapReader(backend)


async def _update_notion_mailbox(cli: "CliContext", page_id: str, mailbox: str) -> None:
    """把 Notion 邮件页的 Mailbox (Select) 属性改成目标值 (归档 = 存档)。"""
    client = cli.notion_sync.client.client  # AsyncClient
    await client.pages.update(
        page_id=page_id,
        properties={"Mailbox": {"select": {"name": mailbox}}},
    )


@app.command("archive")
def email_archive(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="收件箱邮件 internal_id"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="只打 plan (将归档的邮件 + 目标), 不实际 MOVE",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """归档收件箱邮件: IMAP MOVE INBOX→Archive + SQLite/Notion Mailbox→存档 (davmail-only).

    像 Mail.app / Outlook 归档一样把邮件移出收件箱进 Archive 文件夹。不删本地 body /
    附件 / Notion 页 (仅改 Mailbox 标签, 可逆); Archive 副本由 FolderSyncWorker 入
    folder_email 表, 前端 /archive 视图可见。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    meta = cli.sync_store.get(internal_id)
    if not meta:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email metadata not found for internal_id={internal_id}",
        ))
    current_mailbox = meta.get("mailbox") or ""
    message_id = meta.get("message_id")
    imap_uid = meta.get("imap_uid")
    notion_page_id = meta.get("notion_page_id")

    if dry_run:
        plan = {
            "internal_id": internal_id,
            "action": "archive",
            "from_mailbox": current_mailbox,
            "to_mailbox": _ARCHIVE_MAILBOX,
            "message_id": message_id,
            "has_imap_uid": imap_uid is not None,
            "notion_page_id": notion_page_id,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print("=== email archive plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:16} {value}")
        else:
            emit(cli, plan)
        return

    if current_mailbox == _ARCHIVE_MAILBOX:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"Email {internal_id} 已在存档 (mailbox={current_mailbox!r})",
        ))

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    # 1. IMAP MOVE INBOX → Archive (davmail-only)
    try:
        reader = _folder_imap_reader(cli)
    except CliError as e:
        raise emit_cli_error(cli, e)
    moved = reader.archive_inbox_message(message_id, fallback_uid=imap_uid)
    if not moved:
        raise emit_cli_error(cli, CliError(
            f"IMAP 归档失败 (INBOX→Archive) internal_id={internal_id}; "
            "邮件可能已不在 INBOX 或 Archive 文件夹未发现",
        ))

    # 2. SQLite: mailbox → 存档 (移出收件箱视图; body/附件保留)
    cli.sync_store.update_mailbox(internal_id, _ARCHIVE_MAILBOX)

    # 3. Notion 镜像: Mailbox 属性 → 存档 (可逆, 不删页)。失败仅 warn — IMAP 已成功,
    #    不该因 Notion 抖动让整体算失败 (下次 resync 可纠正)。
    notion_updated = False
    notion_error = None
    if notion_page_id:
        try:
            asyncio.run(_update_notion_mailbox(cli, notion_page_id, _ARCHIVE_MAILBOX))
            notion_updated = True
        except Exception as e:  # noqa: BLE001 — Notion SDK 抛各种, 不阻断归档
            notion_error = str(e)

    result = {
        "internal_id": internal_id,
        "action": "archive",
        "success": True,
        "from_mailbox": current_mailbox,
        "to_mailbox": _ARCHIVE_MAILBOX,
        "notion_updated": notion_updated,
        "notion_error": notion_error,
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(f"archived internal_id={internal_id}: {current_mailbox} → {_ARCHIVE_MAILBOX} "
              f"(notion_updated={notion_updated})")
    else:
        emit(cli, result)


# ============================================================
# Sprint 15: email flag — 写 SQLite intent + outbox 双 target
# ============================================================

@app.command("flag")
def email_flag(
    ctx: typer.Context,
    internal_id: Optional[int] = typer.Argument(
        None, help="单封 internal_id (与 --ids 互斥)",
    ),
    is_read: Optional[bool] = typer.Option(
        None, "--is-read/--no-is-read",
        help="标记已读 (true) / 未读 (false); 未指定 = 不动",
    ),
    is_flagged: Optional[bool] = typer.Option(
        None, "--is-flagged/--no-is-flagged",
        help="设置旗标 (true) / 取消旗标 (false); 未指定 = 不动",
    ),
    processing_status: Optional[str] = typer.Option(
        None, "--processing-status",
        help=(
            "Notion Processing Status 字段值 (如 已完成 / AI Reviewed). "
            "仅写 outbox(target=notion), SQLite 不存此字段"
        ),
    ),
    ids: Optional[str] = typer.Option(
        None, "--ids", help="逗号分隔批量: --ids 53674,53675,53677",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="只打 plan, 不写 SQLite / outbox; 跳过 auth + pm2 check",
    ),
    allow_concurrent: bool = typer.Option(
        False, "--allow-concurrent",
        help="跳过 PM2 mail-sync 冲突检测 (写命令默认拒并行)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """Sprint 15 SSoT inversion: 写 flag / processing_status intent 到 SQLite + outbox.

    前端 BatchActionBar / EmailRow flag 三态切换走本命令；intent 立即落 SQLite
    (echo prevention)，FanoutWorker (mail-sync 进程内) 异步派发到 Mail.app + Notion。

    target 互斥:
      - 位置参数 ``<internal_id>`` (单封)
      - ``--ids 1,2,3`` (列表批量)

    至少给一个 flag 改动: ``--is-read`` / ``--is-flagged`` / ``--processing-status``

    Source 标记为 'cli', 不触发 echo prevention; outbox 写双 target (mailapp + notion),
    FanoutWorker 异步派发。详见 SPRINT15-HANDOFF.md §3.3 (C) + .claude/plans/
    ultrathink-sprint-15-handoff*.md Stage 1.6。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    # 至少一个 flag 改动
    if is_read is None and is_flagged is None and processing_status is None:
        raise emit_cli_error(cli, CliInvalidArgError(
            "must give at least one of --is-read / --is-flagged / --processing-status",
            hint=(
                "Example: mailagent email flag 53675 --is-read --is-flagged "
                "--processing-status '已完成'"
            ),
        ))

    # target 解析（单封 vs --ids 互斥）
    if internal_id is None and ids is None:
        raise emit_cli_error(cli, CliInvalidArgError(
            "must give <internal_id> or --ids 1,2,3",
        ))
    if internal_id is not None and ids is not None:
        raise emit_cli_error(cli, CliInvalidArgError(
            "<internal_id> and --ids are mutually exclusive",
        ))
    if ids is not None:
        try:
            target_ids = _parse_id_list(ids)
        except CliError as e:
            raise emit_cli_error(cli, e)
    else:
        target_ids = [internal_id]  # type: ignore[list-item]

    # 构造完整 payload (fanout 自己挑相关字段)
    payload: dict = {}
    if is_read is not None:
        payload["is_read"] = is_read
    if is_flagged is not None:
        payload["is_flagged"] = is_flagged
    if processing_status is not None:
        payload["processing_status"] = processing_status

    # MailAppFanout 只读 is_read / is_flagged, processing_status 让它跳过
    mailapp_payload = {k: v for k, v in payload.items() if k in ("is_read", "is_flagged")}

    # dry-run: 跳过 auth + pm2; 直接 emit plan
    if dry_run:
        plan = {
            "dry_run": True,
            "internal_ids": target_ids,
            "payload": payload,
            "would_enqueue": [
                {
                    "internal_id": iid,
                    "mailapp_payload": mailapp_payload,
                    "notion_payload": payload,
                }
                for iid in target_ids
            ],
        }
        emit(cli, plan, meta_extra={"count": len(target_ids)})
        return

    # auth + pm2 check
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.cli.pm2_check import check_pm2_conflict
    try:
        check_pm2_conflict(cli, allow_concurrent=allow_concurrent)
    except CliError as e:
        raise emit_cli_error(cli, e)

    # 执行: 每封邮件写 SQLite (echo prevention) + outbox 双 target
    from src.sync.outbox import OutboxRepository

    repo = cli.email_repo
    sync_store = cli.sync_store  # 保证 v10 schema
    outbox_repo = OutboxRepository(cli.cli_config.sync_store_db_path)

    updated: list[int] = []
    outbox_entries: list[dict] = []
    not_found: list[int] = []

    for iid in target_ids:
        meta = repo.get_metadata(iid)
        if meta is None:
            not_found.append(iid)
            continue

        # 立即 update_local_flags 做 echo prevention.
        # Sprint 15 D 块: processing_status 也镜像到 SQLite (列已存在), 让前端
        # listEnriched 能立即读到 done 状态 (processing_status='已完成'),
        # 不需要等 fanout 派发 Notion 完成. None 时不动 SQLite 该字段.
        new_read = bool(is_read) if is_read is not None else bool(meta.is_read)
        new_flagged = bool(is_flagged) if is_flagged is not None else bool(meta.is_flagged)
        sync_store.update_local_flags(
            iid, new_read, new_flagged,
            processing_status=processing_status,
        )

        # outbox 双 target: mailapp + notion, source='cli'
        oid_mailapp = outbox_repo.enqueue(
            internal_id=iid,
            op_type="flag_sync",
            target="mailapp",
            payload=mailapp_payload,
            source="cli",
        ) if mailapp_payload else None
        oid_notion = outbox_repo.enqueue(
            internal_id=iid,
            op_type="flag_sync",
            target="notion",
            payload=payload,
            source="cli",
        )
        updated.append(iid)
        outbox_entries.append({
            "internal_id": iid,
            "mailapp_outbox_id": oid_mailapp,
            "notion_outbox_id": oid_notion,
        })

    data = {
        "dry_run": False,
        "updated_ids": updated,
        "payload": payload,
        "outbox_entries": outbox_entries,
    }
    if not_found:
        data["not_found"] = not_found

    emit(
        cli, data,
        meta_extra={"count": len(updated), "not_found_count": len(not_found)},
    )


# ─────────────────────────────────────────────────────────────────────────────
# email draft — 基于 Notion Reply Suggestion 创建回复草稿 (灵动岛 create_draft /
# quick_reply_* / decline_with_reason / nudge_recipient action handler 调本命令).
# 逻辑对齐 src/events/handlers.py::_create_draft_via_imap (davmail 路径), 但走
# CLI CliContext.backend.append_draft 统一接口 (davmail IMAP APPEND / applescript
# 内部 sh), 不区分 backend. 未抽共享函数是为隔离 handlers 生产路径 (无回归测试覆盖).
# ─────────────────────────────────────────────────────────────────────────────


def _split_addrs(addrs: str) -> list[str]:
    """split RFC 822 to/cc 字段提纯 email. 对齐 handlers._split_addrs (getaddresses
    正确处理 quoted display name + Outlook semicolon)."""
    if not addrs:
        return []
    from email.utils import getaddresses
    normalized = addrs.replace(";", ",")
    out: list[str] = []
    try:
        for _name, email in getaddresses([normalized]):
            email = (email or "").strip()
            if email:
                out.append(email)
    except Exception:
        # getaddresses 理论上不抛, 兜底逗号切
        out = [a.strip() for a in normalized.split(",") if a.strip()]
    return out


def _fetch_reply_suggestion_md(cli: "CliContext", internal_id: int) -> str:
    """从 SQLite ``llm_processing.labels_json`` 读 ``reply_suggestion_md`` (SSoT).

    **SQLite 是 reply_suggestion 的 SSoT** — LLM 生成后写 labels_json
    (mark_success); 用户在前端 / Notion 改 reply 后通过 upsert_external_labels
    回灌 labels_json. 所以这里读到的永远是最新版本 (含用户微调 / AI 对话改动),
    不读 Notion (Notion 退化为镜像).
    """
    import json as _json
    from src.llm_agent.store import LLMProcessingStore

    store = LLMProcessingStore(cli.cli_config.sync_store_db_path)
    row = store.get(internal_id)
    if not row:
        return ""
    raw = row.get("labels_json") or ""
    if not raw:
        return ""
    try:
        labels = _json.loads(raw)
    except (ValueError, TypeError):
        return ""
    if not isinstance(labels, dict):
        return ""
    return (labels.get("reply_suggestion_md") or "").strip()


def _reply_md_to_html(reply_md: str) -> str:
    """markdown reply_suggestion → HTML (复用 scripts/html_clipboard.md_to_html,
    跟 handlers._create_draft_via_imap markdown 路径同款)."""
    import os
    import sys
    scripts = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
        "scripts",
    )
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from html_clipboard import md_to_html
    return md_to_html(reply_md)


def _compose_reply_draft(
    record: dict,
    *,
    internal_id: int,
    mode: str,
    reply_text: str,
    reply_html: Optional[str],
    extra_to: Optional[str],
    extra_cc: Optional[str],
    to_override: Optional[str] = None,
    cc_override: Optional[str] = None,
    bcc: Optional[str] = None,
    subject_override: Optional[str] = None,
    forward_intro_text: Optional[str] = None,
    forward_intro_html: Optional[str] = None,
    attachments: Optional[list] = None,
):
    """从原邮件 metadata + reply 内容构造 DraftRequest.

    收件人语义:
    - ``to_override`` / ``cc_override`` 非 None → 权威完整列表 (前端 compose 用户编辑后的),
      不做推导也不叠加 extra.
    - 否则 reply/reply-all 推导原收件人 + ``extra_to``/``extra_cc`` 追加; forward 用
      ``extra_to`` 作收件人本体.
    ``bcc`` 总是直接 split. forward: Fwd: 前缀 + 独立邮件 (无 threading) + intro + 附件.
    """
    from src.config import config as _cfg
    from src.mail.backend import DraftRequest

    self_email = (_cfg.user_email or "").lower().strip()
    bcc_list = list(dict.fromkeys(_split_addrs(bcc or "")))
    orig_subj = record.get("subject", "") or ""

    if mode == "forward":
        if to_override is not None:
            to_list = list(dict.fromkeys(_split_addrs(to_override)))
            cc_list = list(dict.fromkeys(_split_addrs(cc_override or "")))
        else:
            to_list = list(dict.fromkeys(_split_addrs(extra_to or "")))
            cc_list = list(dict.fromkeys(_split_addrs(extra_cc or "")))
        subject = subject_override if subject_override is not None else (
            orig_subj if orig_subj.lower().startswith(("fwd:", "fw:")) else f"Fwd: {orig_subj}"
        )
        return DraftRequest(
            mode=mode,
            internal_id_for_threading=internal_id,
            to=to_list, cc=cc_list, bcc=bcc_list,
            subject=subject or "(no subject)",
            reply_text=reply_text or "",
            reply_html=reply_html,
            forward_intro_text=forward_intro_text,
            forward_intro_html=forward_intro_html,
            attachments=attachments or [],
        )

    if to_override is not None:
        # 前端 compose 传权威完整列表 — 不推导, 不叠加 extra.
        to_list = list(dict.fromkeys(_split_addrs(to_override)))
        cc_list = list(dict.fromkeys(_split_addrs(cc_override or "")))
    else:
        extra_to_list = _split_addrs(extra_to or "")
        extra_cc_list = _split_addrs(extra_cc or "")
        orig_from = (record.get("sender") or "").strip()
        orig_to = _split_addrs(record.get("to_addr") or "")
        orig_cc = _split_addrs(record.get("cc_addr") or "")
        if mode == "reply":
            to_list = [orig_from] if orig_from else []
            cc_list = []
        else:  # reply-all
            candidates = ([orig_from] if orig_from else []) + orig_to
            to_list = [a for a in candidates if a.lower() != self_email]
            cc_list = [a for a in orig_cc if a.lower() != self_email]
        to_list = list(dict.fromkeys(to_list + extra_to_list))  # dedup 保序
        cc_list = list(dict.fromkeys(cc_list + extra_cc_list))

    subject = subject_override if subject_override is not None else (
        orig_subj if orig_subj.lower().startswith("re:") else f"Re: {orig_subj}"
    )

    # In-Reply-To + References (Outlook 线程 fold)
    message_id = (record.get("message_id") or "").strip().strip("<>")
    in_reply_to: Optional[str] = None
    references: Optional[str] = None
    if message_id:
        in_reply_to = f"<{message_id}>"
        tid = (record.get("thread_id") or "").strip().strip("<>")
        chunks: list[str] = []
        if tid and tid != message_id:
            chunks.append(f"<{tid}>")
        chunks.append(in_reply_to)
        references = " ".join(chunks)

    return DraftRequest(
        mode=mode,
        internal_id_for_threading=internal_id,
        to=to_list, cc=cc_list, bcc=bcc_list,
        subject=subject or "(no subject)",
        reply_text=reply_text or "(rich text body)",
        reply_html=reply_html,
        in_reply_to=in_reply_to,
        references=references,
    )


# forward 附件总大小上限 (编码前). base64 膨胀 ~33%, Exchange 常见上限 25-35MB.
_MAX_FORWARD_ATTACH_BYTES = 20 * 1024 * 1024


def _build_forward_intro(
    record: dict, body_text: str, body_html: Optional[str]
) -> tuple[str, str]:
    """构造转发引用块 (plain + html): 原文 From/Date/Subject/To 摘要 + 正文."""
    import html as _html

    sender = (record.get("sender") or "").strip()
    date = (record.get("date_received") or "").strip()
    subj = (record.get("subject") or "").strip()
    to = (record.get("to_addr") or "").strip()

    intro_text = (
        "---------- Forwarded message ----------\n"
        f"From: {sender}\n"
        f"Date: {date}\n"
        f"Subject: {subj}\n"
        f"To: {to}\n\n"
        f"{body_text or ''}"
    )
    header_html = (
        '<div style="border-top:1px solid #ccc;margin-top:16px;padding-top:8px;'
        'color:#555;font-size:13px">'
        "---------- Forwarded message ----------<br>"
        f"From: {_html.escape(sender)}<br>"
        f"Date: {_html.escape(date)}<br>"
        f"Subject: {_html.escape(subj)}<br>"
        f"To: {_html.escape(to)}</div>"
    )
    intro_html = header_html + (body_html or f"<pre>{_html.escape(body_text or '')}</pre>")
    return intro_text, intro_html


def _build_reply_quote(
    record: dict, body_text: str, body_html: Optional[str]
) -> tuple[str, str]:
    """构造回复引用块 (plain + html): 像 Mail.app / Outlook 一样在回复正文下方附原邮件.

    与 forward 的 "Forwarded message" 头不同, reply 用 "在 <date>, <sender> 写道:" 头 +
    blockquote 包原文 (Outlook / Apple Mail 通用回复引用形态). 原邮件正文本身已含整条线程
    (Exchange 每次回复嵌套前文), 故引这一层即带上全部历史.
    """
    import html as _html

    sender = (record.get("sender") or "").strip()
    date = (record.get("date_received") or "").strip()

    intro_text = f"在 {date}，{sender} 写道：\n\n{body_text or ''}"
    header_html = (
        '<div style="color:#555;font-size:13px;margin-top:16px">'
        f"在 {_html.escape(date)}，{_html.escape(sender)} 写道：</div>"
    )
    quoted = body_html or f"<pre>{_html.escape(body_text or '')}</pre>"
    intro_html = (
        f"{header_html}"
        '<blockquote style="margin:8px 0 0;padding-left:12px;'
        'border-left:2px solid #ccc;color:#555">'
        f"{quoted}</blockquote>"
    )
    return intro_text, intro_html


def _collect_forward_attachments(
    cli: "CliContext", internal_id: int
) -> tuple[list, list[str]]:
    """读原邮件常规附件 (过滤 inline), 累计不超 cap. 返回 (attachments, warnings).

    inline 图片 (cid:) 默认不带 — forward_intro_html 是重拼的, cid 引用会失效 (已知限制).
    """
    out: list = []
    warnings: list[str] = []
    total = 0
    for a in cli.email_repo.get_attachments(internal_id):
        if a.is_inline:
            continue
        data = cli.email_repo.get_attachment_bytes(a.id)
        if not data:
            warnings.append(f"附件 {a.filename!r} 读取失败, 跳过")
            continue
        if total + len(data) > _MAX_FORWARD_ATTACH_BYTES:
            warnings.append(
                f"附件总大小超 {_MAX_FORWARD_ATTACH_BYTES // (1024 * 1024)}MB, "
                f"跳过 {a.filename!r} 及之后附件"
            )
            break
        total += len(data)
        out.append((a.filename, data, a.content_type or "application/octet-stream"))
    return out, warnings


def _prepare_draft(
    cli: "CliContext",
    *,
    internal_id: int,
    mode: str,
    extra_to: Optional[str],
    extra_cc: Optional[str],
    body_file: Optional[str],
    body_html_file: Optional[str] = None,
    to_override: Optional[str] = None,
    cc_override: Optional[str] = None,
    bcc: Optional[str] = None,
    subject_override: Optional[str] = None,
    allow_missing_reply: bool = False,
) -> tuple[Any, list[str]]:
    """构造 DraftRequest (draft + send 共用, 保证 '草稿预览 = 实际发送内容').

    收件人: --to/--cc (to_override/cc_override) 为前端 compose 权威完整列表; 否则
    reply* 推导 + extra, forward 用 --extra-to. 正文: --body-file 优先于 reply_suggestion_md;
    forward 正文可空 (纯转发原文). 出错抛 CliError 子类, 调用方 emit.
    """
    record = cli.sync_store.get(internal_id)
    if not record:
        raise CliNotFoundError(f"Email metadata not found for internal_id={internal_id}")

    # forward 收件人校验在命令层 (非 dry-run / send) 做, 让 dry-run 能预览 forward plan
    # (前端打开转发面板时收件人还空着, 需要 dry-run 拿 Fwd: 主题 + 引用正文预填).

    # 正文优先级: --body-html-file (前端 compose TipTap HTML, 零转换直用) >
    # --body-file (markdown) > SQLite reply_suggestion_md. forward 允许空 (纯转发).
    # explicit_body: 调用方传了完整正文 (前端 compose 发送 / 用户 --body-file)。
    # forward 时若已有显式正文, 引用块已在正文里 (dry-run 预填阶段拼进 editor 后随
    # --body-html-file 传回), 不能再单独构造 forward_intro — 否则 build_outgoing_mime
    # 会二次 append 导致引用块重复 (Bug: 前端转发发送/存草稿引用块出现两次)。
    explicit_body = bool(body_html_file or body_file)
    if body_html_file:
        from pathlib import Path

        from src.converter.html_to_markdown import html_to_markdown

        try:
            reply_html = Path(body_html_file).read_text(encoding="utf-8")
        except OSError as e:
            raise CliInvalidArgError(f"--body-html-file 读取失败: {e}")
        reply_text = html_to_markdown(reply_html) if reply_html.strip() else ""
    elif body_file:
        from pathlib import Path

        try:
            reply_text = Path(body_file).read_text(encoding="utf-8")
        except OSError as e:
            raise CliInvalidArgError(f"--body-file 读取失败: {e}")
        reply_html = _reply_md_to_html(reply_text) if reply_text.strip() else None
    else:
        reply_md = _fetch_reply_suggestion_md(cli, internal_id)
        # allow_missing_reply: dry-run 预填时放宽 — 收件人推导不依赖 LLM 建议,
        # 没建议也要能预填 reply/reply-all 的收件人 (正文留空让用户自己写)。否则
        # 整个 dry-run plan 失败, 前端连收件人都拿不到。真实 draft/send 仍要求有
        # 正文来源 (建议 / --body-file / --body-html-file), 避免误发空回复。
        if not reply_md and mode != "forward" and not allow_missing_reply:
            raise CliNotFoundError(
                f"Email {internal_id} 无 reply_suggestion (SQLite labels_json 空)",
                hint="先 mailagent llm run <id> 生成回复建议, 或用 --body-file 传正文",
            )
        reply_text = reply_md or ""
        reply_html = _reply_md_to_html(reply_md) if reply_md else None

    # 引用原邮件 (Mail.app / Outlook 行为: reply/reply-all/forward 都在正文下方附原文)。
    # 仅"无显式正文"时构造 — 显式正文 (前端 compose 发送, body_html_file) 已含预填引用,
    # 跳过避免二次拼接重复。forward 走 forward_intro_* 字段 (MIME build 时 append);
    # reply/reply-all 直接拼进 reply_text/reply_html, 这样 dry-run plan 的 reply_html 即
    # "suggestion + 引用", 前端预填零改动, 发送回传时 explicit_body 跳过重建。
    forward_intro_text = forward_intro_html = None
    attachments: list = []
    warnings: list[str] = []
    if mode == "forward":
        # 附件总是 server-side 重新收集 — 前端无法传字节, 必须按 internal_id 重读。
        attachments, warnings = _collect_forward_attachments(cli, internal_id)
        if not explicit_body:
            body_md = cli.email_repo.get_body_markdown(internal_id) or ""
            body_html = cli.email_repo.get_body_html(internal_id)
            forward_intro_text, forward_intro_html = _build_forward_intro(
                record, body_md, body_html
            )
    elif not explicit_body:  # reply / reply-all
        orig_md = cli.email_repo.get_body_markdown(internal_id) or ""
        orig_html = cli.email_repo.get_body_html(internal_id)
        if orig_md or orig_html:
            q_text, q_html = _build_reply_quote(record, orig_md, orig_html)
            reply_text = f"{reply_text}\n\n{q_text}" if reply_text.strip() else q_text
            reply_html = f"{reply_html}{q_html}" if reply_html else q_html

    draft = _compose_reply_draft(
        record, internal_id=internal_id, mode=mode,
        reply_text=reply_text, reply_html=reply_html,
        extra_to=extra_to, extra_cc=extra_cc,
        to_override=to_override, cc_override=cc_override, bcc=bcc,
        subject_override=subject_override,
        forward_intro_text=forward_intro_text,
        forward_intro_html=forward_intro_html,
        attachments=attachments,
    )
    return draft, warnings


@app.command("draft")
def email_draft(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="原邮件 internal_id"),
    mode: str = typer.Option(
        "reply-all", "--mode",
        help="reply-all (默认) / reply (仅回发件人) / forward (转发, 需 --extra-to)",
    ),
    extra_to: Optional[str] = typer.Option(
        None, "--extra-to", help="额外收件人 (逗号分隔); forward 模式下为收件人本体",
    ),
    extra_cc: Optional[str] = typer.Option(
        None, "--extra-cc", help="额外抄送 (逗号分隔)",
    ),
    body_file: Optional[str] = typer.Option(
        None, "--body-file",
        help="读用户编辑后的正文 (markdown), 优先于 SQLite reply_suggestion_md",
    ),
    body_html_file: Optional[str] = typer.Option(
        None, "--body-html-file",
        help="读用户编辑后的正文 (HTML, 前端 compose TipTap 输出), 优先于 --body-file",
    ),
    to: Optional[str] = typer.Option(
        None, "--to",
        help="完整收件人列表 (逗号分隔), 提供时覆盖推导 — 前端 compose 编辑后的权威列表",
    ),
    cc: Optional[str] = typer.Option(
        None, "--cc", help="完整抄送列表 (逗号分隔), 提供时覆盖推导",
    ),
    bcc: Optional[str] = typer.Option(
        None, "--bcc", help="密送列表 (逗号分隔, davmail 路径生效)",
    ),
    subject: Optional[str] = typer.Option(
        None, "--subject",
        help="完整主题 (提供时覆盖 Re:/Fwd: 自动前缀) — 前端 compose 编辑后的",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="只打 plan (收件人 + 正文预览), 不创建草稿",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """基于 Notion Reply Suggestion 创建邮件回复草稿.

    流程: internal_id → SQLite 查 metadata → Notion 读 ``Reply Suggestion``
    property → 构造 DraftRequest → ``backend.append_draft`` (davmail IMAP APPEND /
    applescript sh). 没 reply_suggestion → 提示先跑 ``mailagent llm run <id>``.

    灵动岛 (ping-island) ``create_draft`` / ``quick_reply_yes`` /
    ``quick_reply_no_with_reason`` / ``decline_with_reason`` / ``nudge_recipient``
    action handler 调本命令.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if mode not in ("reply-all", "reply", "forward"):
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--mode 必须是 reply-all / reply / forward, got {mode!r}",
        ))

    # 1-4. 构造 DraftRequest (收件人推导 / 正文 / forward 引用块 + 附件) — draft + send 共用
    try:
        draft, warnings = _prepare_draft(
            cli, internal_id=internal_id, mode=mode,
            extra_to=extra_to, extra_cc=extra_cc, body_file=body_file,
            body_html_file=body_html_file,
            to_override=to, cc_override=cc, bcc=bcc, subject_override=subject,
            # dry-run = 前端 compose 预填, 无 reply_suggestion 也要返回收件人。
            allow_missing_reply=dry_run,
        )
    except CliError as e:
        raise emit_cli_error(cli, e)

    if not dry_run and mode == "forward" and not draft.to:
        raise emit_cli_error(cli, CliInvalidArgError(
            "forward 模式必须指定收件人 (--extra-to 或 --to)",
        ))

    # 5. dry-run: 打 plan 不创建
    if dry_run:
        plan = {
            "internal_id": internal_id,
            "mode": mode,
            "to": draft.to,
            "cc": draft.cc,
            "bcc": draft.bcc,
            "subject": draft.subject,
            "reply_source": "body-file" if body_file else "sqlite:llm_processing.labels_json",
            # 完整字段供前端 compose 预填 (draftPlan = 预填单一数据源)
            "reply_text": draft.reply_text,
            "reply_html": draft.reply_html,
            "forward_intro_text": draft.forward_intro_text,
            "forward_intro_html": draft.forward_intro_html,
            # 摘要字段供 CLI text 模式展示
            "reply_text_preview": (draft.reply_text or "")[:120],
            "reply_html_len": len(draft.reply_html or ""),
            "in_reply_to": draft.in_reply_to,
            "attachments": len(draft.attachments),
            "forward_intro_preview": (draft.forward_intro_text or "")[:120],
            "warnings": warnings,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print("=== email draft plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:20} {value}")
        else:
            emit(cli, plan)
        return

    # 6. 写命令 auth
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    # 7. backend.append_draft (统一接口: davmail IMAP APPEND / applescript sh)
    result = cli.backend.append_draft(draft)
    if not result.success:
        raise emit_cli_error(cli, CliError(
            f"草稿创建失败: {result.error}",
        ))

    data = {
        "internal_id": internal_id,
        "success": True,
        "drafts_folder": result.drafts_folder,
        "appended_uid": result.appended_uid,
        "method": result.method,
        "mode": mode,
        "to_count": len(draft.to),
        "cc_count": len(draft.cc),
        "attachments": len(draft.attachments),
        "warnings": warnings,
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(
            f"draft created: folder={result.drafts_folder} "
            f"uid={result.appended_uid} to={len(draft.to)} cc={len(draft.cc)} "
            f"att={len(draft.attachments)}"
        )
    else:
        emit(cli, data)


@app.command("send")
def email_send(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="原邮件 internal_id"),
    mode: str = typer.Option(
        "reply-all", "--mode",
        help="reply-all (默认) / reply / forward (需 --extra-to)",
    ),
    extra_to: Optional[str] = typer.Option(
        None, "--extra-to", help="额外收件人 (逗号分隔); forward 模式下为收件人本体",
    ),
    extra_cc: Optional[str] = typer.Option(
        None, "--extra-cc", help="额外抄送 (逗号分隔)",
    ),
    body_file: Optional[str] = typer.Option(
        None, "--body-file",
        help="读用户编辑后的正文 (markdown), 优先于 SQLite reply_suggestion_md",
    ),
    body_html_file: Optional[str] = typer.Option(
        None, "--body-html-file",
        help="读用户编辑后的正文 (HTML, 前端 compose TipTap 输出), 优先于 --body-file",
    ),
    to: Optional[str] = typer.Option(
        None, "--to",
        help="完整收件人列表 (逗号分隔), 提供时覆盖推导 — 前端 compose 编辑后的权威列表",
    ),
    cc: Optional[str] = typer.Option(
        None, "--cc", help="完整抄送列表 (逗号分隔), 提供时覆盖推导",
    ),
    bcc: Optional[str] = typer.Option(
        None, "--bcc", help="密送列表 (逗号分隔, davmail 路径生效)",
    ),
    subject: Optional[str] = typer.Option(
        None, "--subject",
        help="完整主题 (提供时覆盖 Re:/Fwd: 自动前缀) — 前端 compose 编辑后的",
    ),
    yes: bool = typer.Option(
        False, "--yes", help="跳过二次确认直接发送 (前端确认对话框后传)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """真实发送邮件 (SMTP, 不可逆). 复用 draft 构造逻辑保证 '草稿预览 = 实际发送内容'.

    收件人/正文/附件来源同 ``email draft``. davmail 走 SMTP send_message; applescript
    fallback 也走 DavMail SMTP. 二次确认: ``--yes`` 跳过; text 模式交互 confirm;
    json 模式 (前端) 无 ``--yes`` 直接报错要求显式确认.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if mode not in ("reply-all", "reply", "forward"):
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--mode 必须是 reply-all / reply / forward, got {mode!r}",
        ))

    # 构造 DraftRequest (与 email draft 完全同源)
    try:
        draft, warnings = _prepare_draft(
            cli, internal_id=internal_id, mode=mode,
            extra_to=extra_to, extra_cc=extra_cc, body_file=body_file,
            body_html_file=body_html_file,
            to_override=to, cc_override=cc, bcc=bcc, subject_override=subject,
        )
    except CliError as e:
        raise emit_cli_error(cli, e)

    if mode == "forward" and not draft.to:
        raise emit_cli_error(cli, CliInvalidArgError(
            "forward 模式必须指定收件人 (--extra-to 或 --to)",
        ))

    # 写命令 auth
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    # 二次确认 (不可逆): --yes 跳过; text 交互 confirm; json (前端) 必须显式 --yes
    if not yes:
        if cli.output.lower() == "text":
            print(
                f"send plan: mode={mode} to={draft.to} cc={draft.cc} "
                f"subject={draft.subject!r}"
            )
            if not typer.confirm(
                f"确认发送给 {len(draft.to)} 位收件人? (SMTP 真实发出, 不可撤回)"
            ):
                emit(cli, {"internal_id": internal_id, "sent": False, "cancelled": True})
                return
        else:
            raise emit_cli_error(cli, CliInvalidArgError(
                "发送需二次确认: 加 --yes 显式发送",
                hint="前端应在确认对话框后传 --yes",
            ))

    result = cli.backend.send_email(draft)
    if not result.success:
        raise emit_cli_error(cli, CliError(f"邮件发送失败: {result.error}"))

    data = {
        "internal_id": internal_id,
        "sent": True,
        "mode": mode,
        "message_id": result.message_id,
        "archived_to_sent": result.archived_to_sent,
        "method": result.method,
        "to_count": len(draft.to),
        "cc_count": len(draft.cc),
        "attachments": len(draft.attachments),
        "warnings": warnings,
    }
    if cli.output.lower() == "text":
        print(
            f"sent: message_id={result.message_id} to={len(draft.to)} "
            f"cc={len(draft.cc)} archived_sent={result.archived_to_sent}"
        )
    else:
        emit(cli, data)


# ─────────────────────────────────────────────────────────────────────────────
# email unsubscribe — RFC 2369 / RFC 8058 一键退订 (灵动岛 archive_and_unsubscribe
# action handler 调本命令). 智能执行:
#   - 有 List-Unsubscribe-Post (One-Click) + https URI → httpx POST 自动退订
#   - 否则 https URI → open 浏览器让用户手动确认
#   - 否则 mailto URI → open 邮件客户端
#   - 无 List-Unsubscribe header → method=none (仅 archive, 不报错)
# raw MIME 经 backend.arm.fetch_email_content_by_id 重抽 (email_body 不存原文).
# ─────────────────────────────────────────────────────────────────────────────


# scheme 白名单 — 其他 scheme (javascript:/data:/ftp: 等) 一律丢弃 (安全硬约束)
_UNSUB_ALLOWED_SCHEMES = ("https", "mailto")


def _parse_list_unsubscribe(value: str) -> list[str]:
    """解析 ``List-Unsubscribe`` header → 尖括号 URI 列表 (RFC 2369).

    形如 ``<https://example.com/unsub?token=x>, <mailto:unsub@example.com>``。
    逗号分隔 + 尖括号包裹; 只保留 scheme 在白名单 (https/mailto) 内的 URI,
    其他 (http/javascript/data/...) 丢弃 (安全硬约束: 不退化 http, 不开放未知 scheme)。
    """
    if not value:
        return []
    import re

    out: list[str] = []
    for m in re.finditer(r"<([^>]+)>", value):
        uri = m.group(1).strip()
        if not uri:
            continue
        scheme = uri.split(":", 1)[0].lower() if ":" in uri else ""
        if scheme in _UNSUB_ALLOWED_SCHEMES:
            out.append(uri)
    return out


def _is_one_click(list_unsubscribe_post: Optional[str]) -> bool:
    """``List-Unsubscribe-Post`` 值是否声明 RFC 8058 One-Click (大小写不敏感)。"""
    if not list_unsubscribe_post:
        return False
    return "list-unsubscribe=one-click" in list_unsubscribe_post.lower()


def _pick_unsubscribe_method(
    uris: list[str], one_click: bool,
) -> tuple[str, Optional[str]]:
    """从 URI 列表 + one-click 标志决策 (method, target_uri)。

    返回 method ∈ {one_click_post, open_url, open_mailto, none}:
      - one_click_post: one_click=True 且有 https URI → POST 到该 https URI
      - open_url:       有 https URI (无 one-click) → open 浏览器
      - open_mailto:    只有 mailto URI → open 邮件客户端
      - none:           无可用 URI
    """
    https_uri = next((u for u in uris if u.lower().startswith("https:")), None)
    mailto_uri = next((u for u in uris if u.lower().startswith("mailto:")), None)
    if one_click and https_uri:
        return "one_click_post", https_uri
    if https_uri:
        return "open_url", https_uri
    if mailto_uri:
        return "open_mailto", mailto_uri
    return "none", None


def _post_one_click(url: str) -> tuple[Optional[int], Optional[str]]:
    """RFC 8058 One-Click POST — body=``List-Unsubscribe=One-Click``。

    返回 ``(http_status, error)``: 成功 (2xx) → (status, None); 非 2xx →
    (status, "..."); 超时 / 网络异常 → (None, "...")。**不抛** —— 退订失败仍可 mark_done。
    安全: 仅 https (调用方已保证); ``follow_redirects=False`` 防钓鱼跳转。
    """
    import httpx

    try:
        with httpx.Client(timeout=10.0, follow_redirects=False) as client:
            resp = client.post(
                url,
                content="List-Unsubscribe=One-Click",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        status = resp.status_code
        if 200 <= status < 300:
            return status, None
        return status, f"unsubscribe endpoint returned HTTP {status}"
    except Exception as e:  # noqa: BLE001 — 超时 / 连接错 / 协议错都降级
        return None, f"{type(e).__name__}: {e}"


def _run_open(target: str) -> bool:
    """macOS ``open <target>`` 拉起浏览器 / 邮件客户端。失败仅返回 False, 不抛。"""
    import subprocess

    try:
        subprocess.run(
            ["open", target],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception:  # noqa: BLE001
        return False


def _mark_done_via_outbox(cli: "CliContext", internal_id: int) -> bool:
    """复用 email flag 路径标完成 (写 SQLite + outbox notion 'Processing Status=已完成')。

    跟 ``email flag --processing-status 已完成`` 同口径 (Sprint 15 SSoT inversion)。
    metadata 不存在 → 返回 False (调用方已先校验存在, 这里防御)。
    """
    from src.sync.outbox import OutboxRepository

    repo = cli.email_repo
    meta = repo.get_metadata(internal_id)
    if meta is None:
        return False

    sync_store = cli.sync_store  # 保证 v10 schema
    sync_store.update_local_flags(
        internal_id,
        bool(meta.is_read),
        bool(meta.is_flagged),
        processing_status="已完成",
    )
    outbox_repo = OutboxRepository(cli.cli_config.sync_store_db_path)
    outbox_repo.enqueue(
        internal_id=internal_id,
        op_type="flag_sync",
        target="notion",
        payload={"processing_status": "已完成"},
        source="cli",
    )
    return True


@app.command("unsubscribe")
def email_unsubscribe(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="只解析 + 打 plan (method/url), 不 POST 不 open 不 mark_done",
    ),
    no_mark_done: bool = typer.Option(
        False, "--no-mark-done",
        help="退订后不标记邮件完成 (默认退订 + mark_done)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """归档并退订 — 解析 List-Unsubscribe header 智能执行 (RFC 2369 / RFC 8058).

    流程: internal_id → SQLite 查 mailbox → backend 重抽 raw MIME →
    解析 ``List-Unsubscribe`` (+ ``List-Unsubscribe-Post``) →
    智能执行:
      - One-Click POST (有 https URI + List-Unsubscribe-Post=One-Click) → httpx POST
      - open URL (有 https URI) → 浏览器手动确认
      - open mailto (只有 mailto URI) → 邮件客户端
      - none (无 List-Unsubscribe) → 仅归档不报错
    默认退订后标记邮件完成 (--no-mark-done 跳过)。

    灵动岛 (ping-island) ``archive_and_unsubscribe`` action handler 调本命令。

    安全: POST 仅 https + ``follow_redirects=False``; URI scheme 白名单 https/mailto;
    POST 失败 (超时 / 非 2xx / 异常) 不崩, data.error 标降级提示, 仍可 mark_done。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    # 1. metadata → mailbox (raw MIME 重抽需要 mailbox 定位)
    meta = cli.email_repo.get_metadata(internal_id)
    if meta is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email metadata not found for internal_id={internal_id}",
        ))
    mailbox = meta.mailbox or "收件箱"

    # 2. backend 重抽 raw MIME (email_body 表只存 sha256, 不存原文)
    try:
        full = cli.backend.arm.fetch_email_content_by_id(internal_id, mailbox)
    except Exception as e:  # noqa: BLE001
        raise emit_cli_error(cli, CliNotFoundError(
            f"Backend fetch failed for internal_id={internal_id}: {e}",
            hint="Mail.app / davmail 不可达 / mailbox 不存在 / FDA 权限缺",
        ))
    source = (full or {}).get("source", "") or ""
    if not source:
        raise emit_cli_error(cli, CliNotFoundError(
            f"No MIME source returned for internal_id={internal_id}",
            hint="邮件可能已删除 / backend 不可达",
        ))

    # 3. 解析 List-Unsubscribe (+ List-Unsubscribe-Post) header
    import email as _email
    from email import policy as _policy

    msg = _email.message_from_string(source, policy=_policy.default)
    list_unsub = msg.get("List-Unsubscribe", "") or ""
    list_unsub_post = msg.get("List-Unsubscribe-Post", "") or ""
    uris = _parse_list_unsubscribe(list_unsub)
    one_click = _is_one_click(list_unsub_post)
    method, target_uri = _pick_unsubscribe_method(uris, one_click)

    # 4. dry-run: 只打 plan, 不执行
    if dry_run:
        plan = {
            "internal_id": internal_id,
            "method": method,
            "unsubscribe_url": target_uri,
            "marked_done": False,
            "dry_run": True,
        }
        if cli.output.lower() == "text":
            print("=== email unsubscribe plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:18} {value}")
        else:
            emit(cli, plan)
        return

    # 5. 写命令 auth (退订 + mark_done 都是写操作)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    # 6. 执行退订
    http_status: Optional[int] = None
    error: Optional[str] = None
    if method == "one_click_post":
        http_status, error = _post_one_click(target_uri)  # type: ignore[arg-type]
    elif method in ("open_url", "open_mailto"):
        if not _run_open(target_uri):  # type: ignore[arg-type]
            error = "open command failed"
    # method == "none": 仅归档, 无退订动作

    # 7. mark_done (默认; --no-mark-done 跳过). 退订失败仍 mark_done (用户意图是归档).
    marked_done = False
    if not no_mark_done:
        marked_done = _mark_done_via_outbox(cli, internal_id)

    data = {
        "internal_id": internal_id,
        "method": method,
        "unsubscribe_url": target_uri,
        "http_status": http_status,
        "marked_done": marked_done,
        "dry_run": False,
    }
    if error:
        # 降级提示: 自动退订失败时引导用户手动操作
        data["error"] = error
        if target_uri and target_uri.lower().startswith("https:"):
            data["fallback_hint"] = f"自动退订失败, 可手动打开: {target_uri}"

    if cli.output.lower() == "text":
        print(
            f"unsubscribe method={method} url={target_uri or '-'} "
            f"http_status={http_status} marked_done={marked_done}"
        )
        if error:
            print(f"  error: {error}")
    else:
        emit(cli, data)
