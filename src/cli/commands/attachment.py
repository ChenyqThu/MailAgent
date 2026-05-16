"""mailagent attachment — 附件 list / download / derive (RFC v2 §4.3).

PR-3 US-001:
    list      列出邮件的所有附件 (含 derived).
    download  下载附件二进制到 --dest, 或 stdout.
    derive    PR-3 stub - 真正实现在 PR-4 `backfill derivatives`。

US-002:
    cleanup-orphans  扫盘上没有对应 email_metadata 的孤儿目录 (写操作).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliNotFoundError
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.repository import AttachmentRecord

app = typer.Typer(
    name="attachment",
    help="附件 list / download / derive / cleanup-orphans (RFC §4.3)",
    no_args_is_help=True,
)


# ============================================================
# list (US-001)
# ============================================================

def _attachment_to_dict(att: "AttachmentRecord") -> dict:
    return {
        "id": att.id,
        "internal_id": att.internal_id,
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
    data = [_attachment_to_dict(r) for r in rows]
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
# derive (US-001) — PR-3 stub
# ============================================================

@app.command("derive")
def attachment_derive(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="PR-3 stub: dry-run 时仅描述要做什么, 不写盘",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """PR-3 stub. 实现在 PR-4 ``backfill derivatives --internal-id N``.

    PR-3 仅提供命令入口与 dry-run plan, 实跑路径直接拒绝并提示 PR-4 / 临时脚本。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if dry_run:
        data = {
            "internal_id": internal_id,
            "stub": True,
            "message": (
                "PR-3 stub. Office derivation 真正实现在 PR-4 "
                "'mailagent backfill derivatives --internal-id N'."
            ),
            "current_workaround": "python scripts/backfill_derivatives.py",
        }
        if cli.output.lower() == "text":
            print(data["message"])
            print(f"workaround: {data['current_workaround']}")
        else:
            emit(cli, data)
        return

    raise emit_cli_error(cli, CliInvalidArgError(
        "'attachment derive' non-dry-run path not yet implemented (PR-4 scope).",
        hint=(
            "用 'mailagent attachment derive <internal_id> --dry-run' 看 plan, "
            "或临时跑 'python scripts/backfill_derivatives.py "
            "--internal-id <id>'."
        ),
    ))


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
