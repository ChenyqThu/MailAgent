"""reports 路由 — /api/reports/* + /api/report-agents/* (V2.1 远程 Agent 报告 + 配置)。

镜像本地 Electron IPC ``handlers/report.ts``（report:list/get/getConfig/setConfig/
runNow/delete），但 **in-process 复用 ``ReportStore`` + ``src/reports/wire.py``**
（不 fork CLI，照 service-layer 范式）。读形状投影 + config patch 规范化的单一真源
= ``src/reports/wire.py``（CLI + serve-api 共用，避免两份手抄）。

**修「本地 /agents 列表慢」根因**：getConfig 经 ``wire.resolve_agent`` in-process
回填默认 prompt（``get_default_prompt``，~ms），取代旧 ``report.ts`` fork CLI
``report config-get``（冷启 ~759ms+）。本地 ``report.ts`` getConfig 改走本端点。

鉴权：所有端点 ``Depends(verify_cf_access)``（远程 CF Access / 本地 token）。report
写不涉及 outbox / pm2，直接 ReportStore。形状权威 = 前端 ``ReportListItem`` /
``ReportDetail`` / ``ReportAgentConfig`` / ``ReportRunResult``（``types.ts``）。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_report_store
from src.reports import wire

router = APIRouter(prefix="/api", tags=["reports"])


# ============================================================
# report 产物（读 + 删）
# ============================================================
@router.get("/reports", dependencies=[Depends(verify_cf_access)])
async def list_reports(
    request: Request,
    cadence: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None, alias="agentId"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """报告列表（不含 blocks_json）。镜像 report:list → ReportListItem[]。"""
    store = get_report_store()
    rows = store.list_reports(cadence=cadence, agent_id=agent_id, limit=limit, offset=offset)
    items = [wire.report_to_list_item(r) for r in rows]
    return success_envelope(
        items, request=request, source="sqlite", meta_extra={"count": len(items)}
    )


@router.get("/reports/{report_id}", dependencies=[Depends(verify_cf_access)])
async def get_report(request: Request, report_id: str):
    """单份报告详情（含 blocks_json → doc）。镜像 report:get → ReportDetail。404 当不存在。"""
    store = get_report_store()
    row = store.get_report(report_id)
    if row is None:
        raise APIError("E_NOT_FOUND", f"report {report_id!r} not found", source="sqlite")
    return success_envelope(wire.report_to_detail(row), request=request, source="sqlite")


@router.delete("/reports/{report_id}", dependencies=[Depends(verify_cf_access)])
async def delete_report(request: Request, report_id: str):
    """删一份报告（写）。镜像 report:delete → {deleted}。404 当不存在。"""
    store = get_report_store()
    if not store.delete_report(report_id):
        raise APIError("E_NOT_FOUND", f"report {report_id!r} not found", source="sqlite")
    return success_envelope({"deleted": report_id}, request=request, source="sqlite")


# ============================================================
# report_agent 配置（读 + 改 + 跑）
# ============================================================
@router.get("/report-agents", dependencies=[Depends(verify_cf_access)])
async def get_config(
    request: Request,
    agent_id: Optional[str] = Query(None, alias="agentId"),
):
    """agent 配置（in-process resolve，含默认 prompt）。镜像 report:getConfig →
    ReportAgentConfig[]。无 agentId 返回全部。"""
    store = get_report_store()
    if agent_id:
        agent = store.get_agent(agent_id)
        if agent is None:
            raise APIError(
                "E_NOT_FOUND", f"report_agent {agent_id!r} not found", source="sqlite"
            )
        return success_envelope(wire.resolve_agent(agent), request=request, source="sqlite")
    agents = [wire.resolve_agent(a) for a in store.list_agents()]
    return success_envelope(
        agents, request=request, source="sqlite", meta_extra={"count": len(agents)}
    )


@router.post("/report-agents", dependencies=[Depends(verify_cf_access)])
async def create_agent(request: Request, body: Optional[dict[str, Any]] = None):
    """新建一个 agent（写）。type 多态（'report' / 'search'）。body =
    {id, type?, title?, enabled?, model?, prompt?, tools_json?}（tools_json 为数组）→
    ReportAgentConfig。id 冲突 → 409 E_CONFLICT。"""
    raw = body or {}
    agent_id = str(raw.get("id") or "").strip()
    if not agent_id:
        raise APIError("E_INVALID_ARG", "id is required", source="sqlite")
    agent_type = str(raw.get("type") or "report")
    if agent_type not in ("report", "search"):
        raise APIError(
            "E_INVALID_ARG", f"type must be report|search, got {agent_type!r}", source="sqlite"
        )
    tools = raw.get("tools_json")
    tools_json = (
        json.dumps(tools, ensure_ascii=False) if isinstance(tools, list) else None
    )
    store = get_report_store()
    try:
        agent = store.create_agent(
            agent_id,
            type=agent_type,
            title=raw.get("title"),
            enabled=bool(raw.get("enabled", False)),
            model=raw.get("model"),
            prompt=raw.get("prompt"),
            tools_json=tools_json,
        )
    except ValueError as exc:
        raise APIError("E_CONFLICT", str(exc), http_status=409, source="sqlite")
    return success_envelope(wire.resolve_agent(agent), request=request, source="sqlite")


@router.put("/report-agents/{agent_id}", dependencies=[Depends(verify_cf_access)])
async def set_config(request: Request, agent_id: str, body: Optional[dict[str, Any]] = None):
    """部分更新 agent 配置（写）。镜像 report:setConfig。body = friendly patch
    （ReportConfigPatch）→ ReportAgentConfig。"""
    raw = body or {}
    try:
        db_patch = wire.config_patch_to_db(raw)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite")
    store = get_report_store()
    if store.get_agent(agent_id) is None:
        raise APIError("E_NOT_FOUND", f"report_agent {agent_id!r} not found", source="sqlite")
    updated = store.update_agent(agent_id, db_patch)
    return success_envelope(
        wire.resolve_agent(updated) if updated else {}, request=request, source="sqlite"
    )


@router.delete("/report-agents/{agent_id}", dependencies=[Depends(verify_cf_access)])
async def delete_agent(request: Request, agent_id: str):
    """删一行 agent 配置（写）。镜像 IPC report:deleteAgent → {deleted}。404 当不存在。"""
    store = get_report_store()
    if not store.delete_agent(agent_id):
        raise APIError("E_NOT_FOUND", f"report_agent {agent_id!r} not found", source="sqlite")
    return success_envelope({"deleted": agent_id}, request=request, source="sqlite")


@router.post("/report-agents/{agent_id}/run", dependencies=[Depends(verify_cf_access)])
async def run_now(request: Request, agent_id: str, body: Optional[dict[str, Any]] = None):
    """立即生成一份报告（写，跑 LLM）。镜像 report:runNow → ReportRunResult。body 可含 {cadence}。

    同步 in-process：``await asyncio.to_thread(asyncio.run, run_report_once(...))``，与 CLI
    ``report run`` 行为一致（独立 event loop，避免 LLM httpx client 绑 serve-api loop）。
    """
    opts = body or {}
    cadence = opts.get("cadence")
    if cadence is not None and cadence not in ("daily", "weekly", "monthly"):
        raise APIError(
            "E_INVALID_ARG", "cadence must be daily | weekly | monthly", source="sqlite"
        )

    store = get_report_store()
    agent = store.get_agent(agent_id)
    if agent is None:
        raise APIError("E_NOT_FOUND", f"report_agent {agent_id!r} not found", source="sqlite")

    # --cadence 覆盖：在副本里改 schedule_json 的 cadence（不落库），对齐 CLI report run。
    if cadence is not None:
        try:
            sched = json.loads(agent.get("schedule_json") or "{}") or {}
        except (json.JSONDecodeError, TypeError):
            sched = {}
        sched["cadence"] = cadence
        agent = {**agent, "schedule_json": json.dumps(sched, ensure_ascii=False)}

    try:
        rid = await asyncio.to_thread(_run_report_once_sync, store, store.db_path, agent)
    except Exception as exc:  # noqa: BLE001 — 兜底成结构化 API error
        raise APIError("E_LLM_FAILED", f"report generation failed: {exc}", source="cli")

    row = store.get_report(rid) or {}
    return success_envelope(
        {
            "report_id": rid,
            "status": row.get("status", "unknown"),
            "headline": row.get("headline") or "",
            "cadence": row.get("cadence"),
            "report_date": row.get("report_date"),
            "error": row.get("error"),
        },
        request=request,
        source="cli",
    )


def _run_report_once_sync(store: Any, db_path: str, agent: dict) -> str:
    """同步包装 ``run_report_once``（独立 event loop，与 CLI ``asyncio.run`` 一致）。"""
    from src.reports.worker import run_report_once

    return asyncio.run(run_report_once(store=store, db_path=db_path, agent=agent))
