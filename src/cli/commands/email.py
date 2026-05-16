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
