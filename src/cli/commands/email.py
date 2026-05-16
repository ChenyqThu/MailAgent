"""mailagent email — CRUD / 搜索 / 重传 (RFC v2 §4.2).

US-003: get / body
US-004: list / search (text / json / ndjson)
US-005: resync (单封 + dry-run, 含 auth)
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import asdict
from typing import Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliNotFoundError
from src.cli.output import emit, emit_cli_error, emit_error

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.repository import (
        AttachmentRecord,
        EmailBodyRecord,
        EmailFull,
        EmailMetadataRecord,
    )

app = typer.Typer(name="email", help="邮件 CRUD / 搜索 / 重传", no_args_is_help=True)


def _apply_local_output(ctx: typer.Context, output: Optional[str]) -> None:
    """允许 `-o json` 写在 leaf command 后 (gh/kubectl 风格).

    parent typer App 的全局 -o 只在 subcommand **之前** 生效;
    每个 leaf 暴露同名 flag, 若用户在 leaf 后传则覆盖 ctx.obj.output。
    """
    if output is not None and ctx.obj is not None:
        ctx.obj.output = output


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
            hint="可能未经 v4 双写; 跑 scripts/backfill_email_body.py 回填",
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

    filters: dict = {}
    if mailbox:
        filters["mailbox"] = mailbox
    if from_:
        filters["from"] = from_
    if subject_substr:
        filters["subject"] = subject_substr
    if since:
        filters["date_from"] = since
    if until:
        filters["date_to"] = until
    if is_read_bool is not None:
        filters["is_read"] = is_read_bool
    if is_flagged_bool is not None:
        filters["is_flagged"] = is_flagged_bool
    if has_notion_bool is not None:
        filters["has_notion"] = has_notion_bool

    sync_store = cli.sync_store
    # sync_store.search_emails caps limit at 50 internally — for PR-2 we accept
    # this. Wider list 需走 paging (offset)。
    result = sync_store.search_emails(filters=filters, limit=limit, offset=offset)
    rows = result.get("emails", [])

    # 后置过滤 status (sync_store.search_emails 默认锁 synced/pending)
    if status:
        rows = [r for r in rows if r.get("sync_status") == status]

    data = [_row_to_list_item(r) for r in rows]
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


def _row_to_list_item(row: dict) -> dict:
    """sync_store row dict → list 输出 item."""
    page_id = row.get("notion_page_id")
    notion_url = (
        f"https://www.notion.so/{page_id.replace('-', '')}"
        if page_id else None
    )
    return {
        "internal_id": row.get("internal_id"),
        "message_id": row.get("message_id"),
        "thread_id": row.get("thread_id"),
        "subject": row.get("subject") or "",
        "sender": row.get("sender") or "",
        "sender_name": row.get("sender_name"),
        "date_received": row.get("date_received"),
        "mailbox": row.get("mailbox"),
        "is_read": bool(row.get("is_read")),
        "is_flagged": bool(row.get("is_flagged")),
        "sync_status": row.get("sync_status"),
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
    query: str = typer.Argument(..., help="FTS5 query 语法"),
    mailbox: Optional[str] = typer.Option(None, "--mailbox"),
    since: Optional[str] = typer.Option(None, "--since", help="YYYY-MM-DD"),
    until: Optional[str] = typer.Option(None, "--until", help="YYYY-MM-DD"),
    limit: int = typer.Option(SEARCH_LIMIT_DEFAULT, "--limit"),
    no_snippet: bool = typer.Option(False, "--no-snippet"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """FTS5 全文搜索邮件正文 + subject + sender (RFC §4.2 / §7.2)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if limit <= 0 or limit > SEARCH_LIMIT_MAX:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be in (0, {SEARCH_LIMIT_MAX}], got {limit}"
        ))

    repo = cli.email_repo
    hits = repo.search_email_bodies(
        query,
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
        "total_hits": len(data),
        "limit": limit,
        "count": len(data),
    }

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
