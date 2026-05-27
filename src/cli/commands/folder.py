"""mailagent folder — Archive / Drafts 文件夹查看 + 草稿操作 (davmail-only).

读 (无 auth): list / get / search / sync-status — FolderEmailRepository 直读本地表.
写 (needsAuth): sync-now / delete / move / send-draft / edit-draft / create-draft —
  操作 IMAP/SMTP (FolderImapReader) 后即时 sync_folder_once 刷新本地表 (即时一致).

davmail-only: 写命令 + sync-now 要求 MAILAGENT_BACKEND=davmail; applescript 模式报错.
读命令任何 backend 都能跑 (读已同步的本地数据).
"""
from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliNotFoundError
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.folder_sync.imap_folder_reader import FolderImapReader
    from src.folder_sync.repository import FolderEmailRepository

app = typer.Typer(
    name="folder",
    help="存档/草稿文件夹: list / get / search / sync-* / delete / move / send-draft / edit-draft / create-draft (davmail-only)",
    no_args_is_help=True,
)

_VALID_FOLDERS = ("archive", "drafts")


# ============================================================
# Helpers
# ============================================================

def _validate_folder(folder: str) -> str:
    if folder not in _VALID_FOLDERS:
        raise CliInvalidArgError(
            f"folder must be one of {_VALID_FOLDERS}, got {folder!r}"
        )
    return folder


def _repo(cli: "CliContext") -> "FolderEmailRepository":
    from src.folder_sync.repository import FolderEmailRepository

    return FolderEmailRepository(cli.cli_config.sync_store_db_path)


def _reader(cli: "CliContext") -> "FolderImapReader":
    """构造 FolderImapReader; 要求 davmail backend, 否则 raise CliError."""
    from src.mail.backend.davmail_backend import DavMailBackend
    from src.folder_sync.imap_folder_reader import FolderImapReader

    backend = cli.backend
    if not isinstance(backend, DavMailBackend):
        raise CliError(
            "folder 操作需要 MAILAGENT_BACKEND=davmail (IMAP/SMTP); "
            f"当前 backend={getattr(backend, 'backend_origin', '?')!r} 不支持.",
            hint="在 .env 设 MAILAGENT_BACKEND=davmail 并确认 DavMail JVM 在跑.",
        )
    return FolderImapReader(backend)


def _row_dict(row) -> dict:
    """FolderEmailRow → JSON-able dict (emit 用)."""
    return asdict(row)


# ============================================================
# 读命令 (无 auth)
# ============================================================

@app.command("list")
def folder_list(
    ctx: typer.Context,
    folder: str = typer.Argument(..., help="archive | drafts"),
    limit: int = typer.Option(200, "--limit", "-n", help="返回上限"),
    offset: int = typer.Option(0, "--offset", help="分页偏移"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出 folder 内邮件 (本地表直读, 不含正文)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _validate_folder(folder)
    rows = _repo(cli).list(folder, limit=limit, offset=offset)
    data = [_row_dict(r) for r in rows]
    if cli.output.lower() == "text":
        print(f"=== folder {folder} ({len(data)} rows) ===")
        for r in rows:
            print(f"[{r.id}] uid={r.imap_uid} {r.date_received or '':25} {(r.subject or '(no subj)')[:50]}")
    else:
        emit(cli, data)


@app.command("get")
def folder_get(
    ctx: typer.Context,
    id: int = typer.Argument(..., help="folder_email 本地 id"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """单封详情 (含正文 body_html / body_markdown + 附件元数据)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    row = _repo(cli).get(id)
    if not row:
        raise emit_cli_error(cli, CliNotFoundError(f"folder_email id={id} not found"))
    if cli.output.lower() == "text":
        print(f"[{row.id}] folder={row.folder} uid={row.imap_uid}")
        print(f"subject: {row.subject}")
        print(f"from: {row.sender_name} <{row.sender}>")
        print(f"to: {row.to_addr}  cc: {row.cc_addr}")
        print(f"date: {row.date_received}")
        print(f"attachments: {len(row.attachments)}")
        print(f"--- body (markdown) ---\n{(row.body_markdown or '')[:2000]}")
    else:
        emit(cli, _row_dict(row))


@app.command("search")
def folder_search(
    ctx: typer.Context,
    query: str = typer.Argument(..., help="FTS5 查询 (默认 CJK-aware smart 改写)"),
    folder: Optional[str] = typer.Option(None, "--folder", "-f", help="限定 archive|drafts"),
    limit: int = typer.Option(50, "--limit", "-n"),
    raw: bool = typer.Option(False, "--raw", help="关闭 smart wrapper, 原样下放 FTS5"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """folder_email_fts 全文搜索 (bm25 排序). 默认 CJK-aware smart 改写."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    if folder is not None:
        _validate_folder(folder)
    q = query
    if not raw:
        from src.repository.email_repository import smart_query_transform
        q = smart_query_transform(query)
    rows = _repo(cli).search_fts(q, folder=folder, limit=limit)
    data = [_row_dict(r) for r in rows]
    if cli.output.lower() == "text":
        print(f"=== search {query!r} (transformed={q!r}, {len(data)} hits) ===")
        for r in rows:
            print(f"[{r.id}] {r.folder} {(r.subject or '')[:50]} | {(r.snippet or '')[:60]}")
    else:
        emit(cli, {"query": query, "transformed_query": None if raw else q,
                   "total_hits": len(data), "hits": data})


@app.command("sync-status")
def folder_sync_status(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """folder_sync_state 表 + 每 folder 行数统计."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    repo = _repo(cli)
    states = repo.list_sync_states()
    data = {
        "states": [asdict(s) for s in states],
        "counts": {f: repo.count(f) for f in _VALID_FOLDERS},
    }
    if cli.output.lower() == "text":
        print("=== folder sync-status ===")
        for f in _VALID_FOLDERS:
            print(f"{f:10} count={data['counts'][f]}")
        for s in states:
            print(f"{s.folder:10} uidnext={s.last_uidnext} uv={s.imap_uidvalidity} err={s.last_error}")
    else:
        emit(cli, data)


# ============================================================
# 写命令 (needsAuth + davmail-only)
# ============================================================

@app.command("sync-now")
def folder_sync_now(
    ctx: typer.Context,
    folder: str = typer.Argument(..., help="archive | drafts"),
    full: bool = typer.Option(True, "--full/--incremental", help="full=拉窗口全量+对账 (默认)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """手动触发一次 folder 同步 (list IMAP → 落库 → 对账)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _validate_folder(folder)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.folder_sync.sync_ops import sync_folder_once
    reader = _reader(cli)
    stats = sync_folder_once(folder, reader=reader, repo=_repo(cli),
                             cfg=cli.cli_config, full=full)
    data = {"folder": folder, "full": full, **stats}
    if cli.output.lower() == "text":
        print(f"sync {folder}: {stats}")
    else:
        emit(cli, data)


def _refresh_drafts(cli: "CliContext", reader: "FolderImapReader") -> None:
    """草稿写操作后刷新本地 drafts 表 (即时一致)."""
    from src.folder_sync.sync_ops import sync_folder_once
    try:
        sync_folder_once("drafts", reader=reader, repo=_repo(cli),
                         cfg=cli.cli_config, full=True)
    except Exception:
        pass  # 刷新失败不影响写操作结果, 下次 worker tick 兜底


@app.command("delete")
def folder_delete(
    ctx: typer.Context,
    id: int = typer.Argument(..., help="folder_email 本地 id"),
    yes: bool = typer.Option(False, "--yes", help="确认永久删除 (不可逆)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """永久删除一封 (IMAP STORE \\Deleted + EXPUNGE). 不可逆, 需 --yes."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    if not yes:
        raise emit_cli_error(cli, CliInvalidArgError("删除不可逆, 请加 --yes 确认"))
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    repo = _repo(cli)
    row = repo.get(id)
    if not row:
        raise emit_cli_error(cli, CliNotFoundError(f"folder_email id={id} not found"))
    reader = _reader(cli)
    ok = reader.delete_message(row.folder, row.imap_uid)
    if not ok:
        raise emit_cli_error(cli, CliError(f"IMAP delete failed for id={id}"))
    repo.hard_delete_by_uid(row.folder, row.imap_uid)
    data = {"id": id, "folder": row.folder, "deleted": True}
    if cli.output.lower() == "text":
        print(f"deleted id={id} (folder={row.folder} uid={row.imap_uid})")
    else:
        emit(cli, data)


@app.command("move")
def folder_move(
    ctx: typer.Context,
    id: int = typer.Argument(..., help="folder_email 本地 id (必须是 archive)"),
    to: str = typer.Option("收件箱", "--to", help="目标邮箱 (默认 收件箱)"),
    yes: bool = typer.Option(False, "--yes", help="确认移动"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """把存档邮件移回目标邮箱 (IMAP COPY + \\Deleted + EXPUNGE). 移回后正向 sync 会重新入库."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    if not yes:
        raise emit_cli_error(cli, CliInvalidArgError("移动需加 --yes 确认"))
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    repo = _repo(cli)
    row = repo.get(id)
    if not row:
        raise emit_cli_error(cli, CliNotFoundError(f"folder_email id={id} not found"))
    if row.folder != "archive":
        raise emit_cli_error(cli, CliInvalidArgError(f"move 仅支持 archive, id={id} folder={row.folder}"))
    from src.mail.backend.davmail_backend import _mailbox_to_imap
    reader = _reader(cli)
    dst_imap = _mailbox_to_imap(to)
    ok = reader.move_message("archive", row.imap_uid, dst_imap)
    if not ok:
        raise emit_cli_error(cli, CliError(f"IMAP move failed for id={id} → {dst_imap}"))
    repo.hard_delete_by_uid("archive", row.imap_uid)
    data = {"id": id, "moved_to": to, "dst_imap": dst_imap, "success": True}
    if cli.output.lower() == "text":
        print(f"moved id={id} → {to} ({dst_imap})")
    else:
        emit(cli, data)


@app.command("send-draft")
def folder_send_draft(
    ctx: typer.Context,
    id: int = typer.Argument(..., help="folder_email 本地 id (必须是 drafts)"),
    yes: bool = typer.Option(False, "--yes", help="确认发送 (对外不可逆!)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """发送草稿 (SMTP) → 删除草稿. 对外不可逆动作, 强制 --yes.

    注意: 当前 DavMail 是 PoC client_id 伪装, 仅本机 dogfood; 生产前需走合规 (Graph API).
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    if not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "发送是对外不可逆动作, 请加 --yes 确认"))
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    repo = _repo(cli)
    row = repo.get(id)
    if not row:
        raise emit_cli_error(cli, CliNotFoundError(f"folder_email id={id} not found"))
    if row.folder != "drafts":
        raise emit_cli_error(cli, CliInvalidArgError(f"send-draft 仅支持 drafts, id={id} folder={row.folder}"))
    reader = _reader(cli)
    ok = reader.send_draft(row.imap_uid)
    if not ok:
        raise emit_cli_error(cli, CliError(f"SMTP send failed for draft id={id}"))
    repo.hard_delete_by_uid("drafts", row.imap_uid)
    data = {"id": id, "sent": True, "to": row.to_addr}
    if cli.output.lower() == "text":
        print(f"sent draft id={id} to={row.to_addr}")
    else:
        emit(cli, data)


def _split_addrs(value: Optional[str]) -> list[str]:
    if not value:
        return []
    return [a.strip() for a in value.split(",") if a.strip()]


@app.command("create-draft")
def folder_create_draft(
    ctx: typer.Context,
    to: str = typer.Option(..., "--to", help="收件人 (逗号分隔)"),
    html: str = typer.Option(..., "--html", help="正文 HTML"),
    cc: Optional[str] = typer.Option(None, "--cc", help="抄送 (逗号分隔)"),
    subject: Optional[str] = typer.Option(None, "--subject", help="主题"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """新建空白草稿 (IMAP APPEND 到 Drafts) → 刷新本地表."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.mail.backend.types import DraftRequest
    from src.converter.html_to_markdown import html_to_markdown
    reader = _reader(cli)
    draft = DraftRequest(
        mode="new",
        to=_split_addrs(to),
        cc=_split_addrs(cc),
        subject=subject or "(no subject)",
        reply_text=html_to_markdown(html) or "(empty)",
        reply_html=html,
    )
    new_uid = reader.create_draft(draft)
    if new_uid is None:
        raise emit_cli_error(cli, CliError("IMAP APPEND draft failed"))
    _refresh_drafts(cli, reader)
    data = {"appended_uid": new_uid, "to_count": len(draft.to), "success": True}
    if cli.output.lower() == "text":
        print(f"draft created: uid={new_uid} to={len(draft.to)}")
    else:
        emit(cli, data)


@app.command("edit-draft")
def folder_edit_draft(
    ctx: typer.Context,
    id: int = typer.Argument(..., help="folder_email 本地 id (必须是 drafts)"),
    html: str = typer.Option(..., "--html", help="新正文 HTML"),
    to: Optional[str] = typer.Option(None, "--to", help="覆盖收件人 (逗号分隔; 默认沿用原草稿)"),
    cc: Optional[str] = typer.Option(None, "--cc", help="覆盖抄送"),
    subject: Optional[str] = typer.Option(None, "--subject", help="覆盖主题"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """编辑草稿 (删旧 APPEND 新, 本地 uid 变但内容更新) → 刷新本地表."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    repo = _repo(cli)
    row = repo.get(id)
    if not row:
        raise emit_cli_error(cli, CliNotFoundError(f"folder_email id={id} not found"))
    if row.folder != "drafts":
        raise emit_cli_error(cli, CliInvalidArgError(f"edit-draft 仅支持 drafts, id={id} folder={row.folder}"))
    from src.mail.backend.types import DraftRequest
    from src.converter.html_to_markdown import html_to_markdown
    reader = _reader(cli)
    draft = DraftRequest(
        mode="new",
        to=_split_addrs(to) or _split_addrs(row.to_addr),
        cc=_split_addrs(cc) or _split_addrs(row.cc_addr),
        subject=subject if subject is not None else row.subject,
        reply_text=html_to_markdown(html) or "(empty)",
        reply_html=html,
    )
    new_uid = reader.update_draft(row.imap_uid, draft)
    if new_uid is None:
        raise emit_cli_error(cli, CliError(f"edit draft failed for id={id} (old draft kept)"))
    _refresh_drafts(cli, reader)
    data = {"old_id": id, "new_uid": new_uid, "success": True}
    if cli.output.lower() == "text":
        print(f"edited draft id={id} → new uid={new_uid}")
    else:
        emit(cli, data)
