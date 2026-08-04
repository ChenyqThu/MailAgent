"""mailagent im — 飞书对话 bot 的绑定与状态（08-01 阶段 2 PR-2）。

Subcommands:
- ``pair [--rebind]`` —— 生成一次性绑定码（6 位数字，TTL 10 分钟）。**写命令，需 auth**。
- ``status`` —— 读回 ``im.feishu.*`` 连接/绑定状态（读，无 auth）。

绑定流程：本命令出码 → owner 在飞书私聊里把这 6 位数字发给 bot → bot 校验后把发送者
``open_id`` 落库。绑定关系跨重启存活（sync_state）。PR-4 会在 Settings 里补同样的入口。

🔴 **本组写命令刻意不做 PM2 冲突检测**（与 backfill / init 那批相反）：那道闸防的是
「batch 写命令与长驻服务并发写 SyncStore」，而 ``im pair`` 只写两行 sync_state，且
**飞书 bot 只在长驻服务跑着的时候才收得到消息** —— 要求 `pm2 stop mail-sync` 才能配对，
等于要求「先把要配对的东西关掉」。
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError
from src.cli.output import apply_local_output as _apply_local_output
from src.cli.output import emit, emit_cli_error
from src.im.pairing import PAIR_CODE_TTL_SEC, issue_pair_code
from src.im.state import ImFeishuState

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="im",
    help="IM 对话（飞书）: pair / status",
    no_args_is_help=True,
)


@app.command("pair")
def pair(
    ctx: typer.Context,
    rebind: bool = typer.Option(
        False,
        "--rebind",
        help="已绑定时先解绑再出码（换手机 / 换飞书账号用）。不加则拒绝出码。",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """生成一次性绑定码，把它发给飞书 bot 完成绑定。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    state = ImFeishuState(cli.sync_store)
    bound = state.get_bound_open_id()
    if bound and not rebind:
        raise emit_cli_error(
            cli,
            CliInvalidArgError(
                f"已绑定 open_id={bound}，绑定码对已绑定的 bot 无效。",
                hint="确实要换人/换设备就加 --rebind（会先解绑，再出新码）。",
            ),
        )

    unbound_from = ""
    if bound and rebind:
        unbound_from = bound
        state.set_bound_open_id("")

    code, expires_at = issue_pair_code(state)
    data = {
        "code": code,
        "expires_at": expires_at,
        "expires_in_sec": PAIR_CODE_TTL_SEC,
        "unbound_from": unbound_from,
    }

    if cli.output.lower() == "text":
        if unbound_from:
            print(f"已解绑原 open_id={unbound_from}")
        print(f"绑定码: {code}")
        print(f"有效期: {PAIR_CODE_TTL_SEC // 60} 分钟（到 {_fmt(expires_at)}）")
        print("在飞书里**私聊**这个 bot，把上面 6 位数字单独发给它即可完成绑定。")
        print("（bot 是不是对的那个？跑 `mailagent im status` 看 bot_app_name / bot_open_id）")
    else:
        emit(cli, data)


@app.command("status")
def status(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """飞书连接 / 绑定状态（``sync_state`` 的 ``im.feishu.*``）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    state = ImFeishuState(cli.sync_store)
    data = state.snapshot()
    data["enabled"] = bool(getattr(cli.cli_config, "im_feishu_enabled", False))
    # 只报「有没有一个有效码在等」，**不回显码本身**（回显等于任何能跑 CLI 的人都能顶号）
    from src.im.pairing import peek_pair_code_expiry

    pending = peek_pair_code_expiry(state)
    data["pair_code_pending"] = pending is not None
    data["pair_code_expires_at"] = pending or 0

    if cli.output.lower() == "text":
        print(f"enabled          {data['enabled']}")
        if data["enabled"]:
            print(f"connection       {data['connection_status']}")
        else:
            # flag off = 根本没有连接。直接印残留的 connection_status 会撒谎
            # （serve 被 kill -9 时它可能还停在 connected）。
            print(
                "connection       disabled (MAILAGENT_IM_FEISHU=false；"
                f"上次记录 {data['connection_status']})"
            )
        print(f"connected_at     {data['connected_at'] or '(none)'}")
        print(f"last_event_at    {data['last_event_at'] or '(none)'}")
        print(f"bound_open_id    {data['bound_open_id'] or '(unbound)'}")
        print(f"bot_app_name     {data['bot_app_name'] or '(unknown)'}")
        print(f"bot_open_id      {data['bot_open_id'] or '(unknown)'}")
        if data["conflict"]:
            print(f"conflict         YES — {data['conflict_reason']}")
        if data["last_error"]:
            print(f"last_error       {data['last_error']}")
        if data["pair_code_pending"]:
            print(f"pair_code        pending (到 {_fmt(data['pair_code_expires_at'])})")
    else:
        emit(cli, data)


def _fmt(epoch: int) -> str:
    try:
        return time.strftime("%H:%M:%S", time.localtime(epoch))
    except (TypeError, ValueError, OSError):  # pragma: no cover - 防御
        return str(epoch)
