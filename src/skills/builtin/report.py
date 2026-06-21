"""report skill —— 跑 / 读 MailAgent 报告 Agent。

镜像 ``src/api/routers/reports.py``：``ReportStore`` + ``src/reports/wire.py`` 投影 +
``run_report_once``（in-process，**不 fork CLI**）。``report_run`` 是 P1 handoff 的执行能力，
返回 ``report_id`` 后可 ``report_get`` 取详情。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from src.reports import wire
from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_VALID_CADENCE = ("daily", "weekly", "monthly")


def _report_list(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    store = ctx.report_store()
    rows = store.list_reports(
        cadence=params.get("cadence"),
        agent_id=params.get("agent_id"),
        limit=int(params.get("limit") or 50),
        offset=int(params.get("offset") or 0),
    )
    items = [wire.report_to_list_item(r) for r in rows]
    return {"items": items, "count": len(items)}


def _report_get(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    report_id = str(params["report_id"])
    row = ctx.report_store().get_report(report_id)
    if row is None:
        raise SkillError("E_NOT_FOUND", f"report {report_id!r} not found", http_status=404)
    return wire.report_to_detail(row)


def _report_run(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    """同步阻塞（blocking=True → invoke 跑在 to_thread）：独立 event loop 跑 run_report_once。"""
    from src.reports.worker import run_report_once

    store = ctx.report_store()
    agent_id = str(params["agent_id"])
    cadence = params.get("cadence")
    if cadence is not None and cadence not in _VALID_CADENCE:
        raise SkillError("E_INVALID_ARG", f"cadence must be {'|'.join(_VALID_CADENCE)}")

    agent = store.get_agent(agent_id)
    if agent is None:
        raise SkillError("E_NOT_FOUND", f"report_agent {agent_id!r} not found", http_status=404)
    if agent.get("type", "report") != "report":
        raise SkillError(
            "E_INVALID_ARG",
            f"agent {agent_id!r} is type {agent.get('type')!r}, not a report agent; "
            "manual run is report-only",
        )
    if cadence is not None:
        try:
            sched = json.loads(agent.get("schedule_json") or "{}") or {}
        except (json.JSONDecodeError, TypeError):
            sched = {}
        sched["cadence"] = cadence
        agent = {**agent, "schedule_json": json.dumps(sched, ensure_ascii=False)}

    try:
        rid = asyncio.run(run_report_once(store=store, db_path=store.db_path, agent=agent))
    except Exception as exc:  # noqa: BLE001 — 兜底成结构化 skill error
        raise SkillError("E_LLM_FAILED", f"report generation failed: {exc}", http_status=500)

    row = store.get_report(rid) or {}
    return {
        "report_id": rid,
        "status": row.get("status", "unknown"),
        "headline": row.get("headline") or "",
        "cadence": row.get("cadence"),
        "report_date": row.get("report_date"),
        "error": row.get("error"),
    }


def build_skill() -> BoundSkill:
    tools = [
        BoundTool(
            ToolDef(
                name="report_list",
                description="List generated reports (newest first; no block bodies).",
                input_schema={
                    "type": "object",
                    "properties": {
                        "cadence": {"type": "string", "enum": list(_VALID_CADENCE)},
                        "agent_id": {"type": "string"},
                        "limit": {"type": "integer"},
                        "offset": {"type": "integer"},
                    },
                },
                output_schema={"type": "object", "description": "{items, count}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["report:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="ReportStore.list_reports"),
            ),
            _report_list,
        ),
        BoundTool(
            ToolDef(
                name="report_get",
                description="Fetch one report's full detail (blocks doc + counts).",
                input_schema={
                    "type": "object",
                    "properties": {"report_id": {"type": "string"}},
                    "required": ["report_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["report:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="ReportStore.get_report"),
            ),
            _report_get,
        ),
        BoundTool(
            ToolDef(
                name="report_run",
                description="Run a report agent now (calls the LLM); returns the new report_id.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "agent_id": {"type": "string"},
                        "cadence": {"type": "string", "enum": list(_VALID_CADENCE)},
                    },
                    "required": ["agent_id"],
                },
                output_schema={
                    "type": "object",
                    "description": "{report_id, status, headline, cadence, report_date, error}",
                },
                confirmation_tier="preview",
                side_effect="external_call",
                auth_scopes=["report:run"],
                mcp_exposed=True,
                timeout_ms=120000,
                handler=ToolHandler(kind="service", target="reports.run_report_once"),
            ),
            _report_run,
            blocking=True,
        ),
    ]
    return BoundSkill(
        name="report",
        version="1.0.0",
        title="Reports",
        description="Run and read MailAgent report agents (daily/weekly/monthly digests).",
        default_enabled=True,
        prompt_fragment=(
            "Use report_list to see existing reports, report_get to read one, and report_run "
            "to generate a fresh report for an agent_id (this calls the LLM and returns a "
            "report_id you can then report_get)."
        ),
        docs_path="skills/report/SKILL.md",
        tools=tools,
    )
