"""mailagent email — CRUD / 搜索 / 重传 (RFC v2 §4.2).

US-003: get / body
US-004: list / search (text / json / ndjson)
US-005: resync (单封 + dry-run, 含 auth)
"""

from __future__ import annotations

import asyncio
import sys
from typing import Optional, TYPE_CHECKING

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
