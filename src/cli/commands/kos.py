"""mailagent kos — KOS (Jarvis 知识库) 入库台账统计。

Subcommands:
- ``stats [--days N]`` — ``kos_ingest_log`` 状态分布 / 错误码分布 / 重试积压 +
  ``sync_state`` 的 ``kos.*`` 健康指标（读，无需 auth，对齐 ``llm stats``）。

聚合 SQL **不在这里** —— 单源在 ``src/kos/stats.py::collect_kos_stats``，serve-api
的 ``GET /api/kos/stats`` 调同一个函数（PRD R8：不重蹈 llm 那两份手抄 SQL）。
本模块只做 (parse args → call → emit)。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliInvalidArgError
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error
from src.kos.stats import collect_kos_stats

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="kos",
    help="KOS 入库台账: stats",
    no_args_is_help=True,
)


@app.command("stats")
def kos_stats(
    ctx: typer.Context,
    days: int = typer.Option(
        7, "--days", help="过去 N 天的 stats (-1 表示全量)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """``kos_ingest_log`` 统计 (status 分布 + 错误码分布 + 重试积压 + 健康)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if days == 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--days 0 invalid; 用 -1 (全量) 或 >=1",
        ))

    data = collect_kos_stats(cli.cli_config.sync_store_db_path, days=days)

    if cli.output.lower() == "text":
        _print_text(data)
    else:
        emit(cli, data)


def _print_text(data: dict) -> None:
    by_status = data["by_status"]
    print(f"enabled={data['enabled']}  days={data['days']}  total={data['total']}")
    for k, v in sorted(by_status.items()):
        print(f"  {k:12} {v}")
    print(f"pending_retry    {data['pending_retry']}")
    print(f"dead_count       {data['dead_count']}")
    if data["by_error_code"]:
        print("by_error_code:")
        for k, v in sorted(data["by_error_code"].items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  {k:24} {v}")
    health = data["health"]  # None = 从未探活
    print(f"health           {'(never probed)' if health is None else ('ok' if health['ok'] else 'error')}")
    if health and health["detail"]:
        print(f"health_detail    {health['detail']}")
    print(f"last_success_ts  {data['last_success_ts'] or '(none)'}")
