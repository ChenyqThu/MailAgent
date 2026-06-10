"""mailagent CLI 顶层入口 (RFC v2 §4 / §6.1)."""

from __future__ import annotations

import importlib.metadata
from typing import Optional

import typer

VALID_OUTPUT_FORMATS = ("text", "json", "yaml", "ndjson")

app = typer.Typer(
    name="mailagent",
    help="MailAgent CLI - Agent-friendly interface to the MailAgent backend.",
    no_args_is_help=True,
    add_completion=True,
)


def _resolve_version() -> str:
    try:
        return importlib.metadata.version("mailagent")
    except importlib.metadata.PackageNotFoundError:
        return "3.0.0"


def _print_version(value: bool) -> None:
    if value:
        typer.echo(f"mailagent {_resolve_version()}")
        raise typer.Exit()


# 子命令模块在此延迟 import，避免 typer App 解析 --help / --version 时
# 强制载入整个 src.notion / sqlite 链 (CLI 启动更快 + 测试更容易隔离)。
from src.cli.commands import admin as _admin_module  # noqa: E402
from src.cli.commands import attachment as _attachment_module  # noqa: E402
from src.cli.commands import backfill as _backfill_module  # noqa: E402
from src.cli.commands import email as _email_module  # noqa: E402
from src.cli.commands import init as _init_module  # noqa: E402
from src.cli.commands import llm as _llm_module  # noqa: E402
from src.cli.commands import calendar as _calendar_module  # noqa: E402
from src.cli.commands import debug as _debug_module  # noqa: E402
from src.cli.commands import notion as _notion_module  # noqa: E402
from src.cli.commands import project_progress as _project_progress_module  # noqa: E402
from src.cli.commands import folder as _folder_module  # noqa: E402
from src.cli.commands import report as _report_module  # noqa: E402

app.add_typer(_email_module.app, name="email", help="邮件 CRUD / 搜索 / 重传")
app.add_typer(_admin_module.app, name="admin", help="统计 / 健康 / db-version")
app.add_typer(
    _attachment_module.app, name="attachment",
    help="附件 list / download / derive / cleanup-orphans",
)
app.add_typer(
    _llm_module.app, name="llm",
    help="LLM run / selftest / retry-failed / stats / compare-paths",
)
app.add_typer(
    _notion_module.app, name="notion",
    help="Notion resync (alias) / update-flag / archive / page-orphans / file-link-audit",
)
app.add_typer(
    _calendar_module.app, name="calendar",
    help="日历 expand + recurring discover / replay",
)
app.add_typer(
    _debug_module.app, name="debug",
    help="调试: email-source / mail-structure / inline-images / applescript-fetch / notion-page",
)
app.add_typer(
    _backfill_module.app, name="backfill",
    help="历史回填 body / derivatives (PR-4)",
)
app.add_typer(
    _project_progress_module.app, name="project-progress",
    help="项目周报同步外挂 (PR-4)",
)
app.add_typer(
    _init_module.app, name="init",
    help="初始化同步 (PR-4)",
)
app.add_typer(
    _folder_module.app, name="folder",
    help="存档/草稿文件夹 list / get / search / sync / delete / move / send-draft / edit/create-draft (davmail-only)",
)
app.add_typer(
    _report_module.app, name="report",
    help="报告 Agent run / list / get / config-get / config-set (/agents 页 IPC 后端)",
)


@app.command()
def serve() -> None:
    """启动 MailAgent 长驻同步服务 (等价于 `python3 main.py`).

    P1-4a packaging: 服务核心 (EmailNotionSyncApp) 已迁入 src/service.py, 这里包装
    成 CLI 子命令, 让打包 venv 内可经 `mailagent serve` 拉起 (取代仓库根 main.py,
    因为 main.py 不在 site-packages)。dev / PM2 仍可直接 `python3 main.py`, 二者走同
    一个 run_service(), 行为一致。

    注意: serve 是长驻进程, 不是一次性命令, 不产出 `-o json` 结构化输出 —— 全局
    -o/--output 对它无意义 (callback 仍会建 CliContext, 但 serve 不读它), 日志走
    setup_logger 配置 (默认到 stderr / 日志文件)。
    """
    # 延迟 import: 避免 --help / 其他子命令解析时载入整个后端链 (与文件其它子命令一致)。
    import asyncio

    from src.service import run_service

    asyncio.run(run_service())


@app.command(name="serve-api")
def serve_api() -> None:
    """启动 MailAgent V2 远程访问本地 FastAPI 后端 (mailagent-api).

    长驻进程，bind 127.0.0.1:8200，唯一对外通道是 cloudflared tunnel (公网不可直连
    端口)。读端点经 EmailRepository 读 SQLite，写端点 subprocess 调本 CLI。设计依据
    frontend/REMOTE-ACCESS.md §3 (FastAPI 设计) + §6.3-6.5 (CF Access JWT + loopback)。

    端口可经 env MAILAGENT_API_PORT 覆盖 (默认 8200)；host 硬绑 127.0.0.1 (§6.4 G2 /
    §6.5 — 不接受非 loopback，外部网卡不可达)。app 的 startup assertion 二次兜底。

    与 `serve` 平行: 同为长驻进程，不产出 `-o json` 结构化输出 (全局 -o/--output 对它
    无意义)；日志走 setup_logger / uvicorn 自身。两个进程读同一份 data/sync_store.db
    (WAL 模式支持并发 reader + 单 mail-sync writer)。

    部署 (REMOTE-ACCESS §3.1):
        pm2 start "mailagent serve-api" --name mailagent-api --interpreter ./venv/bin/python3
    打包共托管场景下，亦可作为 BackendLifecycleManager 的第二个子进程
    spawn(['serve-api'])，与 `serve` 同样的 MAILAGENT_PROJECT_ROOT / MAILAGENT_ENV_FILE /
    SYNC_STORE_DB_PATH env 注入 + before-quit SIGTERM。
    """
    # 延迟 import: 避免 --help / 其他子命令解析时载入 fastapi / uvicorn / 整个后端链
    # (与 serve / 其它子命令一致)。
    import os

    import uvicorn

    # task 06-10-memleak-orphan: 打包态进程护栏 (env-gated, pm2/dev 不设对应
    # env 时零行为变更; 与 serve 入口同一套, 见 src/service.py run_service)。
    # serve-api 无 shutdown_event, mem guard 不传 on_breach → 超限直接走 60s
    # Timer 硬退, Electron 侧 serve-api 崩溃自拉起已有 (backend_lifecycle)。
    from src.utils.mem_guard import maybe_start_tracemalloc, start_mem_guard
    from src.utils.parent_watchdog import start_parent_watchdog

    maybe_start_tracemalloc()
    start_parent_watchdog()
    start_mem_guard()

    host = "127.0.0.1"  # 硬绑 loopback (§6.5 startup assertion 二次校验)
    port = int(os.environ.get("MAILAGENT_API_PORT", "8200"))

    # F1: app 的 lifespan loopback 断言读 MAILAGENT_API_HOST (不是 uvicorn 从不设的
    # UVICORN_HOST)。在 uvicorn.run 前显式落到 env，让那道二次兜底真正生效。
    os.environ["MAILAGENT_API_HOST"] = host

    # 用 import string ("src.api.app:app") 而非 import 后的对象 (uvicorn reload/worker
    # 友好)；log_config=None 让 loguru/uvicorn 自身拥有日志 (与 serve 的 setup_logger
    # 一致，不被 uvicorn 默认 config 覆盖)。
    uvicorn.run(
        "src.api.app:app",
        host=host,
        port=port,
        log_config=None,
    )


@app.callback()
def main(
    ctx: typer.Context,
    output: str = typer.Option(
        "text", "-o", "--output",
        help="Output format: text | json | yaml | ndjson",
    ),
    quiet: bool = typer.Option(False, "-q", "--quiet", help="Suppress stderr summary"),
    verbose: bool = typer.Option(False, "-v", "--verbose", help="DEBUG-level logging"),
    db_path: Optional[str] = typer.Option(
        None, "--db-path", help="Override sync_store.db path",
    ),
    api_key: Optional[str] = typer.Option(
        None, "--api-key", help="Override MAILAGENT_CLI_API_KEY",
    ),
    config: Optional[str] = typer.Option(
        None, "--config", help="Override .env path",
    ),
    no_color: bool = typer.Option(
        False, "--no-color", help="Force no color output",
    ),
    version: bool = typer.Option(
        False, "--version", is_eager=True, callback=_print_version,
        help="Print version and exit",
    ),
) -> None:
    """Global flags handler — builds CliContext for sub-commands."""
    # 延迟 import: 避免 --help / --version 触发整个后端链
    from src.cli.context import CliContext

    # R-18 / PR-2 critic fix #5: 拒绝未知 --output 值 (避免 silent fallback 到 text)
    if output.lower() not in VALID_OUTPUT_FORMATS:
        # 在 callback 内直接 typer.Exit 即可; CliContext 还未存在,
        # 走 typer 的原生 BadParameter 通道, exit code = 2 与 RFC §5.2 一致。
        raise typer.BadParameter(
            f"--output must be one of {VALID_OUTPUT_FORMATS}, got {output!r}",
            param_hint="-o/--output",
        )

    ctx.obj = CliContext.from_flags(
        output=output.lower(),
        quiet=quiet,
        verbose=verbose,
        db_path=db_path,
        api_key=api_key,
        config_path=config,
        no_color=no_color,
    )


if __name__ == "__main__":  # pragma: no cover
    app()
