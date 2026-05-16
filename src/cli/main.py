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
from src.cli.commands import email as _email_module  # noqa: E402

app.add_typer(_email_module.app, name="email", help="邮件 CRUD / 搜索 / 重传")
app.add_typer(_admin_module.app, name="admin", help="统计 / 健康 / db-version")


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
