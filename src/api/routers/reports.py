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


def _custom_agents_enabled() -> bool:
    """读 ``MAILAGENT_CUSTOM_AGENTS_ENABLED``（S5 custom agent 产品面门控）。异常 → fail-closed False。

    与 ``agent_runs._custom_agents_enabled`` 同形（thin config 读, 刻意不跨 router import 私有函数）。
    off → create/run-now 的 custom 分支拒收 = flag-off 字节级维持今日行为。
    """
    from src.api.deps import get_settings

    try:
        return bool(get_settings().custom_agents_enabled)
    except Exception:  # noqa: BLE001 — 配置读失败 → 保守当 feature off
        return False


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
    """新建一个 agent（写）。type 多态（'report' / 'search' / 'preprocess' / 'custom'）。body =
    {id, type?, title?, enabled?, model?, prompt?, tools_json?}（tools_json 为数组）→
    ReportAgentConfig。id 冲突 → 409 E_CONFLICT。

    S5：``type='custom'`` 受 ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` 门控——flag off 时 custom 不在
    白名单 = 维持今日 E_INVALID_ARG 拒收（字节级不变）。flag on 时对 create payload 里的 trigger
    深校验（``validate_agent_config_patch``；NULL/缺 = 草稿态, 允许），并持久化 v30 三字段（若带）。
    """
    raw = body or {}
    agent_id = str(raw.get("id") or "").strip()
    if not agent_id:
        raise APIError("E_INVALID_ARG", "id is required", source="sqlite")
    agent_type = str(raw.get("type") or "report")
    # custom 分支仅在 flag on 时进白名单（off → 落到今日的 E_INVALID_ARG 拒收, 字节级不变）。
    allowed_types = ["report", "search", "preprocess"]
    if _custom_agents_enabled():
        allowed_types.append("custom")
    if agent_type not in allowed_types:
        raise APIError(
            "E_INVALID_ARG",
            f"type must be {'|'.join(allowed_types)}, got {agent_type!r}",
            source="sqlite",
        )
    # custom：**在 store.create_agent 之前**深校验 + 结构转换 v30 三字段——trigger 深校验（坏
    # cron/未知 kind/超长 pattern → 400，给 owner 反馈；NULL/缺 = 草稿态放行）+ tool_policy/budget
    # 结构闸（config_patch_to_db 非 dict → ValueError → 400）。放建行前 = 任何坏配置拒收且**不建
    # 行**（create 端点原子性；否则坏 tool_policy/budget 会在建行之后才 400 留下孤儿草稿行）。转换
    # 结果留到建行后 update 落库（store.create_agent 不接受这三列）。
    v30_patch: Optional[dict[str, Any]] = None
    if agent_type == "custom":
        from src.agents.trigger import validate_agent_config_patch

        try:
            validate_agent_config_patch(raw)
            v30_raw = {k: raw[k] for k in ("trigger", "tool_policy", "budget") if k in raw}
            if v30_raw:
                v30_patch = wire.config_patch_to_db(v30_raw)
        except ValueError as exc:
            raise APIError("E_INVALID_ARG", str(exc), source="sqlite")
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
    # custom：v30 三字段（已在建行前深校验+转换）经 update 落库——store.create_agent 不接受这三列，
    # 单独 update，避免「带 trigger 建 agent」时静默丢弃。单源复用 set_config 的规范化（wire）。
    if v30_patch:
        agent = store.update_agent(agent_id, v30_patch) or agent
    return success_envelope(wire.resolve_agent(agent), request=request, source="sqlite")


@router.put("/report-agents/{agent_id}", dependencies=[Depends(verify_cf_access)])
async def set_config(request: Request, agent_id: str, body: Optional[dict[str, Any]] = None):
    """部分更新 agent 配置（写）。镜像 report:setConfig。body = friendly patch
    （ReportConfigPatch）→ ReportAgentConfig。"""
    raw = body or {}
    # S4: 保存时深校验 custom agent trigger（坏 cron/未知 kind/超长 pattern → 400，给 owner 反馈；
    # 运行时 worker/dispatch 仍 fail-closed 双保险）。TriggerValidationError 是 ValueError 子类。
    from src.agents.trigger import validate_agent_config_patch
    try:
        validate_agent_config_patch(raw)
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
    """删一行 agent 配置（写）。镜像 IPC report:deleteAgent → {deleted}。404 当不存在。

    S5 级联（ADR-004 §3.3 ④，codex P1-5）：随删该 agent 的 per-agent policy_rules
    （agent_config.db）—— 悬空规则匹配不到 run，但会在 Settings 留鬼行。best-effort：
    agent_config.db 不可得（裸 worktree）不阻断删除本体。"""
    store = get_report_store()
    if not store.delete_agent(agent_id):
        raise APIError("E_NOT_FOUND", f"report_agent {agent_id!r} not found", source="sqlite")
    try:
        from src.agent_config.store import get_agent_config_store

        get_agent_config_store().delete_policy_rules_for_agent(agent_id)
    except Exception:  # noqa: BLE001 — 级联清理 best-effort，不阻断删除
        pass
    return success_envelope({"deleted": agent_id}, request=request, source="sqlite")


@router.post("/report-agents/{agent_id}/run", dependencies=[Depends(verify_cf_access)])
async def run_now(request: Request, agent_id: str, body: Optional[dict[str, Any]] = None):
    """立即触发一次 agent run（写）。type 分流：

    - ``report`` → 同步 in-process 生成一份报告（路径 B，report 专属，**冻结不扩权**）。镜像
      report:runNow → ReportRunResult。body 可含 {cadence}。
    - ``custom`` → S4 enqueue（``run_queue.enqueue_agent_run`` → AgentRunWorker 认领 → gateway
      headless drain）。幂等键 ``agent_run:{id}:manual:{uuid}``，受 runs/day 门 + budget；返回
      {jobId}。**绝不**沿路径 B（tests/agents 有 tripwire 守）。flag off → 拒收（S4 纪律）。
    - 其它（search/preprocess）→ 拒（manual run 仅 report/custom）。
    """
    opts = body or {}
    store = get_report_store()
    agent = store.get_agent(agent_id)
    if agent is None:
        raise APIError("E_NOT_FOUND", f"report_agent {agent_id!r} not found", source="sqlite")
    agent_type = agent.get("type", "report")

    if agent_type == "custom":
        # flag off → 拒收（对齐 S4 端点纪律；正常态下 custom agent 应在 flag on 时才被创建）。
        if not _custom_agents_enabled():
            raise APIError(
                "E_INVALID_ARG", "custom agents feature is disabled", source="sqlite"
            )
        import uuid

        from src.agents.run_queue import enqueue_agent_run
        from src.agents.trigger import parse_budget
        from src.api.deps import get_job_repo

        # 手动触发 → trigger_kind='manual'（gateway 侧 contextMode 从 'manual' 派生成 fail-closed
        # untrusted_trigger；无 email envelope）。幂等键随机 uuid → 每次手动都新起一 run（不与
        # cron/email 的 fire_key 撞）；仍过 runs/day 门（enqueue_agent_run 内）。
        budget = parse_budget(agent.get("budget_json"))
        outcome = enqueue_agent_run(
            get_job_repo(),
            agent_id=agent_id,
            trigger_kind="manual",
            fire_key=f"manual:{uuid.uuid4().hex}",
            budget=budget,
        )
        if outcome is None:
            raise APIError(
                "E_BUDGET",
                f"agent {agent_id!r} hit max_runs_per_day (budget), run not enqueued",
                source="sqlite",
            )
        job_id, was_created = outcome
        return success_envelope(
            {"jobId": job_id, "agentId": agent_id, "wasCreated": was_created},
            request=request,
            source="sqlite",
        )

    if agent_type != "report":
        raise APIError(
            "E_INVALID_ARG",
            f"agent {agent_id!r} is type {agent_type!r};"
            " manual run is report/custom only",
            source="sqlite",
        )

    # ── report 路径 B（同步 in-process 生成，report-only 冻结）─────────────────────
    cadence = opts.get("cadence")
    if cadence is not None and cadence not in ("daily", "weekly", "monthly"):
        raise APIError(
            "E_INVALID_ARG", "cadence must be daily | weekly | monthly", source="sqlite"
        )
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


# ============================================================
# 项目周报同步执行历史（读，v1.3.0 dogfood R5）
# ============================================================
def _project_progress_run_item(rec: Any) -> dict[str, Any]:
    """``ProjectProgressSyncRecord`` → 前端 ``ProjectProgressRunItem`` 投影。

    只暴露历史卡需要的字段（状态 / 时间 / 错误 / 邮件标识 / 项目计数）；时间戳保持
    Unix 秒（前端 fmtTime 自适应秒/毫秒）。custom agent 的 async_jobs run 历史体系刻意不复用
    —— 项目周报是确定性 Python 直调、自有 status 词表（processing/completed/failed/skipped）。
    """
    return {
        "internalId": rec.email_internal_id,
        "subject": rec.email_subject,
        "weekTag": rec.week_tag,
        "filename": rec.xlsx_filename,
        "status": rec.status,
        "error": rec.error,
        "startedAt": rec.started_at,
        "completedAt": rec.completed_at,
        "projectsTotal": rec.projects_total,
        "projectsCreated": rec.projects_created,
        "projectsUpdated": rec.projects_updated,
        "projectsFailed": rec.projects_failed,
    }


@router.get("/project-progress/runs", dependencies=[Depends(verify_cf_access)])
async def list_project_progress_runs(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
):
    """项目周报同步的近期执行记录（读）。包 ``ProjectProgressSyncStore.list_recent``；
    按 completed_at/started_at 倒序。抽屉「执行历史」区数据源。"""
    from src.api.deps import get_project_progress_store

    store = get_project_progress_store()
    rows = store.list_recent(limit=limit)
    items = [_project_progress_run_item(r) for r in rows]
    return success_envelope(
        items, request=request, source="sqlite", meta_extra={"count": len(items)}
    )
