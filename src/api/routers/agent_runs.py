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

from src.agents.fence import fence_calendar_envelope, fence_email_envelope
from src.agents.run_log import (
    AGENT_RUN_LOG_STATUS_VALUES,
    AGENT_RUN_STEP_KINDS,
    count_run_logs,
    get_run_log,
    list_run_logs,
    list_run_steps,
    record_agent_run,
)
from src.agents.run_queue import enqueue_agent_run
from src.agents.run_sources import RUN_SOURCE_RUN_LOG, resolve_run_source
from src.agents.run_state import AGENT_RUN_STATES, derive_agent_run_state
from src.agents.trigger import (
    CalendarBeforeStartTrigger,
    CalendarEventChangeTrigger,
    EmailFilterTrigger,
    ToolPolicy,
    Trigger,
    TriggerValidationError,
    parse_budget,
    parse_tool_policy,
    parse_trigger,
    parse_trigger_set,
    trigger_v2_enabled,
)
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_job_repo, get_report_store, get_repository
from src.notify.center import NotifyCenter
from src.project_progress.agent_config import PROJECT_PROGRESS_AGENT_ID
from src.sync.async_jobs import AsyncJob
from src.chat.db import ChatDb

router = APIRouter(prefix="/api/agent-runs", tags=["agent-runs"])

FINAL_ANSWER_MAX_CHARS = 10_000


class AgentCallEnqueueBody(BaseModel):
    agent_id: str
    fire_key: str
    session_id: int
    invocation: dict[str, Any]


# ── per-agent 工具面常量（S5 ADR-004 §5.1 / D3，单源 —— spec 投影与 Settings tool-options
# 端点同源，前端不手抄第二份）──────────────────────────────────────────────────────────

# 🔴 默认安全集：type='custom' 且 tool_policy_json 为 NULL / 缺 allowed_tools 时投影此集 ——
# 语义从「NULL=不收窄」改为「NULL=默认安全集」（对 ADR-003 D6 的**显式修订**，codex P1-1：
# 「Settings 模板不勾 kos_query」挡不住 API 直建/空策略行，收窄必须是投影层结构性保证）。
# 排除在默认集外（owner 显式勾选才有）：kos_*（trusted-sink 残余面 —— issue #57 起是 6 个只读
# 工具 kos_query/search/get_page/find_experts/list_pages/get_backlinks，整族同待遇：headless run
# 的输入本就是 untrusted 邮件，KOS 返回的是他人可写的知识库全文且现状不套 UNTRUSTED 围栏）、chat_session_*
# （历史会话=二阶注入面）、agent_profile_read/history（身份文档不进 untrusted 上下文）、
# discover_skills / skill_read / report 读取（headless 默认无需求）、calendar 三写
# （calendar_event_reschedule/rsvp/delete —— 恒卡不免审，但删除不可恢复 / rsvp 真发不可撤回
# 的回执信，默认工具面不该自带不可逆提案权，读可默认写不默认）。
DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS: tuple[str, ...] = (
    # email 读族（headless agent 的最小工作集）
    "email_list_filter", "email_search_fulltext", "email_get", "email_body",
    "email_list_thread", "email_search_attachments",
    # calendar 读族（日历 epic 4.1：silent 读 + CALENDAR_EVENT 围栏，日报/简报类 agent 直接可用）
    "calendar_events_list", "calendar_event_get",
    # domain_write 族（注册 ≠ 免卡：无 D1 规则时仍恒岛卡）
    "email_flag", "email_archive", "email_pin", "email_resync", "email_draft_reply",
    # local artifact（silent + 可删/可覆盖）
    "report_write",
)

# 🔴 默认挂载集（S6 W3, ADR-004 rev3.1 §5.1/D3）：tool_policy_json 缺 skills（NULL）时投影此集
# —— 覆盖默认安全集的 email/search 两族，并预挂 report，使 W5 的报告 read/produce 能力卡
# 在 owner 选择 report_get/report_list 后真实生效。report 挂载本身不扩大工具面：最终仍与
# allowed_tools 相交；默认安全集只有 CORE_UNGATED 的 report_write，故现有默认行为不变。
# 显式 [] = 零挂载（门控工具全缺席，含 email_list_filter —— PR-D 起归 email skill；CORE_UNGATED 仍在）。
# 单源：spec 投影恒输出解析完的 skills 数组（默认已代入），gateway 不手抄第二份常量。
DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS: tuple[str, ...] = ("email", "search", "report")


def resolve_mounted_skills(agent: Optional[dict[str, Any]]) -> frozenset[str]:
    """agent 行 → 挂载集（ADR-004 rev3.1 §5.1/§5.2 的唯一解析口，建规闸 / evaluate 传递共用）。

    ``skills`` 未配置（NULL/缺 key/坏形状经 lenient 落 None）→ 默认挂载集；显式列表 → verbatim；
    agent 缺失 → 空集（fail-closed —— 无可归属，exec 规则全 dormant）。
    """
    if agent is None:
        return frozenset()
    tp = _tool_policy_lenient(agent.get("tool_policy_json"))
    if tp.skills is None:
        return frozenset(DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS)
    return frozenset(tp.skills)

# headless 可用工具全集 = 矩阵地板内 read + domain_write（与 gateway policy.ts
# GATEWAY_TOOL_CLASSES / tests/agent_eval/tool_catalog.json 的 tool_class 轴同源；
# tests/api 有 catalog 一致性闸，新读/写工具漏此表必红）。exec / outbound /
# capability_change 结构性缺席（ADR-004 D2/D3：exec 走 grant_exec 矩阵例外，非此列表）；
# web（web_fetch/web_search，S6 起 class=web）同样结构性缺席 —— 走 grant_web 三档授权。
HEADLESS_TOOL_OPTIONS: tuple[tuple[str, str], ...] = (
    ("agent_catalog_get", "read"),
    ("agent_catalog_list", "read"),
    ("agent_profile_history", "read"),
    ("agent_profile_read", "read"),
    ("calendar_event_get", "read"),
    ("calendar_events_list", "read"),
    ("chat_session_get", "read"),
    ("chat_session_list", "read"),
    ("chat_session_search", "read"),
    ("discover_skills", "read"),
    ("email_attachment_text", "read"),
    ("email_body", "read"),
    ("email_get", "read"),
    ("email_list_filter", "read"),
    ("email_list_thread", "read"),
    ("email_search_attachments", "read"),
    ("email_search_fulltext", "read"),
    ("email_thread_attachments", "read"),
    # KOS 只读族（issue #57：kos_query 之外新增 5 个只读工具，class 与 kos_query 同为 read；
    # 注册进 headless 地板 ≠ 默认可用 —— 与 kos_query 一样不在 DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS，
    # owner 显式勾选才进某个 agent 的工具面）。
    ("kos_find_experts", "read"),
    ("kos_get_backlinks", "read"),
    ("kos_get_page", "read"),
    ("kos_list_pages", "read"),
    ("kos_query", "read"),
    ("kos_search", "read"),
    ("report_get", "read"),
    ("report_list", "read"),
    ("report_write", "artifact"),
    ("skill_read", "read"),
    # calendar 三写（日历 epic 4.2）：class=domain_write —— headless 保注册、edit-tier 恒卡
    # （工厂无 policyEvaluate ⇒ 连 D1 规则免卡通道都不存在，批准前只会 paused_handoff）。
    ("calendar_event_delete", "domain_write"),
    ("calendar_event_reschedule", "domain_write"),
    ("calendar_event_rsvp", "domain_write"),
    ("email_archive", "domain_write"),
    # 草稿写族（prd 07-27 包 1+2）：compose = 新建/转发草稿，update = 改已有草稿
    # （另存 + 删旧）。与 email_draft_reply 同风险面（只写草稿箱、不出站），故同为
    # domain_write；同样**不进** DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS（owner 勾选才有）。
    ("email_draft_compose", "domain_write"),
    ("email_draft_reply", "domain_write"),
    ("email_draft_update", "domain_write"),
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
    E_SPEC_AGENT_INVALID（gateway 收到即放弃该 run，worker 标 failed）。**例外**：
    trigger_json 为空（未配置触发条件）且本 job 是 manual 触发 → 放行（见下方注释）。

    Matters P4：``matter_followup`` job 顶部分派到 ``src.matters.run_spec``（薄转发，
    report/custom-agent 路径一字不动）；flag off / 坏语境 → 同码 409。
    """
    if job.job_type == "matter_followup":
        from src.matters.run_spec import assemble_matter_spec
        from src.matters.service import MatterError

        try:
            return assemble_matter_spec(job)
        except MatterError as exc:
            raise APIError(
                "E_SPEC_AGENT_INVALID", exc.message,
                http_status=409, source="agent-runs",
            ) from exc
    if job.job_type == "matter_item_run":
        # task 08-25 批次 3：一条**行动项**的派发 run。与 matter_followup 同一薄转发形状
        # （spec 组装的权威在 src/matters/run_spec.py，坏语境同码 409）。
        from src.matters.run_spec import assemble_item_spec
        from src.matters.service import MatterError

        try:
            return assemble_item_spec(job)
        except MatterError as exc:
            raise APIError(
                "E_SPEC_AGENT_INVALID", exc.message,
                http_status=409, source="agent-runs",
            ) from exc
    if job.job_type == "contact_governance":
        from src.contacts.governance import assemble_contact_governance_spec
        from src.contacts.service import ContactError

        try:
            return assemble_contact_governance_spec(job)
        except ContactError as exc:
            raise APIError(
                "E_SPEC_AGENT_INVALID", exc.message,
                http_status=409, source="agent-runs",
            ) from exc
    params = job.params or {}
    agent_id = params.get("agent_id")
    trigger_kind = params.get("trigger_kind")
    trigger_id = params.get("trigger_id") if isinstance(params.get("trigger_id"), str) else None
    fire_key = params.get("fire_key")
    email_internal_id = params.get("email_internal_id")
    calendar_event_uid = params.get("calendar_event_uid")
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
    # 🔴 trigger 校验**按需**（08-06 修）：「未配置触发条件」是明确的产品状态 —— 抽屉默认
    # triggerKind='none' 存 trigger_json=NULL，中文提示逐字承诺「保存为草稿、不会自动运行
    # （仍可在下方手动运行一次）」。此前这里无条件 parse_trigger(NULL) → TriggerValidationError
    # → 409 E_SPEC_AGENT_INVALID → gateway 弃 run → **任何未配触发条件的 agent 手动运行必失败**
    # （活库实证：两次 manual job 全 failed）。
    # 放宽面**只有「空」**（NULL / 空串 / 纯空白）**且**本 job 是 manual 触发；「非空但坏」的
    # trigger_json 以及一切非 manual 的 run 维持今天的 fail-closed 硬拒（故意不靠捕获
    # TriggerValidationError 判空 —— 那会把坏 JSON/非 object 一并放行）。
    # 安全性：manual 路径上 trig 本就用不到（trigger_out 的 kind 取 trigger_kind；matchedRule /
    # emailEnvelope 只在 EmailFilterTrigger 分支），且 gateway deriveContextMode 对 'manual'
    # fail-close 到最严的 untrusted_trigger；cron/schedule/email_filter 的 run 在入队前已由
    # trigger_worker / email_dispatch parse 过一遍，行为字节级不变。
    raw_trigger = agent.get("trigger_json")
    trigger_unconfigured = raw_trigger is None or (
        isinstance(raw_trigger, str) and not raw_trigger.strip()
    )
    trig: Optional[Trigger] = None
    if trigger_v2_enabled() and not trigger_unconfigured:
        try:
            trigger_entries = parse_trigger_set(raw_trigger)
        except TriggerValidationError as exc:
            raise APIError(
                "E_SPEC_AGENT_INVALID", f"bad trigger_json: {exc}",
                http_status=409, source="agent-runs",
            )
        if not trigger_entries:
            trigger_unconfigured = True
        else:
            selected = next((entry for entry in trigger_entries if entry.id == trigger_id), None)
            trig = (selected or trigger_entries[0]).trigger
    if not (trigger_unconfigured and trigger_kind == "manual"):
        if trig is None:
            try:
                trig = parse_trigger(raw_trigger)
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
    trigger_out: dict[str, Any] = {
        "id": trigger_id,
        "kind": trigger_kind or (trig.kind if trig is not None else "manual"),
        "firedAt": fired_at,
    }
    if isinstance(trig, EmailFilterTrigger) and email_internal_id is not None:
        trigger_out["emailInternalId"] = email_internal_id
        matched = _matched_rule(trig)
        if matched:
            trigger_out["matchedRule"] = matched
        envelope = _build_envelope(int(email_internal_id))
        if envelope:
            prompt["emailEnvelope"] = envelope
    if (
        isinstance(trig, (CalendarEventChangeTrigger, CalendarBeforeStartTrigger))
        and isinstance(calendar_event_uid, str)
    ):
        recurrence_id = params.get("recurrence_id")
        occurrence_start_iso = params.get("occurrence_start_iso")
        change_kind = params.get("change_kind")
        trigger_out["calendarEventUid"] = calendar_event_uid
        if recurrence_id is not None:
            trigger_out["recurrenceId"] = recurrence_id
        if occurrence_start_iso is not None:
            trigger_out["occurrenceStartIso"] = occurrence_start_iso
        if change_kind is not None:
            trigger_out["changeKind"] = change_kind
        try:
            from src.calendar_sync.repository import CalendarEventRepository
            from src.config import config

            row = CalendarEventRepository(config.sync_store_db_path).get_by_ical_uid(
                calendar_event_uid,
                source="caldav",
                recurrence_id=recurrence_id,
                include_deleted=True,
            )
            if row is not None:
                prompt["calendarEnvelope"] = fence_calendar_envelope(
                    ical_uid=row.ical_uid,
                    recurrence_id=row.recurrence_id,
                    calendar_name=row.calendar_name,
                    status=row.status,
                    dtstart_iso=row.dtstart_utc.isoformat(),
                    occurrence_start_iso=occurrence_start_iso,
                    change_kind=change_kind,
                    changed_fields=params.get("changed_fields"),
                    lead_seconds=params.get("lead_seconds"),
                    summary=row.summary,
                    location=row.location,
                    organizer=row.organizer,
                    attendees=row.attendees,
                    description=row.description,
                )
        except Exception as exc:  # noqa: BLE001 — payload enhancement, run still proceeds
            logger.warning(
                f"[agent-run-spec] calendar envelope build failed uid={calendar_event_uid}: {exc}"
            )

    tool_policy_out: dict[str, Any] = {"allowedTools": allowed_tools}
    if tool_policy.grant_exec is True:
        # 仅 parse 后字面 True 才投影（ADR-004 P1-4 —— gateway 从判别布尔**构造** grants，
        # 永不透传 raw object）。
        tool_policy_out["grantExec"] = True
    if tool_policy.grant_web in ("gated", "open"):
        # 镜像 grantExec：仅非默认值（off）才投影；gateway 侧 parseWebGrant 再判别一次，
        # 缺席/junk 恒塌 'off'（ADR-004 rev3.1 D1）。
        tool_policy_out["grantWeb"] = tool_policy.grant_web
    if tool_policy.grant_connectors:
        # MCP connector PR3：仅非空才投影（镜像 grantWeb 的「仅非默认值输出」）。值来自
        # parse_tool_policy 判别过的 (connector_id, 天花板) 对 —— 天花板恒 ∈ read|write|update
        # （delete 保存时即拒），gateway 从判别值**构造** grants，永不透传 raw object。
        # connector 工具不进 HEADLESS_TOOL_OPTIONS（镜像 exec/web 的结构性缺席）：授权走这把
        # per-connector 天花板，缺省 = 该 connector 整族不注册。
        tool_policy_out["grantConnectors"] = dict(tool_policy.grant_connectors)
    # S6 W3（rev3.1 §5.1）：skills **恒输出**解析完的数组（NULL → 默认挂载集已代入；显式 []
    # → []）—— gateway 不手抄默认集第二份；gateway 侧对缺 skills 的 spec 按 [] fail-closed。
    tool_policy_out["skills"] = (
        list(tool_policy.skills)
        if tool_policy.skills is not None
        else list(DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS)
    )
    spec: dict[str, Any] = {
        "jobId": job.job_id,
        "agentId": agent_id,
        "agentTitle": (agent.get("title") or "").strip() or agent_id,
        "trigger": trigger_out,
        "prompt": prompt,
        "model": (agent.get("model") or "").strip() or None,
        "toolPolicy": tool_policy_out,
        "budget": {"maxRunSeconds": budget.max_run_seconds},
        "sessionTitle": _session_title(agent, agent_id, fired_at),
    }
    invocation = params.get("invocation")
    session_id = params.get("session_id")
    if isinstance(session_id, int) and session_id > 0:
        spec["sessionId"] = session_id
    if isinstance(invocation, dict):
        spec["invocation"] = invocation
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
    if code != "idempotent":
        # perf-sse-realtime R1-5: 审批结算即广播 (待审批计数/红点即时归零)。吞错。
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "agent.run.changed",
                data={"job_id": job_id, "status": f"approval_{body.state}"},
                source="agent-runs-api",
            )
        except Exception:
            pass
    # 通知中心归档 (task 08-20-notification-center M2 B6): code 到这一步只剩 'ok'/'idempotent'，
    # 两者都代表 approval_state 已落到终态 —— 归档 run_worker 在 paused_pending 时开的
    # action_required 待办 (dedupe_key=f"agent_run_paused:{job_id}")。复用 job_repo 的 db_path
    # (与 async_jobs 同库，无需引入 settings 依赖)。无活跃行 (已归档过 / 从未开过) 返 0 不抛；
    # 吞异常 —— 通知失败不影响审批结算本身的响应。
    try:
        NotifyCenter(get_job_repo().db_path).resolve_by_dedupe(f"agent_run_paused:{job_id}")
    except Exception:
        logger.warning(f"approval-state settle: resolve_by_dedupe failed for job {job_id}")
    return success_envelope(
        {"jobId": job_id, "approvalState": body.state, "idempotent": code == "idempotent"},
        request=request, source="agent-runs",
    )


# ── run 历史列表（S5 W1）─────────────────────────────────────────────────────────


def _run_history_item(
    job: AsyncJob, *, agent_id_override: Optional[str] = None
) -> dict[str, Any]:
    """``AsyncJob`` → run 历史行投影（S5 W1，ADR D4/P6）。

    🔴 ``state`` 唯一经 ``derive_agent_run_state`` 派生（9 值域单源）——TS 侧**永不**自行从
    outcome/approval_state 推导状态（投影即契约），防 ``paused_handoff`` 渲染成「成功完成」的
    第二处解读漂移。``outcome``/``approvalState``/``sessionId``/``steps``/``tokens`` 从
    result_json 透传；duration 由账本时间戳投影（均非状态判定输入）。

    ``triggerKind``/``triggerFiredAtIso``（L4 批次2 §2.1）：从 ``job.params``（非 result）
    投影，纯展示增强，非状态判定输入——不影响上面那条红线。``params.trigger_kind`` 缺失
    （老行 / 非常规入队路径）→ 两字段恒 None；有值则复用 ``_fired_at_iso`` 同一份 cron
    occurrence 解析，与 ``_assemble_spec`` 的 firedAt 同源不重造第二套解法。

    ``agent_id_override``（L4 P4a）：非 ``agent_run`` 族的 job 的 ``target_key`` **不是成员
    id**（``contact_governance`` 的是 ``'global'``），投影时回填成团队页认识的成员 id。
    形状本身一字不变 —— 前端 ``AgentRunHistoryItem`` 已按这个形状消费。
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
    params = job.params if isinstance(job.params, dict) else {}
    raw_trigger_kind = params.get("trigger_kind")
    trigger_kind = raw_trigger_kind if isinstance(raw_trigger_kind, str) and raw_trigger_kind else None
    trigger_fired_at_iso = (
        _fired_at_iso(trigger_kind, params.get("fire_key"), job.created_at)
        if trigger_kind is not None else None
    )
    return {
        "jobId": job.job_id,
        "agentId": agent_id_override or job.target_key,
        "state": state,
        "outcome": result.get("outcome"),
        "summary": result.get("summary"),
        "approvalState": result.get("approval_state"),
        "sessionId": result.get("sessionId"),
        "createdAt": job.created_at,
        "finishedAt": job.finished_at,
        "error": job.last_error,
        "steps": result.get("steps"),
        "tokens": result.get("usage"),
        "durationSeconds": (
            max(0.0, job.finished_at - (job.started_at or job.created_at))
            if job.finished_at is not None else None
        ),
        "triggerKind": trigger_kind,
        "triggerFiredAtIso": trigger_fired_at_iso,
    }


def _ms_iso(ms: Any) -> Optional[str]:
    """epoch 毫秒 → UTC ISO 字符串（run_log item 时间字段的边界换算，仅此一处）。"""
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(float(ms) / 1000.0, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _run_log_item(row: dict[str, Any]) -> dict[str, Any]:
    """``agent_run_log`` 行 → run 历史行投影（L4 P4a run transcript 批）。

    🔴 **接缝契约**（与前端并行 agent 约定，字段名不许改）：形状对齐
    ``_run_history_item``，另带 ``kind: 'run_log'`` 与 ``runLogId``；时间字段是
    **ISO 字符串**（台账存毫秒 epoch，换算只在 ``_ms_iso`` 这一处做）。步骤明细走
    ``GET /api/agent-runs/run-log/{id}/steps``，这里的 ``steps`` 只是计数。

    ``state`` 直接就是台账的 ``status`` —— 建表时 CHECK 钉死为
    ``run_state.AGENT_RUN_STATES`` 9 值域的子集，前端 RunStateBadge 零映射直接吃；
    读到白名单外的值仍 fail-closed 落 'failed'（防手工改库的行显示成「成功完成」）。

    ``sessionId``/``approvalState`` 恒空是契约不是没写完：run_log 的三位写入方
    （报告 / 画像 / 项目周报）不开会话、不走审批。
    """
    status = str(row["status"])
    started_ms = float(row["started_at"])
    completed_ms = row["completed_at"]
    tokens = None
    if row.get("input_tokens") is not None or row.get("output_tokens") is not None:
        tokens = {
            "inputTokens": row.get("input_tokens") or 0,
            "outputTokens": row.get("output_tokens") or 0,
        }
    trigger_kind = row.get("trigger_kind") or None
    return {
        "jobId": int(row["id"]),
        "agentId": row["agent_id"],
        "state": status if status in AGENT_RUN_STATES else "failed",
        "outcome": status,
        "summary": row.get("summary"),
        "approvalState": None,
        "sessionId": None,
        "createdAt": _ms_iso(started_ms),
        "finishedAt": _ms_iso(completed_ms),
        "error": row.get("error"),
        "steps": row.get("step_count"),
        "tokens": tokens,
        "durationSeconds": (
            max(0.0, (float(completed_ms) - started_ms) / 1000.0)
            if completed_ms is not None else None
        ),
        "triggerKind": trigger_kind,
        "triggerFiredAtIso": _ms_iso(started_ms) if trigger_kind is not None else None,
        "triggerDetail": row.get("trigger_detail"),
        "model": row.get("model"),
        "kind": RUN_SOURCE_RUN_LOG,
        "runLogId": int(row["id"]),
        # 报告类 run 的产物引用 (out 步骤 payload 的 report_id, list_run_logs SQL 抽出)。
        # 前端记录列靠它把「产物行 report:xxx」与「过程行 runlog:N」收敛成一条 ——
        # 真实引用而不是时间窗启发式。非报告类的 run 恒 null。
        "reportId": (
            str(row["report_id"]) if row.get("report_id") is not None else None
        ),
        # 项目周报 run 的触发邮件引用 (trig 步骤 payload 的 internal_id) —— 与
        # reportId 同模式: 记录列靠它把 project_progress_sync 台账行与 runlog 行
        # 收敛成一条。语义门在这里: 只对该成员投影, 别的 agent 哪怕 trig 里带了
        # internal_id 也不冒充周报引用。runner 从 v73 首版起就写结构化 internal_id,
        # 但坏 payload / 未来写入方缺失时为 null —— 消费侧按可缺省处理。
        "progressEmailId": (
            int(row["trig_internal_id"])
            if (
                row["agent_id"] == PROJECT_PROGRESS_AGENT_ID
                and row.get("trig_internal_id") is not None
            )
            else None
        ),
    }


class _RunLogStepBody(BaseModel):
    kind: str
    name: Optional[str] = None
    detail: Optional[str] = None
    payload: Optional[dict[str, Any]] = None
    ok: Optional[bool] = None
    ms: Optional[int] = None


class _RunLogBody(BaseModel):
    agentId: str
    startedAtMs: int
    status: str
    completedAtMs: Optional[int] = None
    triggerKind: Optional[str] = None
    triggerDetail: Optional[str] = None
    summary: Optional[str] = None
    model: Optional[str] = None
    inputTokens: Optional[int] = None
    outputTokens: Optional[int] = None
    error: Optional[str] = None
    steps: list[_RunLogStepBody] = []


@router.post("/run-log", dependencies=[Depends(verify_local_token)])
async def post_run_log(request: Request, body: _RunLogBody):
    """gateway → 一行 ``agent_run_log``（g1 群聊：群成员的 spoke turn 镜像进团队页执行记录）。

    🔴 鉴权 = ``verify_local_token``（本机 gateway loopback 专用腿，不接受 CF JWT）——与
    ``/{job_id}/approval-state`` 同款纪律：这是 gateway 内部回写面，不是 renderer 调用面。

    🔴 值域**不发明词表**：``status`` ∈ ``run_log.AGENT_RUN_LOG_STATUS_VALUES``
    （running / completed / failed / skipped，**没有 'stopped'** —— 表 CHECK 会拒），
    ``steps[].kind`` ∈ ``AGENT_RUN_STEP_KINDS``。越域 400，绝不静默改写：静默改写会让台账
    里的状态与真实发生的事劈叉，而这张表正是「执行历史」的唯一可见来源。

    ``record_agent_run`` 自身写失败只 warning 返 None（活儿已经干完，台账写不进去不该反过来
    炸调用方）；本端点如实回 ``{"runLogId": null}``，调用方（best-effort 镜像）据此只 warn。
    """
    _require_flag()
    if body.status not in AGENT_RUN_LOG_STATUS_VALUES:
        raise APIError(
            "E_INVALID_ARG",
            f"status must be one of {AGENT_RUN_LOG_STATUS_VALUES}",
            http_status=400, source="agent-runs",
        )
    for step in body.steps:
        if step.kind not in AGENT_RUN_STEP_KINDS:
            raise APIError(
                "E_INVALID_ARG",
                f"step kind must be one of {AGENT_RUN_STEP_KINDS}",
                http_status=400, source="agent-runs",
            )
    run_log_id = record_agent_run(
        str(get_job_repo().db_path),
        agent_id=body.agentId,
        started_at_ms=body.startedAtMs,
        status=body.status,
        completed_at_ms=body.completedAtMs,
        trigger_kind=body.triggerKind,
        trigger_detail=body.triggerDetail,
        summary=body.summary,
        model=body.model,
        input_tokens=body.inputTokens,
        output_tokens=body.outputTokens,
        error=body.error,
        steps=[step.model_dump(exclude_none=False) for step in body.steps],
    )
    return success_envelope({"runLogId": run_log_id}, request=request, source="agent-runs")


@router.get("/run-log/{run_log_id:int}/steps", dependencies=[Depends(verify_cf_access)])
async def get_run_log_steps(request: Request, run_log_id: int):
    """一次 run_log 执行的步骤明细（团队页把它合成 transcript 形态渲染）。

    🔴 **接缝契约**（与前端并行 agent 约定，字段名不许改）：
    ``{"steps": [{seq, kind, name, detail, payload, ok, ms}]}`` —— ``payload`` 是
    解析后的对象或 null（坏 JSON 落 null 不 500）；``ok`` 是 bool 或 null
    （false → 前端标 ✗ + fail 色）；``kind`` ∈ trig|think|tool|out（库 CHECK 钉死）。

    鉴权同 run 历史列表（``verify_cf_access``，renderer 调用面）；flag off → 404；
    未知 run_log id → 404 E_NOT_FOUND（区别于「有这次执行但零步骤」的 steps=[]）。
    """
    _require_flag()
    db_path = str(get_job_repo().db_path)
    if get_run_log(db_path, run_log_id) is None:
        raise APIError(
            "E_NOT_FOUND", f"run log {run_log_id} not found",
            http_status=404, source="agent-runs",
        )
    return success_envelope(
        {"steps": list_run_steps(db_path, run_log_id)},
        request=request,
        source="agent-runs",
    )


@router.post("/call", dependencies=[Depends(verify_cf_access)])
async def enqueue_agent_call(request: Request, body: AgentCallEnqueueBody):
    _require_flag()
    if not body.fire_key.startswith("agent-call:"):
        raise APIError(
            "E_INVALID_ARG",
            "fire_key must start with 'agent-call:'",
            http_status=400,
            source="agent-runs",
        )
    agent = get_report_store().get_agent(body.agent_id)
    if agent is None or agent.get("type") != "custom" or not agent.get("enabled"):
        raise APIError(
            "E_NOT_FOUND", f"custom agent {body.agent_id!r} not found or disabled",
            http_status=404, source="agent-runs",
        )
    budget = parse_budget(agent.get("budget_json"))
    job_id, was_created = enqueue_agent_run(
        get_job_repo(),
        agent_id=body.agent_id,
        trigger_kind="manual",
        fire_key=body.fire_key,
        budget=budget,
        params={"session_id": body.session_id, "invocation": body.invocation},
    )
    job = get_job_repo().get(job_id)
    params = job.params if job and isinstance(job.params, dict) else {}
    return success_envelope(
        {
            "jobId": job_id,
            "wasCreated": was_created,
            "sessionId": params.get("session_id") or body.session_id,
        },
        request=request,
        source="agent-runs",
    )


@router.get("/{job_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_agent_run(request: Request, job_id: int):
    _require_flag()
    job = get_job_repo().get(job_id)
    if job is None or job.job_type != "agent_run":
        raise APIError("E_NOT_FOUND", f"agent run {job_id} not found", http_status=404, source="agent-runs")
    item = _run_history_item(job)
    agent = get_report_store().get_agent(job.target_key)
    item["agentTitle"] = ((agent or {}).get("title") or job.target_key).strip()
    if item["state"] in {"completed", "paused_approved", "paused_rejected"}:
        answer = None
        session_id = item.get("sessionId")
        if isinstance(session_id, int):
            message = ChatDb().get_latest_assistant_message(session_id)
            if message:
                answer = message.get("content")
        result = job.result if isinstance(job.result, dict) else {}
        if not isinstance(answer, str) or not answer:
            summary = result.get("summary")
            answer = summary if isinstance(summary, str) else None
        if isinstance(answer, str):
            item["finalAnswerTruncated"] = len(answer) > FINAL_ANSWER_MAX_CHARS
            item["finalAnswer"] = answer[:FINAL_ANSWER_MAX_CHARS]
        else:
            item["finalAnswer"] = None
            item["finalAnswerTruncated"] = False
    return success_envelope(item, request=request, source="agent-runs")


@router.post("/{job_id:int}/cancel", dependencies=[Depends(verify_cf_access)])
async def cancel_agent_run(request: Request, job_id: int):
    _require_flag()
    repo = get_job_repo()
    job = repo.get(job_id)
    if job is None or job.job_type != "agent_run":
        raise APIError("E_NOT_FOUND", f"agent run {job_id} not found", http_status=404, source="agent-runs")
    cancelled = repo.mark_terminal(
        job_id,
        status="aborted",
        result={"outcome": "stopped", "reason": "user_cancelled"},
        expect_status="queued",
    )
    if cancelled:
        # perf-sse-realtime R1-5: 取消即广播 (worker 未 claim → 不会再有终态事件)。
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "agent.run.changed",
                data={"job_id": job_id, "status": "aborted"},
                source="agent-runs-api",
            )
        except Exception:
            pass
        return success_envelope({"cancelled": True}, request=request, source="agent-runs")
    current = repo.get(job_id)
    return success_envelope(
        {
            "cancelled": False,
            "state": _run_history_item(current)["state"] if current else "failed",
        },
        request=request,
        source="agent-runs",
    )


def _annotate_auto_whitelist(items: list[dict[str, Any]]) -> None:
    """run 历史行补 ``autoWhitelistedWrites`` + ``autoWhitelistedBreakdown``（S5 W5b badge；
    S6 W3-2 ADR-004 rev3.1 §4.4/F#3 分源）。

    经 ``result_json.sessionId`` join ai_chat.db ``chat_tool_call``（``approval_status=
    'auto_whitelist'`` + ``whitelist_rule_id``，CHAT_DB v18 列，gateway 直写）。breakdown 按
    rule-source（rule_id 非空 = 白名单规则命中）/ grant-source（rule_id=null = grant 级免卡，
    per-tool 细分）两桶投影——owner 误判授权范围的防线（免卡 badge 须能区分「域名规则」与
    「全开放联网 / 搜索授权」）。语义三态：行无 sessionId / chat db 不可达 → 两字段均 **null**
    （badge 不渲染 —— 账本读不到时渲染 0 就是谎报「无免卡写」）；可达且有会话 → 计数
    （0 / 空桶 = 显式无免卡写）。审计计数是展示增强，任何异常不阻断 run 历史本体。
    """
    ids = [it["sessionId"] for it in items if isinstance(it.get("sessionId"), int)]
    counts: Optional[dict[int, dict[str, Any]]] = None
    if ids:
        try:
            from src.chat.db import ChatDb

            counts = ChatDb().count_auto_whitelist_writes(ids)
        except Exception as exc:  # noqa: BLE001 — 增强字段，读账本失败只降级不阻断
            logger.warning(f"[agent-runs] auto_whitelist count unavailable: {exc}")
            counts = None
    for it in items:
        # run_log 行不盖这两个键: 台账的三位写入方不走 gateway, 没有 auto-whitelist
        # 概念 —— 恒 null 的字段不进契约 (与 kind/runLogId 的接缝契约保持最小面)。
        if it.get("kind") == "run_log":
            continue
        sid = it.get("sessionId")
        if counts is not None and isinstance(sid, int):
            bucket = counts.get(sid)
            it["autoWhitelistedWrites"] = int(bucket["total"]) if bucket else 0
            it["autoWhitelistedBreakdown"] = (
                {"rule": bucket["rule"], "grant": bucket["grant"]}
                if bucket
                else {"rule": 0, "grant": {}}
            )
        else:
            it["autoWhitelistedWrites"] = None
            it["autoWhitelistedBreakdown"] = None


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
    offset: int = Query(0, ge=0),
    state: Optional[str] = Query(None),
):
    """agent_run 历史列表（Settings run 历史 UI 数据源，ADR D4/P6）。

    🔴 鉴权 = ``verify_cf_access``（远程 CF / 本地 token）——**对齐 report-agents 路由**，因调用方
    是 renderer 进程（非本机 gateway），**不用** ``verify_local_token``（那是 gateway 内部专用）。
    flag off → 404（S4 纪律，feature 不存在）。行读态经 ``derive_agent_run_state`` 单源投影。

    ``state`` 可选过滤（S6 W1）：值域 = ``AGENT_RUN_STATES``（9 值域，含 ``skipped``），服务端按
    ``_run_history_item`` 派生后**内存过滤**（对拉取的 limit 窗口过滤，量小）；非法值 → 400
    E_INVALID_ARG（防静默 typo）。过滤在 ``_annotate_auto_whitelist`` 前，只标注过滤后集。

    task 07-21：``offset`` 补齐分页（透传给 ``list_agent_runs`` 的 SQL OFFSET）；meta 加
    ``total``（同 agent_id filter 的 COUNT(*)，**不叠加** ``state`` —— 那是内存派生后过滤，
    非 SQL-filterable，与 ``count_agent_runs`` 的口径保持一致，详见其 docstring）。

    L4 P4a（团队页记录列）：``agentId`` 不再等同于 ``target_key`` —— 经
    ``src.agents.run_sources.resolve_run_source`` 解析出该成员对应的 ``(job_type,
    target_key)``（🔴 target_key 语义随 job_type 变，见那张表的头注）。解析不出
    （事项域命名空间 / 空 id）→ **空集不报错**，且**连 run_log 也不查**（排除纪律）。
    ``agentId`` 缺省（列全部）时口径不变：只列 ``agent_run``，避免把事项域的 run 掺进
    pending-count 之类的全局面。

    L4 P4a run transcript 批：可解析成员**并查** ``agent_run_log`` 统一台账（报告 /
    画像 / 项目周报的详细过程记录落那里，``agent_id`` 列直接是成员 id 命名空间），
    与 async_jobs 行按开始时刻合并成同一条时间线。实践中没有成员同时写两处
    （async_jobs XOR run_log），单源时分页原样透传；两源都有行的兜底档在内存窗口
    （≤100）里合并再切片。
    """
    _require_flag()
    if state is not None and state not in AGENT_RUN_STATES:
        raise APIError(
            "E_INVALID_ARG",
            f"unknown state {state!r} (expected one of {sorted(AGENT_RUN_STATES)})",
            http_status=400,
            source="agent-runs",
        )
    repo = get_job_repo()
    if agent_id is None:
        jobs = repo.list_agent_runs(limit=limit, offset=offset)
        items = [_run_history_item(j) for j in jobs]
        total = repo.count_agent_runs()
    else:
        source = resolve_run_source(agent_id)
        if source is None:
            # 本域不认识这个成员（事项域的 `matter:` / `matter_item:` 命名空间恒落这里）。
            items, total = [], 0
        else:
            db_path = str(repo.db_path)
            job_total = repo.count_runs(
                job_type=source.job_type, target_key=source.target_key
            )
            log_total = count_run_logs(db_path, agent_id=agent_id)
            total = job_total + log_total
            if log_total == 0:
                jobs = repo.list_runs(
                    job_type=source.job_type,
                    target_key=source.target_key,
                    limit=limit,
                    offset=offset,
                )
                items = [_run_history_item(j, agent_id_override=agent_id) for j in jobs]
            elif job_total == 0:
                items = [
                    _run_log_item(r)
                    for r in list_run_logs(
                        db_path, agent_id=agent_id, limit=limit, offset=offset
                    )
                ]
            else:
                window = min(100, limit + offset)
                jobs = repo.list_runs(
                    job_type=source.job_type,
                    target_key=source.target_key,
                    limit=window,
                    offset=0,
                )
                rows = list_run_logs(db_path, agent_id=agent_id, limit=window, offset=0)
                merged = sorted(
                    [
                        (float(j.created_at), _run_history_item(j, agent_id_override=agent_id))
                        for j in jobs
                    ]
                    + [(float(r["started_at"]) / 1000.0, _run_log_item(r)) for r in rows],
                    key=lambda pair: pair[0],
                    reverse=True,
                )
                items = [it for _, it in merged[offset : offset + limit]]
    if state is not None:
        items = [it for it in items if it["state"] == state]
    _annotate_auto_whitelist(items)
    return success_envelope(
        items,
        request=request,
        source="agent-runs",
        meta_extra={"count": len(items), "total": total, "limit": limit, "offset": offset},
    )
