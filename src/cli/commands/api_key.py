"""mailagent api-key — scoped Bearer agent key 管理（create / list / revoke / rotate）。

给 headless 第三方 agent（OpenClaw / Claude Code / MCP client）签发 scoped key。明文只在
``create`` / ``rotate`` 时显示一次（DB 只存 hash）。写命令（create/revoke/rotate）需 auth
（``cli.require_auth()``，与其它写命令一致）；list 是读，无 auth。

存储 = backend-owned ``api_auth.db``（默认 sync_store.db 同目录；env
``MAILAGENT_API_AUTH_DB_PATH`` 覆盖）。**不**写 ai_chat.db（schema owner=前端 chat_db.ts）。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliNotFoundError
from src.cli.output import apply_local_output as _apply_local_output
from src.cli.output import emit, emit_cli_error
from src.security.api_keys import (
    HANDOFF_SCOPES,
    READ_ONLY_SCOPES,
    ApiKeyStore,
    resolve_api_auth_db_path,
    validate_scopes,
)

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="api-key",
    help="scoped Bearer agent key: create / list / revoke / rotate",
    no_args_is_help=True,
)


def _store(cli: "CliContext") -> ApiKeyStore:
    # 🔴 与 serve-api 同一解析真源（env MAILAGENT_API_AUTH_DB_PATH 优先 → 否则 cli 的 sync_store
    # 同目录）。dogfood 发现：CLI 若忽略 env override，建的 key serve-api 看不见。
    return ApiKeyStore(db_path=resolve_api_auth_db_path(cli.cli_config.sync_store_db_path))


def _record_to_dict(rec) -> dict:
    return {
        "id": rec.id,
        "label": rec.label,
        "key_prefix": rec.key_prefix,
        "scopes": list(rec.scopes),
        "created_at": rec.created_at,
        "last_used_at": rec.last_used_at,
        "expires_at": rec.expires_at,
        "revoked_at": rec.revoked_at,
        "is_active": rec.is_active,
    }


@app.command("create")
def create_key(
    ctx: typer.Context,
    label: str = typer.Option(..., "--label", help="人类可读标签（如 openclaw-prod）"),
    scopes: Optional[str] = typer.Option(
        None, "--scopes", help="逗号分隔 scope（默认 read-only）。如 email:read,report:run",
    ),
    preset: Optional[str] = typer.Option(
        None, "--preset", help="预设 scope 组: readonly | handoff（与 --scopes 互斥）",
    ),
    expires_at: Optional[int] = typer.Option(
        None, "--expires-at", help="过期 epoch 秒（默认永不过期）",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """签发一个 scoped key。返回 {id, label, scopes, key}（``key`` 明文仅此一次可见）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    if scopes and preset:
        raise emit_cli_error(cli, CliInvalidArgError("--scopes 与 --preset 互斥"))

    resolved: tuple[str, ...]
    if preset:
        if preset == "readonly":
            resolved = READ_ONLY_SCOPES
        elif preset == "handoff":
            resolved = HANDOFF_SCOPES
        else:
            raise emit_cli_error(
                cli, CliInvalidArgError("--preset must be readonly | handoff")
            )
    elif scopes:
        try:
            resolved = validate_scopes(scopes.split(","))
        except ValueError as e:
            raise emit_cli_error(cli, CliInvalidArgError(str(e)))
    else:
        resolved = READ_ONLY_SCOPES

    try:
        record, plaintext = _store(cli).create_key(
            label, scopes=resolved, expires_at=expires_at
        )
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))

    data = _record_to_dict(record)
    data["key"] = plaintext  # 明文仅 create 返回一次
    emit(cli, data)


@app.command("list")
def list_keys(
    ctx: typer.Context,
    include_revoked: bool = typer.Option(
        True, "--include-revoked/--active-only", help="是否含已撤销 key",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """列出所有 key（不含明文 / hash）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    records = _store(cli).list_keys(include_revoked=include_revoked)
    data = [_record_to_dict(r) for r in records]
    emit(cli, data, meta_extra={"count": len(data)})


@app.command("revoke")
def revoke_key(
    ctx: typer.Context,
    key_id: str = typer.Argument(..., help="key id（list 里的 id 字段）"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """撤销一个 key（立即 fail-closed）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    store = _store(cli)
    if store.get_key(key_id) is None:
        raise emit_cli_error(cli, CliNotFoundError(f"api key {key_id!r} not found"))
    revoked = store.revoke(key_id)
    emit(cli, {"id": key_id, "revoked": revoked})


@app.command("rotate")
def rotate_key(
    ctx: typer.Context,
    key_id: str = typer.Argument(..., help="key id"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """轮换 key：同 id/label/scopes 换新明文（旧明文立即失效）。``key`` 仅此一次可见。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    plaintext = _store(cli).rotate(key_id)
    if plaintext is None:
        raise emit_cli_error(cli, CliNotFoundError(f"api key {key_id!r} not found"))
    emit(cli, {"id": key_id, "key": plaintext, "rotated": True})
