"""Approval mode, auto-compact, labs flags, tool-prefs, whitelist, and policy routes."""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from loguru import logger

from src.agent_config.store import get_agent_config_store
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token

router = APIRouter()


def _agent_facade():
    from src.api.routers import agent as m

    return m

CHAT_APPROVAL_MODES: tuple[str, ...] = ("manual", "bypass")
_APPROVAL_MODE_KEY = "chat_approval_mode"
CHAT_AUTO_COMPACT_MODES: tuple[str, ...] = ("on", "off")
_AUTO_COMPACT_KEY = "chat_auto_compact"


@router.get("/approval-mode", dependencies=[Depends(verify_cf_access)])
async def get_approval_mode(request: Request):
    """读全局 chat 授权模式。无行 / 脏值 / 退役的 'acceptEdits' → 'manual'（fail-closed）。"""
    raw = get_agent_config_store().get_owner_setting(_APPROVAL_MODE_KEY)
    mode = raw if raw in CHAT_APPROVAL_MODES else "manual"
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.put("/approval-mode", dependencies=[Depends(verify_cf_access)])
async def set_approval_mode(request: Request, body: Optional[dict[str, Any]] = None):
    """写全局 chat 授权模式。body = {mode: 'manual'|'bypass'}；越域值（含退役的
    'acceptEdits'——08-05 WP-11，降级归宿是 POST /tool-prefs/preset）一律 400。

    切换（尤其 bypass）落一条 INFO 审计日志 —— 这是所有 HITL 弹卡语义的全局越权开关。"""
    mode = (body or {}).get("mode")
    if mode not in CHAT_APPROVAL_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.mode must be one of {CHAT_APPROVAL_MODES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_APPROVAL_MODE_KEY) or "manual"
    store.set_owner_setting(_APPROVAL_MODE_KEY, mode)

    logger.info(f"chat approval mode switched: {previous} → {mode} (owner UI)")
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.get("/auto-compact", dependencies=[Depends(verify_cf_access)])
async def get_auto_compact(request: Request):
    """读 owner 自动 Compact 开关。缺行/脏值按冻结决策缺省为 on。"""
    raw = get_agent_config_store().get_owner_setting(_AUTO_COMPACT_KEY)
    mode = raw if raw in CHAT_AUTO_COMPACT_MODES else "on"
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.put("/auto-compact", dependencies=[Depends(verify_cf_access)])
async def set_auto_compact(request: Request, body: Optional[dict[str, Any]] = None):
    """写 owner 自动 Compact 开关；仅 owner UI 可达，越域值一律 400。"""
    mode = (body or {}).get("mode")
    if mode not in CHAT_AUTO_COMPACT_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.mode must be one of {CHAT_AUTO_COMPACT_MODES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_AUTO_COMPACT_KEY) or "on"
    store.set_owner_setting(_AUTO_COMPACT_KEY, mode)
    logger.info(f"chat auto compact switched: {previous} → {mode} (owner UI)")
    return success_envelope({"mode": mode}, request=request, source="sqlite")



LABS_FLAG_VALUES: tuple[str, ...] = ("on", "off")
_LABS_GROUP_AGENTS_KEY = "labs_group_agents"
_LABS_GROUP_AGENTS_DEFAULT = "on"


@router.get("/labs", dependencies=[Depends(verify_cf_access)])
async def get_labs_flags(request: Request):
    """读 labs 实验开关。缺行 / 脏值 → 出厂默认（``_LABS_GROUP_AGENTS_DEFAULT``）。"""
    raw = get_agent_config_store().get_owner_setting(_LABS_GROUP_AGENTS_KEY)
    return success_envelope(
        {"groupAgents": raw if raw in LABS_FLAG_VALUES else _LABS_GROUP_AGENTS_DEFAULT},
        request=request,
        source="sqlite",
    )


@router.put("/labs", dependencies=[Depends(verify_cf_access)])
async def set_labs_flags(request: Request, body: Optional[dict[str, Any]] = None):
    """写 labs 实验开关。body = {groupAgents: 'on'|'off'}（只写传了的键）；越域值一律 400。

    切换落一条 INFO 审计日志 —— 打开它等于把「谁来驱动群里的发言」从 renderer 换成服务端。"""
    opts = body or {}
    if "groupAgents" not in opts:
        raise APIError(
            "E_INVALID_ARG",
            "body must carry at least one labs flag (groupAgents)",
            http_status=400,
            source="sqlite",
        )
    value = opts.get("groupAgents")
    if value not in LABS_FLAG_VALUES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.groupAgents must be one of {LABS_FLAG_VALUES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_LABS_GROUP_AGENTS_KEY) or _LABS_GROUP_AGENTS_DEFAULT
    store.set_owner_setting(_LABS_GROUP_AGENTS_KEY, value)
    logger.info(f"labs group-agents switched: {previous} → {value} (owner UI)")
    return success_envelope({"groupAgents": value}, request=request, source="sqlite")



_SEND_WHITELIST_KEY = "send_recipient_whitelist"


def _send_whitelist(store) -> list[str]:
    """读 send 收件人白名单（owner_settings JSON 数组）；缺行/坏 JSON → []（= 恒 ask）。"""
    raw = store.get_owner_setting(_SEND_WHITELIST_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return [e for e in data if isinstance(e, str)] if isinstance(data, list) else []


def _tool_prefs_payload(store) -> dict[str, Any]:
    """GET /tool-prefs 的数据形状：全部注册表工具（分组有序）+ send 白名单 + 预设成员表。"""
    from src.agent_config.tool_prefs import (
        ACCEPT_EDITS_PRESET,
        BUILTIN_TOOL_POLICIES,
        effective_tool_tier,
    )

    overrides = store.get_tool_approval_prefs()
    tools = [
        {
            "toolName": p.tool_name,
            "group": p.group,
            "defaultTier": p.default_tier,
            "tier": overrides.get(p.tool_name),  # 显式覆盖（null = 跟随默认）
            "effectiveTier": effective_tool_tier(p.tool_name, overrides.get(p.tool_name)),
            "configurable": p.configurable,
            "dangerAuto": p.danger_auto,
        }
        for p in BUILTIN_TOOL_POLICIES
    ]
    return {
        "tools": tools,
        "sendWhitelist": _send_whitelist(store),
        "acceptEditsPreset": list(ACCEPT_EDITS_PRESET),
    }


def _require_configurable(tool_name: str):
    """PUT/bulk 的业务校验：工具在注册表且 configurable。返回 policy 行；否则 APIError。"""
    from src.agent_config.tool_prefs import BUILTIN_TOOL_POLICY_BY_NAME

    policy = BUILTIN_TOOL_POLICY_BY_NAME.get(tool_name)
    if policy is None:
        raise APIError(
            "E_NOT_FOUND",
            f"unknown built-in write tool: {tool_name}",
            http_status=404,
            source="sqlite",
        )
    if not policy.configurable:
        raise APIError(
            "E_INVALID_ARG",
            f"{tool_name} is not tier-configurable (its approval shape is fixed; "
            "send uses the recipient whitelist, run_command uses policy rules)",
            http_status=400,
            source="sqlite",
        )
    return policy


@router.get("/tool-prefs", dependencies=[Depends(verify_cf_access)])
async def get_tool_prefs(request: Request):
    """全部 built-in 写工具的审批档（出厂默认 + 显式覆盖 + 折算 effective）+ send 白名单。"""
    payload = _tool_prefs_payload(get_agent_config_store())
    return success_envelope(payload, request=request, source="sqlite",
                            meta_extra={"count": len(payload["tools"])})


@router.put("/tool-prefs/{tool_name}", dependencies=[Depends(verify_cf_access)])
async def set_tool_pref(tool_name: str, request: Request,
                        body: Optional[dict[str, Any]] = None):
    """写/清一个工具的显式档位。body = {tier: 'ask'|'auto'|'deny'|null}（null = 回默认）。

    危险工具（dangerAuto）设 auto 的红警告 + 一次性确认在前端（WP-10 destructive
    confirm 同款）——服务端不重复拦（owner UI 是唯一调用方）。"""
    from src.agent_config.tool_prefs import TOOL_APPROVAL_TIERS

    _require_configurable(tool_name)
    tier = (body or {}).get("tier")
    if tier is not None and tier not in TOOL_APPROVAL_TIERS:
        raise APIError(
            "E_INVALID_ARG",
            f"body.tier must be one of {TOOL_APPROVAL_TIERS} or null",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    store.set_tool_approval_pref(tool_name, tier)
    logger.info(f"tool approval pref: {tool_name} → {tier or 'default'} (owner UI)")
    return success_envelope(_tool_prefs_payload(store), request=request, source="sqlite")


@router.post("/tool-prefs/bulk", dependencies=[Depends(verify_cf_access)])
async def bulk_set_tool_prefs(request: Request, body: Optional[dict[str, Any]] = None):
    """组级批量设档。body = {tier: 'ask'|'auto'|'deny'|null, group?: str, tools?: [names]}。

    ``group`` 与 ``tools`` 二选一（都缺 = 全部可配置工具）。目标集合里不可配置的工具
    **跳过**（组级批量把 send/run_command 也改了会静默打穿它们的专属形状）；显式
    ``tools`` 名单里出现不可配置/未知名则整批 400（显式点名必须精确）。"""
    from src.agent_config.tool_prefs import (
        BUILTIN_TOOL_POLICIES,
        TOOL_APPROVAL_TIERS,
        TOOL_PREF_GROUPS,
    )

    raw = body or {}
    tier = raw.get("tier")
    if tier is not None and tier not in TOOL_APPROVAL_TIERS:
        raise APIError(
            "E_INVALID_ARG",
            f"body.tier must be one of {TOOL_APPROVAL_TIERS} or null",
            http_status=400,
            source="sqlite",
        )
    group = raw.get("group")
    explicit = raw.get("tools")
    if group is not None and explicit is not None:
        raise APIError("E_INVALID_ARG", "pass either body.group or body.tools, not both",
                       http_status=400, source="sqlite")
    if group is not None:
        if group not in TOOL_PREF_GROUPS:
            raise APIError(
                "E_INVALID_ARG",
                f"body.group must be one of {TOOL_PREF_GROUPS}",
                http_status=400,
                source="sqlite",
            )
        names = [p.tool_name for p in BUILTIN_TOOL_POLICIES
                 if p.group == group and p.configurable]
    elif explicit is not None:
        if not isinstance(explicit, list) or not all(isinstance(n, str) for n in explicit):
            raise APIError("E_INVALID_ARG", "body.tools must be a list of tool names",
                           http_status=400, source="sqlite")
        for name in explicit:
            _require_configurable(name)  # 显式点名必须逐个合法（未知/不可配置 → 4xx）
        names = list(dict.fromkeys(explicit))
    else:
        names = [p.tool_name for p in BUILTIN_TOOL_POLICIES if p.configurable]
    store = get_agent_config_store()
    updated = store.bulk_set_tool_approval_prefs(names, tier)
    logger.info(
        f"tool approval prefs bulk: {updated} tools → {tier or 'default'} "
        f"(group={group or '-'}, owner UI)"
    )
    payload = _tool_prefs_payload(store)
    payload["updated"] = updated
    return success_envelope(payload, request=request, source="sqlite")


@router.post("/tool-prefs/preset", dependencies=[Depends(verify_cf_access)])
async def apply_tool_prefs_preset(request: Request, body: Optional[dict[str, Any]] = None):
    """套用一键预设。body = {preset: 'acceptEdits'}——07-16 acceptEdits 集合的降级归宿：
    把 15 个预设成员批量设**显式 auto**（成员表 canonical 在 tool_prefs.py，前端不手抄）。"""
    from src.agent_config.tool_prefs import ACCEPT_EDITS_PRESET

    preset = (body or {}).get("preset")
    if preset != "acceptEdits":
        raise APIError("E_INVALID_ARG", "body.preset must be 'acceptEdits'",
                       http_status=400, source="sqlite")
    store = get_agent_config_store()
    updated = store.bulk_set_tool_approval_prefs(ACCEPT_EDITS_PRESET, "auto")
    logger.info(f"tool approval prefs preset 'acceptEdits' applied ({updated} tools, owner UI)")
    payload = _tool_prefs_payload(store)
    payload["updated"] = updated
    return success_envelope(payload, request=request, source="sqlite")


@router.post("/tool-prefs/reset", dependencies=[Depends(verify_cf_access)])
async def reset_tool_prefs(request: Request):
    """Reset permissions —— 清空全部显式覆盖，所有工具回出厂默认档。"""
    store = get_agent_config_store()
    removed = store.reset_tool_approval_prefs()
    logger.info(f"tool approval prefs reset ({removed} overrides cleared, owner UI)")
    payload = _tool_prefs_payload(store)
    payload["removed"] = removed
    return success_envelope(payload, request=request, source="sqlite")


@router.put("/send-whitelist", dependencies=[Depends(verify_cf_access)])
async def set_send_whitelist(request: Request, body: Optional[dict[str, Any]] = None):
    """写 send 收件人白名单（D2=a：send 唯一的免卡形状）。body = {recipients: [str]}。

    条目 = 完整邮箱或 '@domain' 域名形状（tool_prefs.validate_send_whitelist 校验 +
    小写归一去重）；空数组 = 清空 = send 恒 ask。非法条目整批 400。"""
    from src.agent_config.tool_prefs import validate_send_whitelist

    recipients = (body or {}).get("recipients")
    try:
        normalized = validate_send_whitelist(recipients)
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    store = get_agent_config_store()
    store.set_owner_setting(_SEND_WHITELIST_KEY, json.dumps(normalized, ensure_ascii=False))
    logger.info(f"send recipient whitelist updated ({len(normalized)} entries, owner UI)")
    return success_envelope({"sendWhitelist": normalized}, request=request, source="sqlite")



# per-agent 规则的 capability 面：domain_write（ADR-004 D1 免卡）+ exec（D2 pinned-entrypoint）+
# web（S6 W3, ADR-004 rev3.1 D2/F#1 —— gated web_fetch 的域名白名单，matcher = WebMatcher
# {v:1, origin}，无 headless 专用形状闸：origin 白名单对 manual 与 headless 同样合法，双键隔离
# 即唯一结构约束）。file_read/file_write 不在设计面（无形状约束设计），建规拒 —— 需要时随对应
# grant 键另立 ADR。
_PER_AGENT_CAPABILITIES: tuple[str, ...] = ("domain_write", "exec", "web")


def _derive_rule_context_mode(agent: dict[str, Any]) -> str:
    """per-agent 规则的 context_mode **只**从 agent trigger.kind 派生（ADR-004 §3.3：表单/请求
    不可选 —— 用户没有机会配出跨上下文规则）：email_filter → untrusted_trigger /
    cron|schedule → cron_headless（schedule = schedule-builder 结构化定时，与 cron 同为
    无攻击者可控输入的定时 headless）/ im → im_chat（阶段 0b 预置，harness-expansion epic
    grill Q10=A —— 阶段 2 飞书对话的第四场合）。坏 trigger → ValueError（400）。

    🔴 本表共 **三份镜像**，改任何一份必须同批改齐（漏改 = 盖章与求值失配 → 免卡规则
    永不命中 / 抽屉全 dormant）：① 本函数（建规盖章权威）② gateway
    ``frontend/src/ai-gateway/agentRun.ts::deriveContextMode``（运行时求值）③ 抽屉
    ``frontend/src/shared/components/agents/custom-agent/shared.ts::deriveHeadlessMode``
    （展示）。跨表一致性闸：``tests/api/test_context_mode_consistency.py``（canonical 表
    在闸里，TS 两份从源码抽取比对 —— 改这里先改闸）。"""
    from src.agents.trigger import _as_dict, parse_trigger, parse_trigger_set, trigger_v2_enabled

    # 阶段 0b 预置映射行：kind='im' → 'im_chat'。parse_trigger 尚不认识 'im'（保存面在阶段 2
    # 才放开，validate_agent_config_patch 仍拒 → 这种行当前存不进库，本分支 dormant），故在
    # parse 前 peek 原始 kind；``_as_dict`` 是有意的私有 import（trigger_json 归一化单源，
    # 镜像 test_trigger_kind_parity 对 ``_RULE_KEYS`` 的处理）。阶段 2 给 parse_trigger 加
    # im 分支后应把此 peek 收回 post-parse。
    raw = _as_dict(agent.get("trigger_json")) or {}
    if raw.get("kind") == "im" or any(
        isinstance(item, dict) and item.get("kind") == "im"
        for item in (raw.get("triggers") if isinstance(raw.get("triggers"), list) else [])
    ):
        return "im_chat"
    if trigger_v2_enabled() and raw.get("v") == 2:
        entries = parse_trigger_set(raw)
        if not entries:
            raise ValueError("trigger_json is empty or not an object")
        return (
            "cron_headless"
            if all(entry.trigger.kind in ("cron", "schedule") for entry in entries)
            else "untrusted_trigger"
        )
    trig = parse_trigger(agent.get("trigger_json"))  # TriggerValidationError（ValueError）on 坏配置
    return "cron_headless" if trig.kind in ("cron", "schedule") else "untrusted_trigger"


def _policy_rule_dict(r: Any) -> dict[str, Any]:
    from src.agent_config.policy import rule_is_dangerously_wide

    return {
        "id": r.id,
        "capability": r.capability,
        "matcher": r.matcher,
        "contextMode": r.context_mode,
        "agentId": r.agent_id,
        "enabled": r.enabled,
        "note": r.note,
        "createdAt": r.created_at,
        "lastUsedAt": r.last_used_at,
        "useCount": r.use_count,
        # 危险宽规则（危险 argv0 + {any} 通配）标红供 W1b UI 警告——入库不拒（owner 可手动放宽）。
        "dangerous": rule_is_dangerously_wide(r.matcher),
    }


@router.get("/policy/rules", dependencies=[Depends(verify_cf_access)])
async def list_policy_rules(
    request: Request,
    capability: Optional[str] = Query(default=None),
    context_mode: Optional[str] = Query(default=None, alias="contextMode"),
    agent_id: Optional[str] = Query(default=None, alias="agentId"),
):
    """列策略规则（可选按 capability / contextMode / agentId 过滤），最新在前，带 dangerous 标志。
    agentId 缺省 = 全部行（现状）；有值 = 该 agent 的 per-agent 规则（Settings per-agent 面用）。"""
    store = get_agent_config_store()
    rules = store.list_policy_rules(
        capability=capability, context_mode=context_mode, agent_id=agent_id
    )
    data = [_policy_rule_dict(r) for r in rules]
    return success_envelope(
        {"rules": data}, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


@router.post("/policy/rules", dependencies=[Depends(verify_cf_access)])
async def create_policy_rule(request: Request, body: Optional[dict[str, Any]] = None):
    """建一条结构化白名单规则。body = {capability, matcher, contextMode?, note?, agentId?}。

    无 agentId（全局/manual 分支，S2 语义逐字不变）：matcher 经 parse_matcher 校验（非法 →
    422）；contextMode 默认 manual_chat；capability 限 S2 四族（domain_write 是 per-agent 专属）。

    有 agentId（per-agent headless 分支，ADR-004 §3.3/§4.3）：
      - flag ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` off → 404（S4 纪律，feature 不存在）；
      - agentId 须指向 sync_store 现存 ``type='custom'`` agent（拒空串/悬空归属，codex P1-5）；
      - contextMode **从 agent trigger.kind 派生**，请求显式传 → 400（表单不可选，防跨上下文规则）；
      - capability 限 domain_write / exec / web；exec matcher 须过 pinned-entrypoint 形状闸
        （raw ``{any}`` / 非 installed-skill entrypoint → 400，evaluate 侧另有 skip 复核双防线）；
        web matcher = ``{v:1, origin}``（canonical origin 校验，无 headless 专用形状闸，rev3.1）。
    """
    import json

    from src.agent_config.policy import (
        CAPABILITIES,
        CONTEXT_MODES,
        headless_exec_rule_problem,
        parse_matcher,
    )

    raw = body or {}
    capability = raw.get("capability")
    matcher = raw.get("matcher")
    note = raw.get("note")
    agent_id = raw.get("agentId")
    if capability not in CAPABILITIES:
        raise APIError("E_INVALID_ARG", f"capability must be one of {list(CAPABILITIES)}",
                       http_status=400, source="sqlite")
    if not isinstance(matcher, dict):
        raise APIError("E_INVALID_ARG", "matcher must be an object", http_status=400, source="sqlite")
    if note is not None and not isinstance(note, str):
        raise APIError("E_INVALID_ARG", "note must be a string", http_status=400, source="sqlite")

    if agent_id is not None:
        # ── per-agent headless 分支（ADR-004）────────────────────────────────
        if not _agent_facade()._custom_agents_enabled():
            raise APIError("E_NOT_FOUND", "custom agents feature is disabled",
                           http_status=404, source="sqlite")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise APIError("E_INVALID_ARG", "agentId must be a non-empty string",
                           http_status=400, source="sqlite")
        agent_id = agent_id.strip()
        if capability not in _PER_AGENT_CAPABILITIES:
            raise APIError(
                "E_INVALID_ARG",
                f"per-agent rules only support capabilities {list(_PER_AGENT_CAPABILITIES)}",
                http_status=400, source="sqlite",
            )
        if "contextMode" in raw:
            raise APIError(
                "E_INVALID_ARG",
                "contextMode is derived from the agent trigger for per-agent rules; do not pass it",
                http_status=400, source="sqlite",
            )
        from src.api.deps import get_report_store

        agent = get_report_store().get_agent(agent_id)
        if agent is None or (agent.get("type") or "") != "custom":
            raise APIError(
                "E_INVALID_ARG",
                f"agentId must reference an existing custom agent, got {agent_id!r}",
                http_status=400, source="sqlite",
            )
        try:
            context_mode = _derive_rule_context_mode(agent)
        except ValueError as exc:
            raise APIError(
                "E_INVALID_ARG",
                f"agent {agent_id!r} has invalid trigger_json ({exc}); fix the agent first",
                http_status=400, source="sqlite",
            ) from exc
    else:
        # ── 全局（manual）分支 —— S2 语义逐字不变 ─────────────────────────────
        if capability == "domain_write":
            raise APIError(
                "E_INVALID_ARG",
                "domain_write rules are per-agent only (agentId required)",
                http_status=400, source="sqlite",
            )
        context_mode = raw.get("contextMode", "manual_chat")
        if context_mode not in CONTEXT_MODES:
            raise APIError("E_INVALID_ARG", f"contextMode must be one of {list(CONTEXT_MODES)}",
                           http_status=400, source="sqlite")

    store = get_agent_config_store()
    try:
        parsed = parse_matcher(capability, matcher)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError / ValueError → 422
        raise APIError("E_INVALID_ARG", f"invalid matcher: {exc}", http_status=422, source="sqlite") from exc
    if capability == "web":
        # canonical origin 归一入库（ADR-004 rev3.1 §4.2 ① —— 唯一权威实现 _normalize_origin）：
        # parse_matcher 已过 _valid_origin ⇒ 归一必非 None。入库存 canonical（Settings/PIN 回显归一
        # 值 + redirect 聚合集/策略匹配对同一 host 恒等值），完整 URL 提交也塌成 scheme://host:port。
        from src.agent_config.policy import _normalize_origin

        canonical = _normalize_origin(matcher.get("origin", ""))
        if canonical is not None:
            matcher = {**matcher, "origin": canonical}
    if agent_id is not None and capability == "exec":
        problem = headless_exec_rule_problem(store, parsed)
        if problem is not None:
            raise APIError(
                "E_INVALID_ARG", f"invalid headless exec rule: {problem}",
                http_status=400, source="sqlite",
            )
        # S6 W3（rev3.1 §5.2）挂载归属闸（建规侧防线之一，evaluate 侧同判 skip）：exec 规则
        # 引用的 installed skill 必须 ∈ 该 agent 挂载集（skills NULL → 默认挂载集）。形状闸
        # 已过 ⇒ entrypoint 归属可解析；解析不出（并发卸载等竞态）同样拒 —— fail-closed。
        from src.agent_config.policy import exec_entrypoint_skill
        from src.api.routers.agent_runs import resolve_mounted_skills

        skill_name = exec_entrypoint_skill(parsed)
        if skill_name is None or skill_name not in resolve_mounted_skills(agent):
            raise APIError(
                "E_INVALID_ARG",
                f"installed skill {skill_name!r} is not mounted on agent {agent_id!r}; "
                "add it to the agent's skills first",
                http_status=400, source="sqlite",
            )
    rule = store.create_policy_rule(
        capability,
        json.dumps(matcher, ensure_ascii=False, sort_keys=True),
        context_mode=context_mode,
        note=note,
        agent_id=agent_id,
    )
    return success_envelope(_policy_rule_dict(rule), request=request, source="sqlite", status_code=201)


@router.patch("/policy/rules/{rule_id}", dependencies=[Depends(verify_cf_access)])
async def patch_policy_rule(rule_id: int, request: Request, body: Optional[dict[str, Any]] = None):
    """启用/停用 + 改备注（matcher 不可 patch —— 放宽 = 删旧建新）。不存在 → 404。"""
    raw = body or {}
    enabled = raw.get("enabled")
    note = raw.get("note")
    if enabled is not None and not isinstance(enabled, bool):
        raise APIError("E_INVALID_ARG", "enabled must be a boolean", http_status=400, source="sqlite")
    if note is not None and not isinstance(note, str):
        raise APIError("E_INVALID_ARG", "note must be a string", http_status=400, source="sqlite")
    rule = get_agent_config_store().set_policy_rule(rule_id, enabled=enabled, note=note)
    if rule is None:
        raise APIError("E_NOT_FOUND", f"policy rule not found: {rule_id}", http_status=404, source="sqlite")
    return success_envelope(_policy_rule_dict(rule), request=request, source="sqlite")


@router.delete("/policy/rules/{rule_id}", dependencies=[Depends(verify_cf_access)])
async def delete_policy_rule(rule_id: int, request: Request):
    """删一条规则。幂等（不存在 removed=false）。"""
    removed = get_agent_config_store().delete_policy_rule(rule_id)
    return success_envelope({"id": rule_id, "removed": removed}, request=request, source="sqlite")


def _library_path_resolver():
    """``file_id`` → 该文件**当前**的虚拟路径（``<根 slug>/<相对路径>``）；判不了就 None。

    P2-L3 B 的目标路径判据（design §5.3）。只认 ``status == 'present'`` 的行 —— 行不存在 / 已软删 /
    磁盘上丢了都返 None，policy 侧据此 ask（「读不到就放行」等于把地板拆了）。走 ``files()`` 而不是
    ``file()``：后者会把文本类文件整个读进内存，而这里只要一列元数据。
    """

    def _resolve(file_id: int):
        from src.api.routers.library import get_library_service

        rows = get_library_service().files([int(file_id)])
        if not rows:
            return None
        row = rows[0]
        if row.get("status") != "present":
            return None
        path = row.get("path")
        return path if isinstance(path, str) and path else None

    return _resolve


@router.post("/policy/evaluate", dependencies=[Depends(verify_local_token)])
async def evaluate_policy(request: Request, body: Optional[dict[str, Any]] = None):
    """评估一次动作是否命中白名单 → {decision: auto_allow|ask, ruleId}。gateway W1b 的 needsApproval
    前置调用。body = {capability, action, contextMode?, agentId?}。contextMode 缺省/非法 →
    fail-closed 到 untrusted_trigger（manual 规则不匹配 → ask）；agentId 缺省 = manual 现状，
    有值 = headless per-agent 双键候选（ADR-004 §3.3）。

    🔴 鉴权 = ``verify_local_token``（**仅**本地 token，不接受 CF JWT）——唯一调用方是 in-process
    gateway domainClient（同机 loopback，恒带 ``X-MailAgent-Local-Token``），与 exec 三端点同形状。
    收窄理由：evaluate 是执行放行判定的前置门，若挂 ``verify_cf_access`` 则远程 CF 会话可探/预热
    白名单判决。**注**：``/policy/rules`` CRUD 仍走 ``verify_cf_access``（Settings UI 远程管理规则）。"""
    from src.agent_config.policy import CAPABILITIES, CONTEXT_MODES, evaluate

    raw = body or {}
    capability = raw.get("capability")
    action = raw.get("action")
    context_mode = raw.get("contextMode")
    agent_id = raw.get("agentId")
    if capability not in CAPABILITIES:
        raise APIError("E_INVALID_ARG", f"capability must be one of {list(CAPABILITIES)}",
                       http_status=400, source="sqlite")
    if not isinstance(action, dict):
        raise APIError("E_INVALID_ARG", "action must be an object", http_status=400, source="sqlite")
    if context_mode not in CONTEXT_MODES:
        context_mode = "untrusted_trigger"
    # agentId（S5 ADR-004 §3.3）：可选；不传 = manual 现状（候选 agent_id IS NULL）。非法类型
    # → 400（gateway 调用方 bug 早暴露；空串由 store 层拒 → evaluate 兜底 ask）。
    if agent_id is not None and not isinstance(agent_id, str):
        raise APIError("E_INVALID_ARG", "agentId must be a string", http_status=400, source="sqlite")
    # S6 W3（rev3.1 §5.2）：per-agent exec 评估须带该 agent 挂载集（evaluate 对未挂载/未接线
    # 的 installed-skill 规则 skip → dormant）。agent_config 不触 sync_store（模块边界），
    # 挂载集在本调用方从 agent 行解析；读失败 → 空集（fail-closed，全 dormant）。
    mounted_skills = None
    if agent_id is not None and capability == "exec":
        try:
            from src.api.deps import get_report_store
            from src.api.routers.agent_runs import resolve_mounted_skills

            # flag off = custom agents 不存在 → 不读 store（None → evaluate 恒 dormant）。
            if _agent_facade()._custom_agents_enabled():
                mounted_skills = resolve_mounted_skills(get_report_store().get_agent(agent_id))
        except Exception:  # noqa: BLE001 — store 读失败 → 空集（dormant，绝不放行）
            mounted_skills = frozenset()
    # P2-L3 B（design §5.3）：资料库无人值守免卡按**服务端事实**判目标路径 —— `file_id` 在这里反查
    # 成当前虚拟路径再交给 policy。agent_config 不触 library.db（模块边界），故是注入的回调；
    # 先例 = src/library/resource_resolver.py 给 matters 的那一个。只在 domain_write 上构造，
    # 其余 capability 一趟 LibraryService 都不建。
    library_path_resolver = _library_path_resolver() if capability == "domain_write" else None
    # 返回 {decision, rule_id}（snake）= policy 判决单一 verdict 形状，与 exec 端点响应的 policy 字段
    # 一致（W1b 一个 verdict 类型消费两处：/evaluate 前置调用 + exec 响应审计）。
    result = evaluate(get_agent_config_store(), capability, action, context_mode,
                      agent_id=agent_id, mounted_skills=mounted_skills,
                      library_path_resolver=library_path_resolver)
    return success_envelope(result, request=request, source="sqlite")
