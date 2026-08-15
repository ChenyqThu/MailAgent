"""事项跟进配置的**逐条**编辑（task 08-14）。

主 agent 通过 `matter_followup_mutate` 改事项的跟进方式。这里是它的纯逻辑层：把一次
operation 折成给 `MatterService.patch_matter` 的 binding patch（`schedule_json` /
`agent_enabled` / `agent_profile_id` / `matter_instructions` 四键的子集）。

🔴 **只有逐条口，结构性没有「整份替换」入口**。整份替换意味着模型一次 update 就能把 owner
配好的 event / condition trigger 静默删掉 —— 删除必须是显式带 `trigger_id` 的动作，少一个
id 就少删一条。这条纪律是 PRD D2 拍板的，不是实现偏好。

🔴 envelope 的解析/归一/dump 全部复用 `triggers.py`（唯一真源）：每个 operation 只负责把
「改完的 envelope dict」拼出来，再交给 `normalize_trigger_json` 走与 REST / CLI 完全同一条
校验路径。自己拼 JSON 落库 = 绕开校验，坏 rule 会一路睡到 worker 里才炸。
"""

from __future__ import annotations

from typing import Any, Mapping

from .triggers import (
    TriggerError,
    dump_trigger_set,
    normalize_agent_overrides,
    normalize_trigger_json,
    parse_agent_overrides,
    parse_run_actions,
    parse_trigger_set,
)

#: 逐条 operation 的值域。跨语言手抄面 = TS `matterFollowupMutateSchema` 的 operation 枚举，
#: 闸见 `tests/matters/test_matters_contract_parity.py::test_followup_operation_enum_matches_python`。
FOLLOWUP_OPERATIONS = (
    "add_trigger",
    "update_trigger",
    "remove_trigger",
    "set_trigger_enabled",
    "set_actions",
    "set_enabled",
    "set_profile",
    "set_instructions",
    "set_model_override",
)

MATTER_INSTRUCTIONS_MAX_CHARS = 4000


def followup_view(matter: Mapping[str, Any]) -> dict[str, Any]:
    """matter 行 → 结构化跟进配置（`matter_get` 的 `include=followup` 投影）。

    读侧同样走 `parse_*` 单源，于是 v1 老形状会被惰性映射成 v2 entries **而不改写库** ——
    模型看到的形状与 worker 求值用的形状是同一个。
    """
    raw = matter.get("schedule_json")
    seed = str(matter.get("id") or matter.get("public_id") or "")
    try:
        entries = parse_trigger_set(raw, seed=seed)
        actions = list(parse_run_actions(raw))
        agent = parse_agent_overrides(raw)
        parse_error: str | None = None
    except TriggerError as exc:
        # 坏数据不隐身：报出来让模型/owner 看见，而不是假装「没有排程」。
        entries, actions, agent = (), [], {}
        parse_error = str(exc)
    return {
        "enabled": bool(matter.get("agent_enabled")),
        "profile_id": matter.get("agent_profile_id"),
        "instructions": matter.get("matter_instructions"),
        "triggers": [entry.to_dict() for entry in entries],
        "actions": actions,
        "agent": agent,
        "parse_error": parse_error,
    }


def _envelope_from(matter: Mapping[str, Any], seed: str) -> dict[str, Any]:
    """当前库值 → 可编辑的 v2 envelope dict（老形状在此归一）。"""
    raw = matter.get("schedule_json")
    return dump_trigger_set(
        parse_trigger_set(raw, seed=seed),
        actions=parse_run_actions(raw),
        agent=parse_agent_overrides(raw),
    )


def _triggers_of(envelope: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [dict(item) for item in (envelope.get("triggers") or [])]


def _require_id(payload: Mapping[str, Any]) -> str:
    value = payload.get("trigger_id")
    if not isinstance(value, str) or not value.strip():
        raise TriggerError("trigger_id is required")
    return value.strip()


def _find(triggers: list[dict[str, Any]], trigger_id: str) -> int:
    for index, item in enumerate(triggers):
        if str(item.get("id") or "") == trigger_id:
            return index
    raise TriggerError(f"no trigger {trigger_id} on this matter")


def apply_followup_operation(
    matter: Mapping[str, Any],
    operation: str,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """一次 operation → binding patch。不落库、不校验版本（交给 `patch_matter`）。"""
    if operation not in FOLLOWUP_OPERATIONS:
        raise TriggerError(f"unknown operation: {operation!r}")
    seed = str(matter.get("id") or matter.get("public_id") or "")

    # ── 三个绑定键：与 envelope 无关，直接落 patch ────────────────────────────────
    if operation == "set_enabled":
        value = payload.get("enabled")
        if not isinstance(value, bool):
            raise TriggerError("enabled must be a boolean")
        return {"agent_enabled": value}
    if operation == "set_profile":
        value = payload.get("profile_id")
        if value is not None and not isinstance(value, str):
            raise TriggerError("profile_id must be a string or null")
        # 悬空 profile 由 service 的绑定归一负责（只 warning 不硬拒），此处不重复判定。
        return {"agent_profile_id": (value.strip() or None) if isinstance(value, str) else None}
    if operation == "set_instructions":
        value = payload.get("instructions")
        if value is not None and not isinstance(value, str):
            raise TriggerError("instructions must be a string or null")
        if isinstance(value, str) and len(value) > MATTER_INSTRUCTIONS_MAX_CHARS:
            raise TriggerError(
                f"instructions exceeds {MATTER_INSTRUCTIONS_MAX_CHARS} characters"
            )
        return {"matter_instructions": value}

    # ── 其余六个都落在 envelope 上 ──────────────────────────────────────────────
    envelope = _envelope_from(matter, seed)
    triggers = _triggers_of(envelope)

    if operation == "add_trigger":
        entry = payload.get("trigger")
        if not isinstance(entry, Mapping):
            raise TriggerError("trigger object is required")
        # id 交给归一层按 (seed, index, kind) 派生 —— 模型不指定 id，也就无从覆盖既有条目。
        triggers.append({key: value for key, value in entry.items() if key != "id"})
    elif operation == "update_trigger":
        trigger_id = _require_id(payload)
        patch = payload.get("trigger")
        if not isinstance(patch, Mapping):
            raise TriggerError("trigger object is required")
        index = _find(triggers, trigger_id)
        # kind 不可改：换 kind 等于换一条 trigger，其 per-trigger marker 语义也随之改变
        # （旧 marker 会继续套用在新判据上）。要换就删了重加。
        incoming_kind = patch.get("kind")
        if incoming_kind is not None and str(incoming_kind) != str(triggers[index].get("kind")):
            raise TriggerError(
                "a trigger's kind cannot be changed — remove it and add a new one"
            )
        merged = {**triggers[index], **{k: v for k, v in patch.items() if k not in ("id", "kind")}}
        triggers[index] = merged
    elif operation == "remove_trigger":
        trigger_id = _require_id(payload)
        index = _find(triggers, trigger_id)
        triggers.pop(index)
    elif operation == "set_trigger_enabled":
        trigger_id = _require_id(payload)
        value = payload.get("enabled")
        if not isinstance(value, bool):
            raise TriggerError("enabled must be a boolean")
        index = _find(triggers, trigger_id)
        triggers[index] = {**triggers[index], "enabled": value}
    elif operation == "set_actions":
        actions = payload.get("actions")
        if not isinstance(actions, list):
            raise TriggerError("actions must be a list")
        envelope["actions"] = [str(item) for item in actions]
    elif operation == "set_model_override":
        agent = payload.get("agent")
        if agent is not None and not isinstance(agent, Mapping):
            raise TriggerError("agent must be an object or null")
        normalized = normalize_agent_overrides(agent)
        if normalized:
            envelope["agent"] = normalized
        else:
            envelope.pop("agent", None)

    envelope["triggers"] = triggers
    # 结构归一（未知 kind / 缺字段 / 超量 trigger 在此炸）。
    normalized = normalize_trigger_json(envelope, seed=seed)
    _validate_schedule_rules(normalized)
    return {"schedule_json": normalized}


def _validate_schedule_rules(envelope: Mapping[str, Any] | None) -> None:
    """🔴 rule 的**值域**深校验。

    `triggers.py` 有意只管结构（注释原话：「深校验由 `schedule_rule.parse_rule` 负责」），
    于是 `freq:"hourly"` 这种值能一路存进库，直到 worker 求值那一刻才在日志里失败 —— 对 owner
    表现为「排程保存成功了，但它再也没跑过」。UI 侧靠构建器控件挡住了这类值，而模型没有控件，
    所以这条通道必须自己校验。
    """
    if not envelope:
        return
    from src.agents.schedule_rule import ScheduleRuleError, parse_anchor, parse_rule

    for entry in envelope.get("triggers") or []:
        if entry.get("kind") != "schedule":
            continue
        try:
            parse_rule(entry.get("rule"))
            parse_anchor(entry.get("anchor"))
        except ScheduleRuleError as exc:
            raise TriggerError(f"invalid schedule rule: {exc}") from exc
