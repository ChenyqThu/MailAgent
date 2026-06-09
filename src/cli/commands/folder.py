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


# ============================================================
# 多文件夹同步: discover / enable / disable (davmail-only, SYNC_FOLDERS 白名单)
# ============================================================

def _require_davmail_cfg(cli: "CliContext") -> None:
    """gate: 多文件夹发现/白名单仅 davmail 后端可用 (按 config 值判, 不构造 backend)."""
    backend = (getattr(cli.cli_config, "mailagent_backend", "") or "").lower()
    if backend != "davmail":
        raise emit_cli_error(cli, CliError(
            f"folder discover/enable/disable 需要 MAILAGENT_BACKEND=davmail; 当前={backend!r}.",
            hint="在 .env 设 MAILAGENT_BACKEND=davmail 并确认 DavMail JVM 在跑.",
        ))


def _current_whitelist(cli: "CliContext") -> list[str]:
    """当前 SYNC_FOLDERS 白名单 (复用 backend 的解析: 去重保序 + 排 INBOX)."""
    from src.mail.backend.davmail_backend import DavMailBackend

    return DavMailBackend._parse_custom_folders(cli.cli_config)


def _write_whitelist(cli: "CliContext", names: list[str]) -> None:
    """把白名单写回 .env 的 SYNC_FOLDERS (atomic, 复用 admin 的 dotenv set_key 模式)。

    **写 JSON 数组格式** —— modified-UTF7 名含逗号 (base64 段), 逗号分隔会拆坏中文名。
    dotenv quote_mode='auto' 把含特殊字符的值用单引号包裹, JSON 内部双引号安全。
    """
    import json as _json

    from src.cli.commands.admin import _resolve_env_file

    env_file = _resolve_env_file(cli)
    if not env_file.exists():
        env_file.touch()
    from dotenv import set_key as _dotenv_set_key

    value = _json.dumps(names, ensure_ascii=False)
    _dotenv_set_key(str(env_file), "SYNC_FOLDERS", value, quote_mode="auto")


@app.command("discover")
def folder_discover(
    ctx: typer.Context,
    no_counts: bool = typer.Option(False, "--no-counts", help="跳过逐文件夹 STATUS 邮件数 (更快)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """发现 Exchange 全部文件夹 (LIST → 层级 + special-use + 邮件数)。davmail-only, 只读无 auth.

    每项标 ``is_synced`` (是否在 SYNC_FOLDERS 白名单)。JSON 返回 ``folders`` 扁平列表
    (含 parent/has_children 层级信息) + ``tree`` 嵌套树 + ``whitelist``。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _require_davmail_cfg(cli)
    from src.mail.backend.imap_client import build_folder_tree, list_folders

    try:
        folders = list_folders(cli.cli_config, with_counts=not no_counts)
    except Exception as e:
        raise emit_cli_error(cli, CliError(f"folder discover failed: {e}"))
    whitelist = set(_current_whitelist(cli))
    flat = []
    for fi in folders:
        d = fi.to_dict()
        d["is_synced"] = fi.imap_name in whitelist
        flat.append(d)
    if cli.output.lower() == "text":
        print(f"=== {len(flat)} folders ===")
        for d in flat:
            mark = "*" if d["is_synced"] else ("#" if d["is_system"] else "-")
            cnt = d["message_count"] if d["message_count"] is not None else "?"
            print(f"{mark} {(d['display_name'] or ''):28} {str(cnt):>6}  {d['imap_name']}")
    else:
        emit(cli, {
            "folders": flat,
            "tree": build_folder_tree(folders),
            "whitelist": sorted(whitelist),
        })


@app.command("enable")
def folder_enable(
    ctx: typer.Context,
    imap_name: str = typer.Argument(..., help="文件夹 IMAP 原始名 (modified-UTF7, 见 discover)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只显示结果不写 .env; 跳过 auth"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """把文件夹加入 SYNC_FOLDERS 白名单 (写 .env)。需 `pm2 restart mail-sync` 生效。davmail-only."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _require_davmail_cfg(cli)
    current = _current_whitelist(cli)
    if imap_name in current:
        emit(cli, {"changed": False, "reason": "already enabled", "whitelist": current})
        return
    # 系统文件夹 gate: 收件箱/发件箱/Drafts/Junk/Trash 由 SYNC_MAILBOXES 管, 不可加白名单
    # (避免双拉 + 接入受保护文件夹)。best-effort discover; IMAP 不可用时放行 (不阻塞)。
    sys_blocked = False
    try:
        from src.mail.backend.imap_client import list_folders

        sys_map = {f.imap_name: f.is_system for f in list_folders(cli.cli_config, with_counts=False)}
        sys_blocked = bool(sys_map.get(imap_name))
    except Exception:
        pass  # discover 失败 (IMAP down 等) → 不阻塞 enable
    if sys_blocked:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"{imap_name!r} 是系统文件夹 (收件箱/发件箱/Drafts/Junk/Trash), 不能加入 SYNC_FOLDERS; "
            "收件箱/发件箱由 SYNC_MAILBOXES 管理.",
        ))
    new = current + [imap_name]
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        try:
            _write_whitelist(cli, new)
        except Exception as e:
            raise emit_cli_error(cli, CliError(f".env write failed: {e}"))
    emit(cli, {"changed": not dry_run, "dry_run": dry_run, "imap_name": imap_name, "whitelist": new})


@app.command("disable")
def folder_disable(
    ctx: typer.Context,
    imap_name: str = typer.Argument(..., help="文件夹 IMAP 原始名 (见 discover)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只显示结果不写 .env; 跳过 auth"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """把文件夹移出 SYNC_FOLDERS 白名单 (写 .env)。停止同步新邮件; 已同步本地数据保留。davmail-only."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _require_davmail_cfg(cli)
    current = _current_whitelist(cli)
    if imap_name not in current:
        emit(cli, {"changed": False, "reason": "not in whitelist", "whitelist": current})
        return
    new = [f for f in current if f != imap_name]
    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)
        try:
            _write_whitelist(cli, new)
        except Exception as e:
            raise emit_cli_error(cli, CliError(f".env write failed: {e}"))
    emit(cli, {"changed": not dry_run, "dry_run": dry_run, "imap_name": imap_name, "whitelist": new})
