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
from src.services import wire
from src.services.errors import ServiceError

if TYPE_CHECKING:
    from src.cli.context import CliContext

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


# wire dict 投影 (meta_to_dict / body_summary / attachment_to_dict /
# meta_record_to_list_item) → src/services/wire.py (D2a 去重, CLI + API 共用单一真源)。


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
        data = wire.meta_to_dict(full.metadata)
        data["body"] = wire.body_summary(full.body) if "body" in parts else None
        data["attachments"] = (
            [wire.attachment_to_dict(a) for a in full.attachments]
            if "attachments" in parts else []
        )
    else:
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise emit_cli_error(cli, CliNotFoundError(
                f"Email with internal_id={internal_id} not found",
                hint="Use 'mailagent email list' to find available IDs",
            ))
        data = wire.meta_to_dict(meta)
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

    data = [wire.meta_record_to_list_item(r) for r in rows]
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

    # Single-id 走 service (auth + pm2 下沉到 MailWriteService; dry-run 跳过)
    if batch_ids is None:
        return _resync_single(
            cli, internal_id,  # type: ignore[arg-type]
            dry_run=dry_run,
            replace_existing=replace_existing,
            no_parent=no_parent,
            allow_concurrent=allow_concurrent,
        )

    # Batch 模式: 命令体做 auth + pm2 (batch 走 LongTaskContext, 不经 service; dry-run 跳过)
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        from src.cli.pm2_check import check_pm2_conflict
        try:
            check_pm2_conflict(cli, allow_concurrent=allow_concurrent)
        except CliError as e:
            raise emit_cli_error(cli, e)

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
    allow_concurrent: bool,
) -> None:
    """PR-2 单封 resync 路径 —— A2 退化成调 ``MailWriteService`` (编排 + auth/pm2 下沉)."""
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    svc = MailWriteService(cli)

    if dry_run:
        try:
            plan = svc.plan_resync(
                internal_id,
                replace_existing=replace_existing,
                skip_parent_lookup=no_parent,
            )
        except ServiceError as e:
            raise emit_cli_error(cli, e)
        if cli.output.lower() == "text":
            print("=== resync plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:24} {value}")
        else:
            emit(cli, plan)
        return

    # 写鉴权: token 校验留在 CLI 侧 (require_auth → exit 4); 通过后构造已鉴权 Actor 交
    # service。service 内部 require_write_auth(actor) + check_pm2_conflict(allow_concurrent)。
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    try:
        result = svc.resync(
            internal_id,
            replace_existing=replace_existing,
            skip_parent_lookup=no_parent,
            actor=Actor(kind="cli", authenticated=True, label="cli"),
            allow_concurrent=allow_concurrent,
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)

    data = {
        "internal_id": result.internal_id,
        "old_page_id": result.old_page_id,
        "new_page_id": result.new_page_id,
        "archived_page_id": result.archived_page_id,
        "action": result.action,
        "dry_run": False,
    }

    if cli.output.lower() == "text":
        print(
            f"resync {result.action}: internal_id={result.internal_id} "
            f"new_page={result.new_page_id}"
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


def _run_pin(cli: "CliContext", internal_id: int, *, pinned: bool, dry_run: bool) -> None:
    """pin / unpin 共享退化体 (A3: 编排 + 守卫下沉 MailWriteService)。

    dry-run 走 ``plan_pin`` (无 auth/写); 执行先 ``cli.require_auth()`` (token, exit 4)
    再 ``set_pin`` (service 内 ``require_write_auth`` + ensure v8 schema)。
    """
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    svc = MailWriteService(cli)
    if dry_run:
        try:
            plan = svc.plan_pin(internal_id, pinned=pinned)
        except ServiceError as e:
            raise emit_cli_error(cli, e)
        _emit_pin_result(
            cli,
            internal_id=internal_id,
            pinned=plan["is_pinned"],
            changed=plan["changed"],
            dry_run=True,
        )
        return

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    try:
        result = svc.set_pin(
            internal_id,
            pinned=pinned,
            actor=Actor(kind="cli", authenticated=True, label="cli"),
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)
    _emit_pin_result(
        cli,
        internal_id=result.internal_id,
        pinned=result.is_pinned,
        changed=result.changed,
        dry_run=False,
    )


@app.command("pin")
def email_pin(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只显示将要发生的状态, 不写 SQLite"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """置顶邮件（写 email_metadata.is_pinned=1 + pinned_at=now）。

    Mail.app 没有 pin 概念；该字段仅作本地 / 前端持久化，pm2 mail-sync 主进程不读不写它。
    Electron 也走同一份 SQLite，所以 CLI 改完前端 5s 内 refetch 自动看到。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _run_pin(cli, internal_id, pinned=True, dry_run=dry_run)


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
    _run_pin(cli, internal_id, pinned=False, dry_run=dry_run)


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
# A3: 编排 + IMAP/Notion helper + 守卫下沉 src/services/mail_write.py::MailWriteService。
# ============================================================


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
    附件 / Notion 页 (仅改 Mailbox 标签, 可逆)。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    svc = MailWriteService(cli)
    if dry_run:
        try:
            plan = svc.plan_archive(internal_id)
        except ServiceError as e:
            raise emit_cli_error(cli, e)
        if cli.output.lower() == "text":
            print("=== email archive plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:16} {value}")
        else:
            emit(cli, plan)
        return

    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    try:
        result = svc.archive(
            internal_id,
            actor=Actor(kind="cli", authenticated=True, label="cli"),
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)

    data = {
        "internal_id": result.internal_id,
        "action": "archive",
        "success": True,
        "from_mailbox": result.from_mailbox,
        "to_mailbox": result.to_mailbox,
        "notion_updated": result.notion_updated,
        "notion_error": result.notion_error,
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(f"archived internal_id={result.internal_id}: {result.from_mailbox} → "
              f"{result.to_mailbox} (notion_updated={result.notion_updated})")
    else:
        emit(cli, data)


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

    # A2: 编排 + 守卫下沉到 MailWriteService; 命令体只解析 target + 调 service + 格式化。
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    svc = MailWriteService(cli)

    # dry-run: 跳过 auth + pm2; plan_flags 纯预览 (CLI + serve-api 共用同一份)
    if dry_run:
        plan = svc.plan_flags(
            target_ids,
            is_read=is_read,
            is_flagged=is_flagged,
            processing_status=processing_status,
        )
        emit(cli, plan, meta_extra={"count": len(target_ids)})
        return

    # 写鉴权: token 校验留在 CLI 侧 (require_auth → exit 4); 通过后构造已鉴权 Actor。
    # service 内部 require_write_auth(actor) + check_pm2_conflict(allow_concurrent)。
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    try:
        result = svc.set_flags(
            target_ids,
            is_read=is_read,
            is_flagged=is_flagged,
            processing_status=processing_status,
            actor=Actor(kind="cli", authenticated=True, label="cli"),
            allow_concurrent=allow_concurrent,
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)

    data = {
        "dry_run": False,
        "updated_ids": result.updated_ids,
        "payload": result.payload,
        "outbox_entries": result.outbox_entries,
    }
    if result.not_found:
        data["not_found"] = result.not_found

    emit(
        cli, data,
        meta_extra={
            "count": len(result.updated_ids),
            "not_found_count": len(result.not_found),
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# email draft — 基于 Notion Reply Suggestion 创建回复草稿 (灵动岛 create_draft /
# quick_reply_* / decline_with_reason / nudge_recipient action handler 调本命令).
# 逻辑对齐 src/events/handlers.py::_create_draft_via_imap (davmail 路径), 但走
# CLI CliContext.backend.append_draft 统一接口 (davmail IMAP APPEND / applescript
# 内部 sh), 不区分 backend. 未抽共享函数是为隔离 handlers 生产路径 (无回归测试覆盖).
# ─────────────────────────────────────────────────────────────────────────────
# A4: compose 编排 + 守卫下沉 MailWriteService (compose_plan / compose_draft / send);
# 命令体退化成「读 body 文件成字符串 → 调 service → 格式化」, service 不碰文件系统。


def _build_compose_request(
    *,
    internal_id: int,
    mode: str,
    extra_to: Optional[str],
    extra_cc: Optional[str],
    body_file: Optional[str],
    body_html_file: Optional[str],
    to: Optional[str],
    cc: Optional[str],
    bcc: Optional[str],
    subject: Optional[str],
) -> Any:
    """读 ``--body-file`` / ``--body-html-file`` 成字符串, 构造 ``ComposeRequest``。

    service 接字符串正文 (不碰文件系统); body_html_file 优先于 body_file (对齐旧
    ``_prepare_draft`` 优先级)。读取失败抛 ``CliInvalidArgError``, 调用方 emit。
    """
    from pathlib import Path

    from src.services.mail_write import ComposeRequest

    body_text = body_html = None
    if body_html_file:
        try:
            body_html = Path(body_html_file).read_text(encoding="utf-8")
        except OSError as e:
            raise CliInvalidArgError(f"--body-html-file 读取失败: {e}")
    elif body_file:
        try:
            body_text = Path(body_file).read_text(encoding="utf-8")
        except OSError as e:
            raise CliInvalidArgError(f"--body-file 读取失败: {e}")
    return ComposeRequest(
        internal_id=internal_id, mode=mode,
        extra_to=extra_to, extra_cc=extra_cc,
        body_text=body_text, body_html=body_html,
        to=to, cc=cc, bcc=bcc, subject=subject,
    )


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

    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    # 读 body 文件成字符串 (service 不碰文件系统) + 构造 transport-neutral request。
    try:
        request = _build_compose_request(
            internal_id=internal_id, mode=mode,
            extra_to=extra_to, extra_cc=extra_cc,
            body_file=body_file, body_html_file=body_html_file,
            to=to, cc=cc, bcc=bcc, subject=subject,
        )
    except CliError as e:
        raise emit_cli_error(cli, e)

    svc = MailWriteService(cli)

    # dry-run: compose_plan 预填 (无 auth; allow_missing_reply + split_quote 内置)。
    if dry_run:
        try:
            plan = svc.compose_plan(request)
        except ServiceError as e:
            raise emit_cli_error(cli, e)
        if cli.output.lower() == "text":
            print("=== email draft plan (dry-run) ===")
            for key, value in plan.items():
                print(f"{key:20} {value}")
        else:
            emit(cli, plan)
        return

    # 写鉴权: compose 业务校验 (NotFound / forward 收件人) 必须**先于** auth —— execute 路径
    # 契约 (见 test_draft_forward_requires_extra_to / test_draft_real_no_reply_suggestion_errors)。
    # 故不提前 raise, 把 token 结果作 actor.authenticated 传给 service; service 在业务校验后
    # require_write_auth(actor) (未鉴权 → E_AUTH_FAILED, exit 4, 与 CLI require_auth 一致)。
    try:
        cli.require_auth()
        authed = True
    except CliError:
        authed = False
    try:
        result = svc.compose_draft(
            request, actor=Actor(kind="cli", authenticated=authed, label="cli"),
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)

    data = {
        "internal_id": result.internal_id,
        "success": True,
        "drafts_folder": result.drafts_folder,
        "appended_uid": result.appended_uid,
        "method": result.method,
        "mode": result.mode,
        "to_count": result.to_count,
        "cc_count": result.cc_count,
        "attachments": result.attachments,
        "warnings": result.warnings,
        "dry_run": False,
    }
    if cli.output.lower() == "text":
        print(
            f"draft created: folder={result.drafts_folder} "
            f"uid={result.appended_uid} to={result.to_count} cc={result.cc_count} "
            f"att={result.attachments}"
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

    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    # 读 body 文件成字符串 + 构造 request (与 email draft 完全同源, service 保 '草稿预览 =
    # 实际发送内容'); send 不拆引用块 (compose_draft/send 内 split_quote=False)。
    try:
        request = _build_compose_request(
            internal_id=internal_id, mode=mode,
            extra_to=extra_to, extra_cc=extra_cc,
            body_file=body_file, body_html_file=body_html_file,
            to=to, cc=cc, bcc=bcc, subject=subject,
        )
    except CliError as e:
        raise emit_cli_error(cli, e)

    svc = MailWriteService(cli)

    # 写鉴权: 同 email_draft —— 业务校验先于 auth, token 结果作 actor.authenticated 透传。
    try:
        cli.require_auth()
        authed = True
    except CliError:
        authed = False

    # 二次确认 (不可逆): --yes 跳过; text 模式交互 confirm (需 to/cc/subject → compose_plan
    # 预览); confirmed 透传给 service.send —— json 模式无 --yes → confirmed=False → service
    # 报 E_INVALID_ARG (确认 UI 留前端)。
    # 已知边缘 (text 交互 only): compose_plan 用 allow_missing_reply=True 预览, 故无
    # reply_suggestion 时先弹确认、确认后才由 svc.send 报 E_NOT_FOUND (旧版确认前报)。前端
    # json 路径 (恒 --yes / confirmed=True) + ping-island 不受影响。
    confirmed = yes
    if not yes and cli.output.lower() == "text":
        try:
            plan = svc.compose_plan(request)
        except ServiceError as e:
            raise emit_cli_error(cli, e)
        print(
            f"send plan: mode={mode} to={plan['to']} cc={plan['cc']} "
            f"subject={plan['subject']!r}"
        )
        if not typer.confirm(
            f"确认发送给 {len(plan['to'])} 位收件人? (SMTP 真实发出, 不可撤回)"
        ):
            emit(cli, {"internal_id": internal_id, "sent": False, "cancelled": True})
            return
        confirmed = True

    try:
        result = svc.send(
            request, actor=Actor(kind="cli", authenticated=authed, label="cli"),
            confirmed=confirmed,
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)

    data = {
        "internal_id": result.internal_id,
        "sent": True,
        "mode": result.mode,
        "message_id": result.message_id,
        "archived_to_sent": result.archived_to_sent,
        "method": result.method,
        "to_count": result.to_count,
        "cc_count": result.cc_count,
        "attachments": result.attachments,
        "warnings": result.warnings,
    }
    if cli.output.lower() == "text":
        print(
            f"sent: message_id={result.message_id} to={result.to_count} "
            f"cc={result.cc_count} archived_sent={result.archived_to_sent}"
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
