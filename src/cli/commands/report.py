"""mailagent report — 报告 Agent 的运行 / 列表 / 配置（前端 /agents 页的 IPC 后端）。

Subcommands:
- ``run --agent <id> [--cadence <c>]`` — 立即生成一份报告（写, needs auth；跑 LLM）。
- ``list [--cadence] [--agent] [--limit]`` — 报告列表（读，不含 blocks）。
- ``get <report_id>`` — 单份报告详情（读，含 blocks + counts 解析）。
- ``config-get [--agent <id>]`` — agent 配置（读，prompt 缺省回填默认 + schedule 解析）。
- ``config-set --agent <id> --patch <json>`` — 部分更新 agent 配置（写, needs auth）。

业务逻辑全在 ``src/reports/``（store/worker/prompts）；本模块只做
(parse args → call → emit)。读形状投影（resolve_agent / parse_counts / report 投影）
+ config patch 规范化下沉 ``src/reports/wire.py``（CLI + serve-api 单一真源）。
Electron main 的 report:list / report:get 直读 sync_store.db（better-sqlite3，热路径）；
report:runNow / getConfig / setConfig 经 serve-api（in-process ReportStore + wire）。
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import CliError, CliInvalidArgError, CliNotFoundError
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error
from src.reports import wire

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.reports.store import ReportStore

app = typer.Typer(
    name="report",
    help="报告 Agent: run / list / get / config-get / config-set",
    no_args_is_help=True,
)

_DEFAULT_AGENT_ID = "daily_email_digest"


def _store(cli: "CliContext") -> "ReportStore":
    from src.reports.store import ReportStore

    return ReportStore(db_path=cli.cli_config.sync_store_db_path)


# ============================================================
# run — 立即生成（写）
# ============================================================
@app.command("run")
def report_run(
    ctx: typer.Context,
    agent_id: str = typer.Option(_DEFAULT_AGENT_ID, "--agent", help="report_agent.id"),
    cadence: Optional[str] = typer.Option(
        None, "--cadence", help="覆盖本次 cadence: daily | weekly | monthly（默认用 agent 配置）",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """立即跑一次报告生成（runNow）。返回 {report_id, status, headline, cadence, report_date}。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    if cadence is not None and cadence not in ("daily", "weekly", "monthly"):
        raise emit_cli_error(
            cli, CliInvalidArgError("--cadence must be daily | weekly | monthly")
        )

    store = _store(cli)
    agent = store.get_agent(agent_id)
    if agent is None:
        raise emit_cli_error(cli, CliNotFoundError(f"report_agent {agent_id!r} not found"))

    # --cadence 覆盖：在副本里改 schedule_json 的 cadence（不落库）。
    if cadence is not None:
        try:
            sched = json.loads(agent.get("schedule_json") or "{}") or {}
        except (json.JSONDecodeError, TypeError):
            sched = {}
        sched["cadence"] = cadence
        agent = {**agent, "schedule_json": json.dumps(sched, ensure_ascii=False)}

    from src.reports.worker import run_report_once

    try:
        rid = asyncio.run(
            run_report_once(
                store=store,
                db_path=cli.cli_config.sync_store_db_path,
                agent=agent,
            )
        )
    except Exception as e:  # noqa: BLE001 — 兜底成结构化 CLI error
        raise emit_cli_error(cli, CliError(f"report generation failed: {e}"))

    row = store.get_report(rid) or {}
    emit(
        cli,
        {
            "report_id": rid,
            "status": row.get("status", "unknown"),
            "headline": row.get("headline") or "",
            "cadence": row.get("cadence"),
            "report_date": row.get("report_date"),
            "error": row.get("error"),
        },
    )


# ============================================================
# list — 报告列表（读）
# ============================================================
@app.command("list")
def report_list(
    ctx: typer.Context,
    cadence: Optional[str] = typer.Option(None, "--cadence", help="筛选 cadence"),
    agent_id: Optional[str] = typer.Option(None, "--agent", help="筛选 agent_id"),
    limit: int = typer.Option(50, "--limit"),
    offset: int = typer.Option(0, "--offset"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """报告列表（不含 blocks_json）；counts_json 解析为对象。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    store = _store(cli)
    rows = store.list_reports(cadence=cadence, agent_id=agent_id, limit=limit, offset=offset)
    items = [wire.report_to_list_item(r) for r in rows]
    emit(cli, items, meta_extra={"count": len(items)})


# ============================================================
# get — 单份报告详情（读）
# ============================================================
@app.command("get")
def report_get(
    ctx: typer.Context,
    report_id: str = typer.Argument(..., help="report.id（如 daily_email_digest:daily:2026-06-02）"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """单份报告（含 blocks + counts 解析）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    store = _store(cli)
    row = store.get_report(report_id)
    if row is None:
        raise emit_cli_error(cli, CliNotFoundError(f"report {report_id!r} not found"))
    emit(cli, wire.report_to_detail(row))


# ============================================================
# delete — 删一份报告（写）
# ============================================================
@app.command("delete")
def report_delete(
    ctx: typer.Context,
    report_id: str = typer.Argument(..., help="report.id"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """删除一份报告。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)
    store = _store(cli)
    if not store.delete_report(report_id):
        raise emit_cli_error(cli, CliNotFoundError(f"report {report_id!r} not found"))
    emit(cli, {"deleted": report_id})


# ============================================================
# config-get — agent 配置（读）
# ============================================================
@app.command("config-get")
def report_config_get(
    ctx: typer.Context,
    agent_id: Optional[str] = typer.Option(None, "--agent", help="只取单个 agent；留空 = 全部"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """agent 配置（prompt 缺省回填默认、schedule 解析、bool 还原）。无 --agent 返回全部。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    store = _store(cli)
    if agent_id:
        agent = store.get_agent(agent_id)
        if agent is None:
            raise emit_cli_error(cli, CliNotFoundError(f"report_agent {agent_id!r} not found"))
        emit(cli, wire.resolve_agent(agent))
        return
    agents = [wire.resolve_agent(a) for a in store.list_agents()]
    emit(cli, agents, meta_extra={"count": len(agents)})


# ============================================================
# config-set — 部分更新 agent 配置（写）
# ============================================================
@app.command("config-set")
def report_config_set(
    ctx: typer.Context,
    agent_id: str = typer.Option(_DEFAULT_AGENT_ID, "--agent", help="report_agent.id"),
    patch: str = typer.Option(..., "--patch", help="JSON：{enabled,title,prompt,model,window_hours,schedule,kos_enrich}"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """部分更新 agent 配置。friendly patch → DB 列（schedule→schedule_json, bool→int）。"""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    try:
        cli.require_auth()
    except CliError as e:
        raise emit_cli_error(cli, e)

    try:
        raw = json.loads(patch)
        if not isinstance(raw, dict):
            raise ValueError("patch must be a JSON object")
    except (json.JSONDecodeError, ValueError) as e:
        raise emit_cli_error(cli, CliInvalidArgError(f"--patch invalid JSON: {e}"))

    try:
        db_patch = wire.config_patch_to_db(raw)
    except ValueError as e:
        raise emit_cli_error(cli, CliInvalidArgError(str(e)))

    store = _store(cli)
    if store.get_agent(agent_id) is None:
        raise emit_cli_error(cli, CliNotFoundError(f"report_agent {agent_id!r} not found"))
    updated = store.update_agent(agent_id, db_patch)
    emit(cli, wire.resolve_agent(updated) if updated else {})
