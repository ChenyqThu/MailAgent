"""mailagent attachment — 附件 list / download / derive (RFC v2 §4.3).

PR-3 US-001:
    list      列出邮件的所有附件 (含 derived).
    download  下载附件二进制到 --dest, 或 stdout.
    derive    Deprecated alias for `backfill derivatives --internal-id N`.

US-002:
    cleanup-orphans  扫盘上没有对应 email_metadata 的孤儿目录 (写操作).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliNotFoundError,
)
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error
from src.services import wire

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="attachment",
    help="附件 list / download / derive / cleanup-orphans (RFC §4.3)",
    no_args_is_help=True,
)


# ============================================================
# list (US-001)
# ============================================================

# 附件 wire dict (含 internal_id) → wire.attachment_to_dict(include_internal_id=True)
# (D2a 去重; email get 内嵌附件用默认形不含 internal_id, gotcha #1)。


@app.command("list")
def attachment_list(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出该邮件的所有附件 (含 derived); 排序: is_inline DESC, id ASC."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    repo = cli.email_repo
    # 先校验 metadata 存在 (避免 internal_id 笔误时给出零条而不是 not-found)
    if repo.get_metadata(internal_id) is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Email with internal_id={internal_id} not found",
            hint="Use 'mailagent email list' to find available IDs",
        ))

    rows = repo.get_attachments(internal_id)
    data = [wire.attachment_to_dict(r, include_internal_id=True) for r in rows]
    meta_extra = {"count": len(data), "internal_id": internal_id}

    if cli.output.lower() == "text":
        _render_list_text(internal_id, data)
    else:
        emit(cli, data, meta_extra=meta_extra)


def _render_list_text(internal_id: int, data: list[dict]) -> None:
    if not data:
        print(f"(no attachments for internal_id={internal_id})")
        return
    try:
        from rich.console import Console
        from rich.table import Table

        table = Table(show_lines=False)
        table.add_column("id", justify="right")
        table.add_column("filename", overflow="fold")
        table.add_column("size", justify="right")
        table.add_column("type")
        table.add_column("inline")
        table.add_column("derived")
        table.add_column("notion")
        for row in data:
            derived = (
                f"<{row['derived_from']}:{row['derived_format']}"
                if row["derived_from"] else ""
            )
            table.add_row(
                str(row["id"]),
                (row["filename"] or "")[:50],
                str(row["size_bytes"] or ""),
                (row["content_type"] or "")[:25],
                "*" if row["is_inline"] else "",
                derived,
                "uploaded" if row["notion_file_id"] else "",
            )
        Console().print(table)
    except Exception:
        for row in data:
            print(
                f"{row['id']}\t{(row['filename'] or '')[:50]}\t"
                f"{row['size_bytes']}\t{row['content_type']}\t"
                f"{'inline' if row['is_inline'] else 'attach'}"
            )


# ============================================================
# download (US-001)
# ============================================================

@app.command("download")
def attachment_download(
    ctx: typer.Context,
    attachment_id: int = typer.Argument(..., help="email_attachment.id"),
    dest: Optional[str] = typer.Option(
        None, "--dest", help="写入路径 (默认 stdout 二进制)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """下载附件二进制. 默认 stdout 流; --dest 写文件 + 返回 JSON 元信息."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    repo = cli.email_repo
    # 查 attachment row 用低层 sqlite (repo 没暴露 get_attachment by id 单查 API)
    cfg = cli.cli_config
    conn = sqlite3.connect(cfg.sync_store_db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """SELECT id, internal_id, filename, size_bytes, content_type,
                      is_inline, local_path, sha256
               FROM email_attachment WHERE id = ?""",
            (attachment_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Attachment id={attachment_id} not found",
            hint="Use 'mailagent attachment list <internal_id>' to find IDs",
        ))

    content = repo.get_attachment_bytes(attachment_id)
    if content is None:
        raise emit_cli_error(cli, CliNotFoundError(
            f"Attachment file missing on disk for id={attachment_id} "
            f"(local_path={row['local_path']})",
            hint="附件文件已被删除或路径错位; 重新跑 sync 拉回",
        ))

    sha = row["sha256"]

    if dest is None:
        # 二进制走 stdout — 用户应当重定向 (`> file.bin`)
        # 不能 emit JSON wrapper (会污染二进制流)
        try:
            sys.stdout.buffer.write(content)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, AttributeError):
            # 测试模式或 pipe 关闭 — 退到 text 写
            try:
                sys.stdout.write(content.decode("latin-1", errors="replace"))
            except Exception:
                pass
        return

    dest_path = Path(dest).expanduser()
    if not dest_path.parent.exists():
        raise emit_cli_error(cli, CliInvalidArgError(
            f"Destination parent directory does not exist: {dest_path.parent}",
            hint="先 mkdir -p, 或选已有目录",
        ))
    try:
        dest_path.write_bytes(content)
    except OSError as e:
        raise emit_cli_error(cli, CliError(
            f"Failed to write to {dest_path}: {e}",
            hint="检查权限 / 磁盘空间",
        ))

    data = {
        "attachment_id": attachment_id,
        "internal_id": row["internal_id"],
        "filename": row["filename"],
        "dest_path": str(dest_path.resolve()),
        "size_bytes": len(content),
        "sha256": sha,
    }
    if cli.output.lower() == "text":
        print(
            f"wrote {data['size_bytes']} bytes to {data['dest_path']} "
            f"(sha256={(sha or '')[:12]}...)"
        )
    else:
        emit(cli, data)


# ============================================================
# derive (PR-5 US-009) — deprecated alias
# ============================================================

@app.command("derive")
def attachment_derive(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="Forwarded to backfill derivatives dry-run.",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """DEPRECATED — use ``backfill derivatives --internal-id N`` instead."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    print(
        "'attachment derive' is deprecated; "
        "use 'mailagent backfill derivatives --internal-id N' instead.",
        file=sys.stderr,
    )

    from src.cli.commands.backfill import _run_backfill_derivatives_inline

    raise _run_backfill_derivatives_inline(
        cli,
        internal_id=internal_id,
        dry_run=dry_run,
        max_failures=20,
        progress_every=10,
        allow_concurrent=False,
        data_extra={"deprecated_alias": True},
    )


# ============================================================
# cleanup-orphans (US-002)
# ============================================================

@app.command("cleanup-orphans")
def attachment_cleanup_orphans(
    ctx: typer.Context,
    dry_run: bool = typer.Option(
        True, "--dry-run/--no-dry-run",
        help="只列不删 (默认 True). --no-dry-run + --yes 才真删",
    ),
    yes: bool = typer.Option(
        False, "--yes", "-y",
        help="--no-dry-run 时必须配合; 二级确认避免误删",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """扫 ``data/attachments/`` 下没有对应 ``email_metadata`` 的孤儿目录."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    # 实际删盘需要 --yes + auth
    will_delete = not dry_run
    if will_delete and not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--no-dry-run requires --yes confirmation",
            hint="add --yes to actually delete, or drop --no-dry-run to preview",
        ))
    if will_delete:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    # 拿 known internal_ids
    cfg = cli.cli_config
    known: set[int] = set()
    conn = sqlite3.connect(cfg.sync_store_db_path)
    try:
        for (iid,) in conn.execute("SELECT internal_id FROM email_metadata"):
            known.add(int(iid))
    finally:
        conn.close()

    store = cli.email_repo.attachment_store
    orphan_dirs = store.find_orphan_dirs(known_internal_ids=known)

    orphans = []
    total_size = 0
    for dir_path in orphan_dirs:
        size = 0
        file_count = 0
        for sub in dir_path.rglob("*"):
            if sub.is_file():
                try:
                    size += sub.stat().st_size
                except OSError:
                    pass
                file_count += 1
        orphans.append({
            "path": str(dir_path),
            "internal_id": int(dir_path.name),
            "size_bytes": size,
            "file_count": file_count,
        })
        total_size += size

    deleted = 0
    if will_delete:
        import shutil
        for o in orphans:
            try:
                shutil.rmtree(o["path"])
                deleted += 1
            except OSError as e:
                o["error"] = str(e)

    data = {
        "orphans": orphans,
        "total_orphans": len(orphans),
        "total_size_bytes": total_size,
        "deleted": deleted,
        "dry_run": dry_run,
        "mode": "deleted" if will_delete else "dry-run",
    }

    if cli.output.lower() == "text":
        if not orphans:
            print("(no orphan attachment directories)")
        else:
            for o in orphans:
                print(
                    f"orphan internal_id={o['internal_id']} "
                    f"path={o['path']} files={o['file_count']} "
                    f"size={o['size_bytes']}"
                )
            print(
                f"({len(orphans)} orphans, total_size={total_size} bytes, "
                f"mode={data['mode']}, deleted={deleted})"
            )
    else:
        emit(cli, data)


# ============================================================
# search (PR-2b: 附件文本 FTS5 搜索)
# ============================================================

SEARCH_LIMIT_DEFAULT = 30
SEARCH_LIMIT_MAX = 100


@app.command("search")
def attachment_search(
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
    """FTS5 全文搜附件文本 (PDF / docx / pptx / xlsx, PR-2b).

    跟 ``email search`` 平行: 自然语言关键词自动 CJK-aware 改写; 返
    attachment_id + internal_id + filename + 邮件上下文 (subject/sender/date)
    + bm25 rank + snippet. ``--raw`` 关 wrapper 走 FTS5 explicit syntax.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if limit <= 0 or limit > SEARCH_LIMIT_MAX:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be in (0, {SEARCH_LIMIT_MAX}], got {limit}"
        ))

    repo = cli.email_repo
    if raw:
        hits = repo.search_attachment_texts(
            query, limit=limit, mailbox=mailbox,
            since_date=since, until_date=until,
        )
        transformed_query = query
    else:
        from src.repository.email_repository import smart_query_transform
        transformed_query = smart_query_transform(query)
        hits = repo.search_attachment_texts(
            transformed_query, limit=limit, mailbox=mailbox,
            since_date=since, until_date=until,
        )

    data = []
    for hit in hits:
        item = {
            "attachment_id": hit.attachment_id,
            "internal_id": hit.internal_id,
            "filename": hit.filename,
            "content_type": hit.content_type,
            "email_subject": hit.email_subject,
            "email_sender": hit.email_sender,
            "email_date": hit.email_date,
            "email_mailbox": hit.email_mailbox,
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
        if not data:
            print(f"(no attachment text matches for {query!r})")
        else:
            for row in data:
                print(
                    f"att={row['attachment_id']} email={row['internal_id']} "
                    f"file={(row['filename'] or '')[:40]} "
                    f"subj={(row['email_subject'] or '')[:40]} "
                    f"rank={row['rank']:.2f}"
                )
                if not no_snippet and row.get("snippet"):
                    print(f"  → {row['snippet'][:100]}")
            print(
                f"(query={meta_extra['query']!r} mode={meta_extra['mode']} "
                f"hits={meta_extra['total_hits']} limit={limit})",
                file=sys.stderr,
            )
    else:
        emit(cli, data, meta_extra=meta_extra)


# ============================================================
# extract (PR-2b: 触发 pending 附件文本抽取)
# ============================================================


@app.command("extract")
def attachment_extract(
    ctx: typer.Context,
    pending: bool = typer.Option(
        False, "--pending",
        help="处理 status='pending' / retry-ready 'failed' 行",
    ),
    include_missing: bool = typer.Option(
        False, "--include-missing",
        help="扫 email_attachment 没对应 email_attachment_text 行的, 补 enqueue 后处理",
    ),
    limit: int = typer.Option(50, "--limit", help="最多处理多少 attachment"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """触发 attachment 文本抽取 (PR-2b).

    无后台 worker, 由 user / cron 跑这条命令推进 extraction queue. 一轮处理
    最多 ``--limit`` 个 attachment, 对每个 attachment:
        1. 取 file path
        2. 调 ``extract_text(path, content_type, filename)``
        3. 成功 → ``commit_attachment_text(status='extracted')`` → FTS5 索引
        4. 失败 → ``mark_attachment_text_failure`` 指数退避 (1m/5m/15m/1h/2h)

    ``--include-missing`` 扫历史已 commit 但未 enqueue 的 attachment 补登记.
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not pending and not include_missing:
        raise emit_cli_error(cli, CliInvalidArgError(
            "must pass at least one of --pending / --include-missing",
            hint="--pending 处理已 enqueue 的; --include-missing 扫历史补 enqueue",
        ))

    if limit <= 0 or limit > 1000:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be in (0, 1000], got {limit}"
        ))

    from src.converter.attachment_text import extract_text
    repo = cli.email_repo

    # Step 1: include-missing — 扫 email_attachment 没对应 _text 行的, 补 enqueue
    enqueued_missing = 0
    if include_missing:
        # 直接 SQL 找缺失行 + enqueue
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(str(repo.db_path), timeout=30.0)
        conn.row_factory = _sqlite3.Row
        try:
            rows = conn.execute("""
                SELECT a.id FROM email_attachment a
                LEFT JOIN email_attachment_text t ON t.attachment_id = a.id
                WHERE t.attachment_id IS NULL AND a.is_inline = 0
                LIMIT ?
            """, (limit,)).fetchall()
            for r in rows:
                if not dry_run:
                    repo.enqueue_attachment_text_extraction(r["id"])
                enqueued_missing += 1
        finally:
            conn.close()

    # Step 2: process pending / retry-ready
    processed = 0
    extracted_ok = 0
    unsupported = 0
    failed = 0
    skipped = 0

    if pending:
        pending_ids = repo.list_pending_attachment_extractions(limit=limit)
        # 取每个 attachment record 走 extract
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(str(repo.db_path), timeout=30.0)
        conn.row_factory = _sqlite3.Row
        try:
            for att_id in pending_ids:
                row = conn.execute("""
                    SELECT id, internal_id, filename, content_type,
                           local_path, size_bytes
                      FROM email_attachment WHERE id = ?
                """, (att_id,)).fetchone()
                if not row or not row["local_path"]:
                    skipped += 1
                    if not dry_run:
                        repo.mark_attachment_text_failure(att_id, "attachment row or local_path missing")
                    continue

                # local_path 是相对项目根的路径 (如 'data/attachments/53675/file.pdf');
                # 用 attachment_store.base_dir.parent.parent 反推 project_root.
                project_root = repo.attachment_store.base_dir.parent.parent
                abs_path = project_root / row["local_path"]
                if not abs_path.exists():
                    skipped += 1
                    if not dry_run:
                        repo.mark_attachment_text_failure(att_id, f"file missing: {abs_path}")
                    continue

                processed += 1
                if dry_run:
                    continue

                try:
                    result = extract_text(
                        abs_path,
                        content_type=row["content_type"],
                        filename=row["filename"],
                    )
                except Exception as e:
                    repo.mark_attachment_text_failure(att_id, f"extractor exception: {e}")
                    failed += 1
                    continue

                if result.status == 'extracted':
                    repo.commit_attachment_text(
                        att_id, text=result.text, extractor=result.extractor,
                        status='extracted', truncated=result.truncated,
                    )
                    extracted_ok += 1
                elif result.status == 'unsupported':
                    repo.commit_attachment_text(
                        att_id, text='', extractor=result.extractor,
                        status='unsupported', error_message=result.error_message,
                    )
                    unsupported += 1
                else:  # failed
                    repo.mark_attachment_text_failure(
                        att_id, result.error_message or 'unknown extractor failure'
                    )
                    failed += 1
        finally:
            conn.close()

    data = {
        "enqueued_missing": enqueued_missing,
        "processed": processed,
        "extracted": extracted_ok,
        "unsupported": unsupported,
        "failed": failed,
        "skipped": skipped,
        "dry_run": dry_run,
    }

    if cli.output.lower() == "text":
        print(
            f"enqueued_missing={enqueued_missing} processed={processed} "
            f"extracted={extracted_ok} unsupported={unsupported} "
            f"failed={failed} skipped={skipped} dry_run={dry_run}"
        )
    else:
        emit(cli, data)
