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

from fastapi import APIRouter, Depends, Request
from loguru import logger
from pydantic import BaseModel

from src.agents.fence import fence_email_envelope
from src.agents.trigger import (
    EmailFilterTrigger,
    TriggerValidationError,
    parse_budget,
    parse_trigger,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_local_token
from src.api.deps import get_job_repo, get_report_store, get_repository
from src.sync.async_jobs import AsyncJob

router = APIRouter(prefix="/api/agent-runs", tags=["agent-runs"])


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


def _parse_allowed_tools(raw: Any) -> Optional[list[str]]:
    """tool_policy_json → ``allowed_tools`` list[str]（D6 工具收窄）。

    NULL/缺 key/非法 → None（不额外收窄）；显式 ``[]`` → 忠实透传（gateway 交集成空集 = owner
    显式选零工具）。深值域校验（工具名合法性 + 交集）在 gateway W3 施加，本层只做结构 parse。
    """
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("allowed_tools"), list):
        return None
    return [str(t) for t in data["allowed_tools"] if isinstance(t, str) and t]


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
    allowed_tools = _parse_allowed_tools(agent.get("tool_policy_json"))
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

    spec: dict[str, Any] = {
        "jobId": job.job_id,
        "agentId": agent_id,
        "trigger": trigger_out,
        "prompt": prompt,
        "model": (agent.get("model") or "").strip() or None,
        "toolPolicy": ({"allowedTools": allowed_tools} if allowed_tools is not None else {}),
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
