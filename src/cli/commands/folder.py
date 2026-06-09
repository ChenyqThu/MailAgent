"""mailagent folder — 多文件夹同步管理 (davmail-only).

发现 / 白名单: discover / enable / disable — 列出 Exchange 文件夹, 增删 SYNC_FOLDERS 白名单 (写 .env).
文件夹 CRUD (needsAuth): create / rename / delete-folder — IMAP CREATE/RENAME/DELETE + 本地一致性.
本地清理: cleanup — 取消同步某文件夹时删本地副本 (不碰 Exchange).

davmail-only: 全部命令要求 MAILAGENT_BACKEND=davmail; applescript 模式报错 (cleanup 例外, 纯本地).
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="folder",
    help="多文件夹同步: discover / enable / disable / create / rename / delete-folder / cleanup (davmail-only)",
    no_args_is_help=True,
)

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


# ============================================================
# 多文件夹同步: 文件夹管理 create / rename / delete (davmail-only, 写鉴权)
# ============================================================

def _mail_write_svc(cli: "CliContext"):
    from src.services.mail_write import MailWriteService

    return MailWriteService(cli)


def _http_or_cli_actor(cli: "CliContext"):
    from src.services.guards import Actor

    return Actor(kind="cli", authenticated=True, label="cli")


@app.command("create")
def folder_create(
    ctx: typer.Context,
    name: str = typer.Argument(..., help="子文件夹显示名 (可中文)"),
    parent: str = typer.Option("", "--parent", help="父文件夹 imap_name (空=顶层)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """新建子文件夹 (IMAP CREATE → EWS)。davmail-only。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _require_davmail_cfg(cli)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.services.errors import ServiceError

    try:
        result = _mail_write_svc(cli).create_folder(parent, name, actor=_http_or_cli_actor(cli))
    except ServiceError as e:
        raise emit_cli_error(cli, CliError(getattr(e, "message", str(e))))
    emit(cli, {"action": "create", "imap_name": result.imap_name})


@app.command("rename")
def folder_rename(
    ctx: typer.Context,
    imap_name: str = typer.Argument(..., help="要重命名的文件夹 imap_name"),
    new_name: str = typer.Argument(..., help="新叶子显示名 (可中文)"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """重命名文件夹 (IMAP RENAME + 本地一致性)。系统文件夹拒绝。davmail-only。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _require_davmail_cfg(cli)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.services.errors import ServiceError

    try:
        result = _mail_write_svc(cli).rename_folder(imap_name, new_name, actor=_http_or_cli_actor(cli))
    except ServiceError as e:
        raise emit_cli_error(cli, CliError(getattr(e, "message", str(e))))
    emit(cli, {
        "action": "rename", "imap_name": result.imap_name,
        "new_imap_name": result.new_imap_name, "affected_local_rows": result.affected_local_rows,
        "restart_required": result.restart_required,
    })


@app.command("delete-folder")
def folder_delete_folder(
    ctx: typer.Context,
    imap_name: str = typer.Argument(..., help="要删除的文件夹 imap_name"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """删除文件夹 (IMAP DELETE + 本地清理 + 白名单移除)。系统文件夹拒绝。davmail-only。

    🔴 不可撤销: 同时删 Exchange 文件夹 + 本地已同步副本。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    _require_davmail_cfg(cli)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.services.errors import ServiceError

    try:
        result = _mail_write_svc(cli).delete_folder(imap_name, actor=_http_or_cli_actor(cli))
    except ServiceError as e:
        raise emit_cli_error(cli, CliError(getattr(e, "message", str(e))))
    emit(cli, {"action": "delete", "imap_name": result.imap_name,
               "affected_local_rows": result.affected_local_rows,
               "restart_required": result.restart_required})


@app.command("cleanup")
def folder_cleanup(
    ctx: typer.Context,
    imap_name: str = typer.Argument(..., help="要清理本地副本的文件夹 imap_name"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """取消同步某文件夹时清理本地副本 (P5)。**不碰 Exchange 文件夹**, 只删本地已同步邮件
    (级联 body/附件/FTS) + 从白名单移除。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    from src.services.errors import ServiceError

    try:
        result = _mail_write_svc(cli).cleanup_local_folder(imap_name, actor=_http_or_cli_actor(cli))
    except ServiceError as e:
        raise emit_cli_error(cli, CliError(getattr(e, "message", str(e))))
    emit(cli, {"action": "cleanup", "imap_name": result.imap_name,
               "affected_local_rows": result.affected_local_rows,
               "restart_required": result.restart_required})
