"""agent-runs 路由 — custom agent headless run 的 spec 面 + 审批终态回写（S4 W2, ADR D2/D4）。

拓扑（pull 模型，权威事实绝不来自请求体）
------------------------------------------------
``AgentRunWorker``（Python）认领 ``async_jobs(job_type='agent_run')`` → poke gateway
``POST /api/ai/agent-run {jobId, claimToken}``（W3）→ gateway 凭 jobId+claimToken **回拉**
本 ``GET /api/agent-runs/{id}/spec`` 取权威 spec（原子 CAS one-shot）→ contextMode 从 spec
的 ``trigger.kind`` 在 gateway 可信代码里派生 → ``prepareChatRun`` drain。请求体永不携带
prompt/toolPolicy/trigger.kind，杜绝本机进程伪造 ``trigger.kind='cron'`` + 宽 toolPolicy。

🔴 鉴权 = ``verify_local_token``（**仅**本地 ephemeral token 腿，**不接受** CF JWT）——同
``/api/exec/*`` / island ``/agent/announce`` 纪律。唯一调用方 = Electron 主进程内嵌 gateway
的 domainClient（同机 loopback，恒带 ``X-MailAgent-Local-Token``）。serve-api 经 cloudflared
暴露公网，若挂 ``verify_cf_access`` 则持/窃 owner CF 会话者可远程 curl 拿 spec / 伪造审批终态。

flag ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` 门控：off → 两端点 404（feature 不存在）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request
from loguru import logger
from pydantic import BaseModel

from src.agents.fence import fence_email_envelope
from src.agents.run_state import AGENT_RUN_STATES, derive_agent_run_state
from src.agents.trigger import (
    EmailFilterTrigger,
    ToolPolicy,
    TriggerValidationError,
    parse_budget,
    parse_tool_policy,
    parse_trigger,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_job_repo, get_report_store, get_repository
from src.sync.async_jobs import AsyncJob

router = APIRouter(prefix="/api/agent-runs", tags=["agent-runs"])


# ── per-agent 工具面常量（S5 ADR-004 §5.1 / D3，单源 —— spec 投影与 Settings tool-options
# 端点同源，前端不手抄第二份）──────────────────────────────────────────────────────────

# 🔴 默认安全集：type='custom' 且 tool_policy_json 为 NULL / 缺 allowed_tools 时投影此集 ——
# 语义从「NULL=不收窄」改为「NULL=默认安全集」（对 ADR-003 D6 的**显式修订**，codex P1-1：
# 「Settings 模板不勾 kos_query」挡不住 API 直建/空策略行，收窄必须是投影层结构性保证）。
# 排除在默认集外（owner 显式勾选才有）：kos_query（trusted-sink 残余面）、chat_session_*
# （历史会话=二阶注入面）、agent_profile_read/history（身份文档不进 untrusted 上下文）、
# discover_skills / skill_* / report_* / plan_update（headless 默认无需求）。
DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS: tuple[str, ...] = (
    # email 读族（headless agent 的最小工作集）
    "email_search", "email_search_fulltext", "email_get", "email_body",
    "email_list_thread", "email_search_attachments",
    # domain_write 族（注册 ≠ 免卡：无 D1 规则时仍恒岛卡）
    "email_flag", "email_archive", "email_pin", "email_resync", "email_draft_reply",
)

# headless 可用工具全集 = 矩阵地板内 read + domain_write（与 gateway policy.ts
# GATEWAY_TOOL_CLASSES / tests/agent_eval/tool_catalog.json 的 tool_class 轴同源；
# tests/api 有 catalog 一致性闸，新读/写工具漏此表必红）。exec / outbound /
# capability_change 结构性缺席（ADR-004 D2/D3：exec 走 grant_exec 矩阵例外，非此列表）。
HEADLESS_TOOL_OPTIONS: tuple[tuple[str, str], ...] = (
    ("agent_profile_history", "read"),
    ("agent_profile_read", "read"),
    ("chat_session_get", "read"),
    ("chat_session_list", "read"),
    ("chat_session_search", "read"),
    ("discover_skills", "read"),
    ("email_body", "read"),
    ("email_get", "read"),
    ("email_list_thread", "read"),
    ("email_search", "read"),
    ("email_search_attachments", "read"),
    ("email_search_fulltext", "read"),
    ("kos_query", "read"),
    ("plan_update", "read"),
    ("report_get", "read"),
    ("report_list", "read"),
    ("skill_list_installed", "read"),
    ("skill_read", "read"),
    ("email_archive", "domain_write"),
    ("email_draft_reply", "domain_write"),
    ("email_flag", "domain_write"),
    ("email_pin", "domain_write"),
    ("email_resync", "domain_write"),
)


# ── flag gate ───────────────────────────────────────────────────────────────────


def _custom_agents_enabled() -> bool:
    """读 ``MAILAGENT_CUSTOM_AGENTS_ENABLED``（pydantic validation_alias）。异常 → fail-closed False。"""
    from src.api.deps import get_settings

    try:
        return bool(get_settings().custom_agents_enabled)
    except Exception:  # noqa: BLE001 — 配置读失败 → 保守当 feature off
        return False


def _require_flag() -> None:
    """flag off → 404（feature 不存在；对齐 aguiMirror off 形状）。挂在 verify_local_token 之后。"""
    if not _custom_agents_enabled():
        raise APIError(
            "E_NOT_FOUND",
            "custom agents feature is disabled",
            http_status=404,
            source="agent-runs",
        )


# ── spec 组装 helpers（纯逻辑，从 job.params + report_agent 行派生）─────────────────


def _tool_policy_lenient(raw: Any) -> ToolPolicy:
    """tool_policy_json → ``ToolPolicy``（读侧宽容包装：保存时 ``validate_agent_config_patch``
    已严格拒，运行时坏形状 → 未配置语义 = 默认安全集 + 无 grant，fail-closed 方向，不炸 run）。"""
    try:
        return parse_tool_policy(raw)
    except ValueError:
        return ToolPolicy()


def _parse_fallback_models(raw: Any) -> Optional[list[str]]:
    """fallback_models_json → list[str] 或 None（跟随全局）。非法/非 list → None。"""
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, list):
        return None
    return [str(x) for x in data]


def _fired_at_iso(trigger_kind: Optional[str], fire_key: Any, created_at: float) -> str:
    """firedAt ISO：cron 用 fire_key 的 occurrence 时刻（``%Y%m%dT%H%M%SZ`` UTC），否则用
    job.created_at（email 触发 = 入队即 fire）。fire_key 解析失败回退 created_at。"""
    if trigger_kind == "cron" and isinstance(fire_key, str):
        try:
            dt = datetime.strptime(fire_key, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except (ValueError, TypeError):
            pass
    return datetime.fromtimestamp(created_at, tz=timezone.utc).isoformat()


def _session_title(agent: dict, agent_id: str, fired_at_iso: str) -> str:
    """``{agent.title} · {firedAt 本地时刻}``（ADR D2）。title 空回退 agent_id。"""
    title = (agent.get("title") or "").strip() or agent_id
    try:
        disp = datetime.fromisoformat(fired_at_iso).astimezone().strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        disp = fired_at_iso
    return f"{title} · {disp}"


def _matched_rule(trig: EmailFilterTrigger) -> Optional[dict[str, Any]]:
    """email_filter 命中规则的可追溯描述子（trigger.matchedRule，可选）。"""
    rule: dict[str, Any] = {}
    if trig.subject_pattern:
        rule["subjectPattern"] = trig.subject_pattern
    if trig.sender_pattern:
        rule["senderPattern"] = trig.sender_pattern
    if trig.folders:
        rule["folders"] = list(trig.folders)
    return rule or None


def _build_envelope(internal_id: int) -> Optional[str]:
    """从 v4 ``EmailRepository`` 读该邮件 → ``UNTRUSTED_EMAIL_BODY`` 围栏块（服务端 fence，红线④）。

    只经 repository 读（metadata + body_markdown），不绕过直读表。读不到 / 异常 → None（省略
    envelope，run 仍继续——正文全文本就让 agent 经带围栏 email_body 工具二次取）。
    """
    try:
        repo = get_repository()
        meta = repo.get_metadata(internal_id)
        if meta is None:
            return None
        sender = meta.sender or ""
        if meta.sender_name:
            sender = f"{meta.sender_name} <{meta.sender}>" if meta.sender else meta.sender_name
        return fence_email_envelope(
            internal_id=internal_id,
            subject=meta.subject,
            sender=sender,
            date=meta.date_received,
            body_markdown=repo.get_body_markdown(internal_id),
        )
    except Exception as exc:  # noqa: BLE001 — envelope 是增强, 失败不阻断 run
        logger.warning(f"[agent-run-spec] envelope build failed internal_id={internal_id}: {exc}")
        return None


def _assemble_spec(job: AsyncJob) -> dict[str, Any]:
    """job 行 + report_agent 行 → gateway 消费的权威 spec（ADR D2 形状）。

    坏配置 fail-closed：agent 不存在 / 非 custom / disabled / 坏 trigger_json → 409
    E_SPEC_AGENT_INVALID（gateway 收到即放弃该 run，worker 标 failed）。
    """
    params = job.params or {}
    agent_id = params.get("agent_id")
    trigger_kind = params.get("trigger_kind")
    fire_key = params.get("fire_key")
    email_internal_id = params.get("email_internal_id")
    if not agent_id:
        raise APIError(
            "E_SPEC_AGENT_INVALID", "job params missing agent_id",
            http_status=409, source="agent-runs",
        )
    agent = get_report_store().get_agent(agent_id)
    if agent is None or (agent.get("type") or "") != "custom" or not agent.get("enabled"):
        raise APIError(
            "E_SPEC_AGENT_INVALID",
            f"agent {agent_id!r} missing / non-custom / disabled",
            http_status=409, source="agent-runs",
        )
    try:
        trig = parse_trigger(agent.get("trigger_json"))
    except TriggerValidationError as exc:
        raise APIError(
            "E_SPEC_AGENT_INVALID", f"bad trigger_json: {exc}",
            http_status=409, source="agent-runs",
        )
    budget = parse_budget(agent.get("budget_json"))
    tool_policy = _tool_policy_lenient(agent.get("tool_policy_json"))
    # S5 ADR-004 §5.1（显式修订 ADR-003 D6）：allowed_tools 未配置（NULL/缺 key）→ 投影
    # **默认安全集**（非「不收窄」）；owner 显式列表 → verbatim（仍 ∩ gateway 矩阵地板）；
    # 显式 [] → 空集。投影后 allowedTools 恒为非空字段 —— gateway 侧对缺失 spec 按空集
    # fail-closed（W4b）。
    allowed_tools = (
        list(tool_policy.allowed_tools)
        if tool_policy.allowed_tools is not None
        else list(DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS)
    )
    fired_at = _fired_at_iso(trigger_kind, fire_key, job.created_at)

    prompt: dict[str, Any] = {"taskPrompt": (agent.get("prompt") or "")}
    trigger_out: dict[str, Any] = {"kind": trigger_kind or trig.kind, "firedAt": fired_at}
    if isinstance(trig, EmailFilterTrigger) and email_internal_id is not None:
        trigger_out["emailInternalId"] = email_internal_id
        matched = _matched_rule(trig)
        if matched:
            trigger_out["matchedRule"] = matched
        envelope = _build_envelope(int(email_internal_id))
        if envelope:
            prompt["emailEnvelope"] = envelope

    tool_policy_out: dict[str, Any] = {"allowedTools": allowed_tools}
    if tool_policy.grant_exec is True:
        # 仅 parse 后字面 True 才投影（ADR-004 P1-4 —— gateway 从判别布尔**构造** grants，
        # 永不透传 raw object）。
        tool_policy_out["grantExec"] = True
    spec: dict[str, Any] = {
        "jobId": job.job_id,
        "agentId": agent_id,
        "trigger": trigger_out,
        "prompt": prompt,
        "model": (agent.get("model") or "").strip() or None,
        "toolPolicy": tool_policy_out,
        "budget": {"maxSteps": budget.max_steps, "maxRunSeconds": budget.max_run_seconds},
        "sessionTitle": _session_title(agent, agent_id, fired_at),
    }
    fallback = _parse_fallback_models(agent.get("fallback_models_json"))
    if fallback is not None:
        spec["fallbackModels"] = fallback
    return spec


# ── 端点 ─────────────────────────────────────────────────────────────────────────


@router.get("/{job_id:int}/spec", dependencies=[Depends(verify_local_token)])
async def get_run_spec(request: Request, job_id: int):
    """gateway 回拉 agent_run 权威 spec（原子 CAS one-shot，凭 X-Claim-Token）。

    结构化错误：403 E_SPEC_FORBIDDEN（缺/错 claimToken，不消费 CAS）· 404 E_SPEC_NOT_FOUND
    （job 不存在或非 agent_run）· 409 E_SPEC_ALREADY_CLAIMED（重复 pull / 非 running）·
    409 E_SPEC_AGENT_INVALID（agent 坏配置）。双 pull 结构性只有一个 200。
    """
    _require_flag()
    claim_token = request.headers.get("X-Claim-Token") or ""
    if not claim_token:
        raise APIError(
            "E_SPEC_FORBIDDEN", "missing X-Claim-Token header",
            http_status=403, source="agent-runs",
        )
    code, job = get_job_repo().claim_spec_cas(job_id, claim_token)
    if code == "not_found":
        raise APIError(
            "E_SPEC_NOT_FOUND", f"agent_run job {job_id} not found",
            http_status=404, source="agent-runs",
        )
    if code == "forbidden":
        raise APIError(
            "E_SPEC_FORBIDDEN", "claim token mismatch",
            http_status=403, source="agent-runs",
        )
    if code == "already_claimed":
        raise APIError(
            "E_SPEC_ALREADY_CLAIMED", f"spec for job {job_id} already claimed",
            http_status=409, source="agent-runs",
        )
    assert job is not None  # code=='ok' ⇒ job 非空（CAS 契约）
    spec = _assemble_spec(job)
    return success_envelope(spec, request=request, source="agent-runs")


class _ApprovalStateBody(BaseModel):
    state: Literal["approved", "rejected"]


@router.post("/{job_id:int}/approval-state", dependencies=[Depends(verify_local_token)])
async def set_approval_state(request: Request, job_id: int, body: _ApprovalStateBody):
    """岛 resume 终局后回写 agent_run 的 ``result_json.approval_state``（ADR D4, P1-4）。

    W3 lifecycle 从 chat_db 解出 job_id 调本端点（by-job-id 寻址，rev1.1）。只允许从 pending
    迁移；重复同值幂等 200；job 非 agent_run → 404；无 pending 可结算 → 409。
    """
    _require_flag()
    code = get_job_repo().settle_agent_run_approval(job_id, body.state)
    if code == "not_found":
        raise APIError(
            "E_SPEC_NOT_FOUND", f"agent_run job {job_id} not found",
            http_status=404, source="agent-runs",
        )
    if code == "not_pending":
        raise APIError(
            "E_APPROVAL_NOT_PENDING",
            f"job {job_id} has no pending approval to settle",
            http_status=409, source="agent-runs",
        )
    return success_envelope(
        {"jobId": job_id, "approvalState": body.state, "idempotent": code == "idempotent"},
        request=request, source="agent-runs",
    )


# ── run 历史列表（S5 W1）─────────────────────────────────────────────────────────


def _run_history_item(job: AsyncJob) -> dict[str, Any]:
    """``AsyncJob`` → run 历史行投影（S5 W1，ADR D4/P6）。

    🔴 ``state`` 唯一经 ``derive_agent_run_state`` 派生（8 值域单源）——TS 侧**永不**自行从
    outcome/approval_state 推导状态（投影即契约），防 ``paused_handoff`` 渲染成「成功完成」的
    第二处解读漂移。``outcome``/``approvalState``/``sessionId``/``tokens`` 从 result_json 透传
    供展示（非状态判定输入）。
    """
    result = job.result if isinstance(job.result, dict) else {}
    state = derive_agent_run_state(
        {
            "status": job.status,
            "result": result,
            "finished_at": job.finished_at,
            "updated_at": job.updated_at,
        }
    )
    return {
        "jobId": job.job_id,
        "agentId": job.target_key,
        "state": state,
        "outcome": result.get("outcome"),
        "approvalState": result.get("approval_state"),
        "sessionId": result.get("sessionId"),
        "createdAt": job.created_at,
        "finishedAt": job.finished_at,
        "error": job.last_error,
        "tokens": result.get("usage"),
    }


def _annotate_auto_whitelist(items: list[dict[str, Any]]) -> None:
    """run 历史行补 ``autoWhitelistedWrites``（S5 W5b，ADR-004 D6 —— 免卡写计数 badge）。

    经 ``result_json.sessionId`` join ai_chat.db ``chat_tool_call``（``approval_status=
    'auto_whitelist'`` + ``whitelist_rule_id``，CHAT_DB v18 列，gateway 直写）。语义三态：
    行无 sessionId / chat db 不可达 → **null**（badge 不渲染 —— 账本读不到时渲染 0 就是谎报
    「无免卡写」）；可达且有会话 → 计数（0 = 显式无免卡写）。审计计数是展示增强，任何异常
    不阻断 run 历史本体。
    """
    ids = [it["sessionId"] for it in items if isinstance(it.get("sessionId"), int)]
    counts: Optional[dict[int, int]] = None
    if ids:
        try:
            from src.chat.db import ChatDb

            counts = ChatDb().count_auto_whitelist_writes(ids)
        except Exception as exc:  # noqa: BLE001 — 增强字段，读账本失败只降级不阻断
            logger.warning(f"[agent-runs] auto_whitelist count unavailable: {exc}")
            counts = None
    for it in items:
        sid = it.get("sessionId")
        if counts is not None and isinstance(sid, int):
            it["autoWhitelistedWrites"] = counts.get(sid, 0)
        else:
            it["autoWhitelistedWrites"] = None


@router.get("/tool-options", dependencies=[Depends(verify_cf_access)])
async def get_tool_options(request: Request):
    """Settings per-agent 工具白名单编辑面的选项源（S5 W4a，ADR-004 §5.1）。

    🔴 响应契约（形状冻结，Settings wave 按此消费，不可改）：
    ``{"tools": [{"name": str, "class": "read"|"domain_write"}], "defaults": [str, ...]}``
    —— ``tools`` = headless 可用工具全集（矩阵地板内 read+domain_write），``defaults`` =
    ``DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS``。鉴权同 run 历史（``verify_cf_access``，renderer
    调用面）；flag off → 404（S4 纪律）。
    """
    _require_flag()
    return success_envelope(
        {
            "tools": [{"name": n, "class": c} for n, c in HEADLESS_TOOL_OPTIONS],
            "defaults": list(DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS),
        },
        request=request,
        source="agent-runs",
    )


@router.get("/pending-count", dependencies=[Depends(verify_cf_access)])
async def get_pending_count(request: Request):
    """全局 + per-agent 待审批（``paused_pending``）计数（S6 W1，P5 红点链轮询数据源）。

    🔴 只计 ``paused_pending``（live 可批的**唯一**状态）—— ``paused_expired`` 不可批（stash 已
    GC / gateway 已重启），绝不计入红点（否则红点长挂在已作废的审批上）。读态唯一经
    ``_run_history_item`` → ``derive_agent_run_state`` 派生（不在此重造第二套 status 映射）。

    实现：内存过滤最近 100 行（``paused_pending`` 恒 ≤ TTL=30min 龄 → 必落在 created_at desc
    头部窗口内，量小无需全表扫）。鉴权同 run 历史（``verify_cf_access``）；flag off → 404。

    响应契约：``{"total": int, "byAgent": {agentId: count}}``（byAgent 只含 count>0 的 agent）。
    """
    _require_flag()
    items = [_run_history_item(j) for j in get_job_repo().list_agent_runs(limit=100)]
    by_agent: dict[str, int] = {}
    for it in items:
        if it["state"] == "paused_pending":
            by_agent[it["agentId"]] = by_agent.get(it["agentId"], 0) + 1
    return success_envelope(
        {"total": sum(by_agent.values()), "byAgent": by_agent},
        request=request,
        source="agent-runs",
    )


@router.get("", dependencies=[Depends(verify_cf_access)])
async def list_agent_runs(
    request: Request,
    agent_id: Optional[str] = Query(None, alias="agentId"),
    limit: int = Query(20, ge=1, le=100),
    state: Optional[str] = Query(None),
):
    """agent_run 历史列表（Settings run 历史 UI 数据源，ADR D4/P6）。

    🔴 鉴权 = ``verify_cf_access``（远程 CF / 本地 token）——**对齐 report-agents 路由**，因调用方
    是 renderer 进程（非本机 gateway），**不用** ``verify_local_token``（那是 gateway 内部专用）。
    flag off → 404（S4 纪律，feature 不存在）。行读态经 ``derive_agent_run_state`` 单源投影。

    ``state`` 可选过滤（S6 W1）：值域 = ``AGENT_RUN_STATES``（8 值域），服务端按
    ``_run_history_item`` 派生后**内存过滤**（对拉取的 limit 窗口过滤，量小）；非法值 → 400
    E_INVALID_ARG（防静默 typo）。过滤在 ``_annotate_auto_whitelist`` 前，只标注过滤后集。
    """
    _require_flag()
    if state is not None and state not in AGENT_RUN_STATES:
        raise APIError(
            "E_INVALID_ARG",
            f"unknown state {state!r} (expected one of {sorted(AGENT_RUN_STATES)})",
            http_status=400,
            source="agent-runs",
        )
    jobs = get_job_repo().list_agent_runs(agent_id=agent_id, limit=limit)
    items = [_run_history_item(j) for j in jobs]
    if state is not None:
        items = [it for it in items if it["state"] == state]
    _annotate_auto_whitelist(items)
    return success_envelope(
        items, request=request, source="agent-runs", meta_extra={"count": len(items)}
    )
