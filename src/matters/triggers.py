"""Matter 跟进触发器的解析 / 归一化单源（P6-B D6/D15/D16）。

`matter.schedule_json` 这一列的**内容**从「单个 schedule 对象」升成 envelope：

    {"v": 2, "triggers": [{"id": "mtr_ab12cd", "kind": "schedule", "enabled": true, ...}]}

列名不改（改名要波及 service 白名单 / 契约 / 测试，收益为零）。老形状在**读侧**惰性
映射成单 entry 数组，不改写库 —— 照 `MAILAGENT_TRIGGER_V2` 的 up-convert 先例。

四种 kind 的判定路径彼此独立：

- ``schedule``  → 复用 `src/agents/schedule_rule` 求值器（该模块**零改动**）
- ``event``     → 新增的 `matter_event` 行（新证据到达）
- ``condition`` → open 状态的 `matter_attention` 信号
- ``manual``    → 不自动触发，只由「立即跟进」按钮驱动

🔴 EVENT/CONDITION 的选项集**刻意小于设计稿**：只收录能映射到既有判据的项（D15）。
设计里的「会议结束」（calendar 与 matter 零接线）、「超过 5 天无进展」（Python 侧无此
判据）不做 —— 与其给四个选项里两个永不触发，不如少给两个。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .models import MatterRunTrigger

TRIGGER_ENVELOPE_VERSION = 2

#: 事件型触发的选项 → 判据。值是 `(event_kind, resource_kinds)`；resource_kinds 为空
#: 表示不按资源类型过滤。
EVENT_TRIGGER_CRITERIA: dict[str, tuple[str, frozenset[str]]] = {
    # 设计原文叫「收到干系人新邮件」，但判「发件人是不是干系人」需要回查邮件发件人再
    # 比对 matter_stakeholder，那是**新造判据**（D6 禁止）。订阅进事项的邮件本就是这条
    # 证据流，所以按「关联了新的邮件或会话」落地，文案也照实写。
    "resource_linked_mail": ("resource_linked", frozenset({"email", "thread"})),
    "resource_doc_updated": ("resource_updated", frozenset({"doc"})),
}

#: 条件型触发的选项 → `matter_attention.kind`。三项都直接命中既有信号。
#: 🔴 `wait_overdue` 的真实阈值是 `attention.WAIT_OVERDUE_DAYS = 7` 天，不是设计稿写的
#: 3 天 —— UI 文案按 7 天写，不改判据（改阈值会波及通知与 Focus 页计数）。
CONDITION_TRIGGER_KINDS: frozenset[str] = frozenset(
    {"action_overdue", "health_down", "wait_overdue"}
)

EVENT_TRIGGER_TYPES: tuple[str, ...] = tuple(sorted(EVENT_TRIGGER_CRITERIA))
CONDITION_TRIGGER_TYPES: tuple[str, ...] = tuple(sorted(CONDITION_TRIGGER_KINDS))

MAX_TRIGGERS = 8

#: 「跟进时执行」四项（设计 §5.2 的 ACTIONS）。跟触发方式同属一张「跟进规则」卡，
#: 所以**跟着 envelope 走**、不新开一列 —— 零 DB 迁移。
#:
#: 🔴 勾选**不扩大工具面**。allowlist 与 Observe+Assist 上限是服务端强制的结构红线：
#: 勾了 `draft` 也只是让提案里带一段可直接用的回信草稿，不会多给一个发信/存草稿工具。
#: 这里定的是「本次跟进要产出什么」，不是「能调用什么」。
RUN_ACTIONS: tuple[str, ...] = ("summary", "items", "draft", "proposal")

#: 出厂默认 = 设计稿里预先勾上的前两项。空/缺失 → 用它（不写库）。
DEFAULT_RUN_ACTIONS: tuple[str, ...] = ("summary", "items")


def normalize_run_actions(raw: Any) -> tuple[str, ...]:
    """归一化「跟进时执行」：保序去重、剔除未知值；空输入回落默认。

    未知值**丢弃而不抛** —— 与 trigger 相反：trigger 认不出就意味着"排程静默失效"，
    必须炸；而 action 认不出只是少做一件事，不该让整个事项的配置保存不下来。
    """
    if raw is None:
        return DEFAULT_RUN_ACTIONS
    if not isinstance(raw, (list, tuple)):
        return DEFAULT_RUN_ACTIONS
    seen: list[str] = []
    for value in raw:
        if isinstance(value, str) and value in RUN_ACTIONS and value not in seen:
            seen.append(value)
    return tuple(seen) if seen else DEFAULT_RUN_ACTIONS


def parse_run_actions(raw: Any) -> tuple[str, ...]:
    """从 `schedule_json` 的内容里取「跟进时执行」。v1 行 / 无该键 → 默认两项。"""
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return DEFAULT_RUN_ACTIONS
    if not isinstance(raw, Mapping):
        return DEFAULT_RUN_ACTIONS
    if "actions" not in raw:
        return DEFAULT_RUN_ACTIONS
    return normalize_run_actions(raw.get("actions"))


class TriggerError(ValueError):
    """trigger 配置非法。调用侧转成 `E_INVALID_ARG`。"""


# ── 事项级模型覆盖（0813 dogfood 轮 3 反馈 #10）────────────────────────────────────
#
# owner 原话：「跟进规则页面，matter agent 配置，仍然没有模型配置、effort 配置、fallback 配置」。
#
# 🔴 **跟着 envelope 走、不新开一列**（与 `actions` 同一条纪律，零 DB 迁移）：这三项和触发方式
# 同属「跟进规则」那一张卡，用户改的是同一个模态、存的是同一次 PATCH。
#
# 🔴 三项都是**覆盖**语义：键缺席 = 跟随现状（绑定 profile 的 model/fallback、全局默认），
# 不是"存了一个等于默认值的快照"—— 这样以后换默认，没覆盖过的事项能跟着走。
# 唯一的例外是 `fallback_models: []`：它是**显式的「不设兜底」**，与"没配过"不是一回事，
# 所以空列表必须原样保留，不许当成空值折掉。
#
# 🔴 值域外**入库即拒**（不静默丢）：模型/档位配错了却存下来，UI 显示的与真跑的就劈叉了。
# 读侧（`parse_agent_overrides`）相反，取的是宽容路径 —— 跟进 run 不该因为一段可选覆盖
# 认不出来就跑不起来（同 `parse_run_actions` 的取舍）。

#: effort 档位的 canonical 值域。🔴 **跨语言手抄**：canonical 源是
#: `frontend/src/shared/modelCatalog/effortTiers.ts` 的 `EFFORT_TIERS`（wire 形状由 gateway
#: `thinking.ts::effortCallOptions` 按协议产出，Python 只负责把 owner 选的档位原样投进 spec）。
#: 闸 = `tests/matters/test_matters_contract_parity.py`。
MATTER_AGENT_EFFORT_TIERS: tuple[str, ...] = (
    "none", "low", "medium", "high", "xhigh", "max",
)

#: 模型引用（`providerId:modelId`）的长度上限。护栏而非语义：真实 ref 几十字符，
#: 这里只挡住把整段文本塞进配置的形状。
MATTER_AGENT_MODEL_MAX_CHARS = 200

#: 备用模型链的长度上限。UI 是单选（同预处理行的先例），留一点余量给将来的多选。
MATTER_AGENT_MAX_FALLBACK_MODELS = 4


def _model_ref(value: Any, *, field: str, strict: bool) -> str | None:
    if not isinstance(value, str):
        if strict:
            raise TriggerError(f"{field} must be a string")
        return None
    text = value.strip()
    if not text:
        if strict:
            raise TriggerError(f"{field} must not be empty")
        return None
    if len(text) > MATTER_AGENT_MODEL_MAX_CHARS:
        if strict:
            raise TriggerError(
                f"{field} exceeds {MATTER_AGENT_MODEL_MAX_CHARS} characters"
            )
        return None
    return text


def _coerce_agent_overrides(raw: Any, *, strict: bool) -> dict[str, Any] | None:
    """`{model?, effort?, fallback_models?}` → 归一化后的 dict（全空 → None）。

    `strict=True` 是写侧（值域外抛 `TriggerError`）；`strict=False` 是读侧（认不出的字段
    整个丢掉，剩下的照用）。
    """
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        if strict:
            raise TriggerError("agent overrides must be an object")
        return None

    result: dict[str, Any] = {}

    if raw.get("model") is not None:
        model = _model_ref(raw.get("model"), field="agent.model", strict=strict)
        if model is not None:
            result["model"] = model

    if raw.get("effort") is not None:
        effort = raw.get("effort")
        if isinstance(effort, str) and effort.strip() in MATTER_AGENT_EFFORT_TIERS:
            result["effort"] = effort.strip()
        elif strict:
            raise TriggerError(f"unsupported agent.effort: {effort!r}")

    # 🔴 `[]` 必须能表达（= 显式不设兜底），所以判的是"键在不在"而不是"值真不真"。
    if "fallback_models" in raw and raw.get("fallback_models") is not None:
        models = raw.get("fallback_models")
        if not isinstance(models, (list, tuple)):
            if strict:
                raise TriggerError("agent.fallback_models must be a list")
        else:
            if strict and len(models) > MATTER_AGENT_MAX_FALLBACK_MODELS:
                raise TriggerError(
                    f"at most {MATTER_AGENT_MAX_FALLBACK_MODELS} fallback models are allowed"
                )
            picked: list[str] = []
            for value in models[:MATTER_AGENT_MAX_FALLBACK_MODELS]:
                ref = _model_ref(value, field="agent.fallback_models[]", strict=strict)
                if ref is not None and ref not in picked:
                    picked.append(ref)
            result["fallback_models"] = picked

    return result or None


def normalize_agent_overrides(raw: Any) -> dict[str, Any] | None:
    """写侧归一化（值域外抛 `TriggerError` → 调用侧转 `E_INVALID_ARG`）。"""
    return _coerce_agent_overrides(raw, strict=True)


def coerce_agent_overrides(raw: Any) -> dict[str, Any]:
    """读侧宽容归一，输入是**裸的** `{model?, effort?, fallback_models?}` 块。

    与 `parse_agent_overrides` 同一条纪律（认不出的字段丢掉、剩下的照用），区别只在输入
    形状：那个吃的是整个 `schedule_json` envelope，这个吃的是块本身 —— 全局默认存在
    `owner_settings` 里，没有 envelope 可言，但值域必须与事项级**逐字同一份**
    （`agent_defaults.py` 是唯一调用方）。
    """
    return _coerce_agent_overrides(raw, strict=False) or {}


def parse_agent_overrides(raw: Any) -> dict[str, Any]:
    """从 `schedule_json` 的内容里取模型覆盖。无该键 / v1 行 / 形状不对 → `{}`（= 全跟随）。"""
    envelope = _envelope_mapping(raw)
    if envelope is None or "agent" not in envelope:
        return {}
    return _coerce_agent_overrides(envelope.get("agent"), strict=False) or {}


def _envelope_mapping(raw: Any) -> Mapping[str, Any] | None:
    """DB 列字符串 / 已解析对象 → Mapping；解析不了返回 None（读侧不抛）。"""
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return None
    return raw if isinstance(raw, Mapping) else None


@dataclass(frozen=True)
class TriggerEntry:
    id: str
    kind: str
    enabled: bool
    #: schedule 专属。`rule` 是 `ScheduleRule` 的 JSON 形状（dict），深校验由
    #: `src/agents/schedule_rule.parse_rule` 负责 —— 本模块只管结构，不复制它的值域。
    rule: Mapping[str, Any] | None = None
    anchor: str | None = None
    timezone: str | None = None
    #: event 专属
    event_type: str | None = None
    #: condition 专属
    condition: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"id": self.id, "kind": self.kind, "enabled": self.enabled}
        if self.kind == MatterRunTrigger.SCHEDULE:
            payload.update(rule=self.rule, anchor=self.anchor, timezone=self.timezone)
        elif self.kind == MatterRunTrigger.EVENT:
            payload["event_type"] = self.event_type
        elif self.kind == MatterRunTrigger.CONDITION:
            payload["condition"] = self.condition
        return payload


def local_timezone_name() -> str:
    """本机 IANA 时区名。读法与 `sync_store._local_tz` 同源（macOS `/etc/localtime` 软链）。

    拿不到就回 ``UTC`` —— 排程宁可跑在 UTC 也不要因为时区解析失败而整条配不出来。
    """
    try:
        import os
        import re

        match = re.search(r"zoneinfo/(.+)$", os.readlink("/etc/localtime"))
        if match:
            return match.group(1)
    except Exception:  # noqa: BLE001 — 非 macOS / 无软链 / 权限问题都回落 UTC
        pass
    return "UTC"


def default_schedule_entry(*, anchor: str, timezone_name: str | None = None) -> dict[str, Any]:
    """新建事项的默认跟进排程：**每 3 天 · 09:00**（D2 方案 A）。

    出处是设计 `AgentConfigModal` 的初始 state（days=3 / time='09:00'），**不是**绑定卡
    那句「每工作日 09:00」的推荐 —— 后者一周跑 5 次，对每个新建事项都这样开销过重。

    🔴 只给**新建**事项用。存量事项不回填（迁移里有测试钉死）。
    """
    return {
        "kind": str(MatterRunTrigger.SCHEDULE),
        "enabled": True,
        "rule": {
            "freq": "daily",
            "interval": 3,
            "weekdays": [1],
            "monthMode": "date",
            "monthDay": 1,
            "ordinal": 1,
            "weekday": 1,
            "hour": 9,
            "minute": 0,
            "clamp": False,
        },
        "anchor": anchor,
        "timezone": timezone_name or local_timezone_name(),
    }


def _stable_id(seed: str) -> str:
    """确定性短 id。

    🔴 v1 单对象 up-convert 出来的那条**必须**每次读都得到同一个 id，否则 per-trigger
    marker 键会随读取漂移，等于每次 tick 都认为「从没 fire 过」。
    """
    return "mtr_" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:10]


def _require_str(entry: Mapping[str, Any], key: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise TriggerError(f"trigger {key} is required")
    return value.strip()


def _normalize_entry(raw: Any, *, index: int, fallback_seed: str) -> TriggerEntry:
    if not isinstance(raw, Mapping):
        raise TriggerError("trigger entry must be an object")
    kind = str(raw.get("kind") or "").strip()
    if kind not in set(MatterRunTrigger):
        raise TriggerError(f"unknown trigger kind: {kind!r}")

    entry_id = raw.get("id")
    if isinstance(entry_id, str) and entry_id.strip():
        entry_id = entry_id.strip()
    else:
        entry_id = _stable_id(f"{fallback_seed}:{index}:{kind}")

    enabled = bool(raw.get("enabled", True))

    if kind == MatterRunTrigger.SCHEDULE:
        rule = raw.get("rule")
        if not isinstance(rule, Mapping):
            raise TriggerError("trigger rule must be an object")
        return TriggerEntry(
            id=entry_id, kind=kind, enabled=enabled,
            rule=dict(rule),
            anchor=_require_str(raw, "anchor"),
            timezone=_require_str(raw, "timezone"),
        )
    if kind == MatterRunTrigger.EVENT:
        event_type = _require_str(raw, "event_type")
        if event_type not in EVENT_TRIGGER_CRITERIA:
            raise TriggerError(f"unsupported event_type: {event_type!r}")
        return TriggerEntry(id=entry_id, kind=kind, enabled=enabled, event_type=event_type)
    if kind == MatterRunTrigger.CONDITION:
        condition = _require_str(raw, "condition")
        if condition not in CONDITION_TRIGGER_KINDS:
            raise TriggerError(f"unsupported condition: {condition!r}")
        return TriggerEntry(id=entry_id, kind=kind, enabled=enabled, condition=condition)
    return TriggerEntry(id=entry_id, kind=kind, enabled=enabled)


def parse_trigger_set(raw: Any, *, seed: str = "") -> tuple[TriggerEntry, ...]:
    """把 `schedule_json` 的内容解析成 entry 序列。

    接受三种输入：v2 envelope / v1 单对象（惰性映射，**不改写库**）/ None。
    非法内容一律抛 `TriggerError` —— 静默丢弃会让用户以为排程还在，但它再也不跑了。
    """
    if raw is None or raw == "":
        return ()
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise TriggerError(f"schedule_json is not valid JSON: {exc}") from exc

    if isinstance(raw, Mapping) and "triggers" in raw:
        entries = raw.get("triggers")
        if not isinstance(entries, list):
            raise TriggerError("triggers must be a list")
    elif isinstance(raw, Mapping):
        # v1 单对象：一条 sole trigger。seed 用调用方给的稳定值（matter id），
        # 让 up-convert 出来的 id 跨进程、跨重启都一致。
        entries = [raw]
    elif isinstance(raw, list):
        entries = raw
    else:
        raise TriggerError("schedule_json must be an object or a list")

    if len(entries) > MAX_TRIGGERS:
        raise TriggerError(f"at most {MAX_TRIGGERS} triggers are allowed")

    parsed: list[TriggerEntry] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(entries):
        entry = _normalize_entry(item, index=index, fallback_seed=seed)
        if entry.id in seen_ids:
            raise TriggerError(f"duplicate trigger id: {entry.id}")
        seen_ids.add(entry.id)
        parsed.append(entry)
    return tuple(parsed)


def dump_trigger_set(
    entries: Iterable[TriggerEntry],
    *,
    actions: Iterable[str] | None = None,
    agent: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "v": TRIGGER_ENVELOPE_VERSION,
        "triggers": [entry.to_dict() for entry in entries],
    }
    # 与默认相同就不写这个键 —— 让"没配过"和"配成默认值"在库里长得一样，将来改默认能跟着走
    # （同 matter_agent 文档"空 = 跟随默认"的纪律）。
    normalized = normalize_run_actions(list(actions) if actions is not None else None)
    if normalized != DEFAULT_RUN_ACTIONS:
        envelope["actions"] = list(normalized)
    # 模型覆盖同一条纪律：一项都没覆盖就不写这个键（= 全跟随）。
    if agent:
        envelope["agent"] = dict(agent)
    return envelope


def normalize_trigger_json(raw: Any, *, seed: str = "") -> dict[str, Any] | None:
    """写侧归一化：任何合法输入 → v2 envelope。空集合返回 None（列写 NULL）。

    🔴 「跟进时执行」跟着 envelope 一起过一遍，否则前端刚存的勾选会在下一次保存排程时
    被静默丢掉（旧实现只保留 triggers）。

    🔴 「一条 trigger 都没有」不再无条件折成 NULL —— 只有**模型覆盖也是空的**才折。否则
    把触发方式全删掉（改成纯手动跟进）会把刚配好的模型/effort/fallback 一起抹掉，而 UI 上
    看不出任何异常：那正是"保存了但不生效"这类最难查的 bug。
    """
    entries = parse_trigger_set(raw, seed=seed)
    agent = normalize_agent_overrides((_envelope_mapping(raw) or {}).get("agent"))
    if not entries and not agent:
        return None
    return dump_trigger_set(entries, actions=parse_run_actions(raw), agent=agent)


def is_legacy_shape(raw: Any) -> bool:
    """判断库里存的是不是 v1 单对象。

    🔴 marker 键的兼容全靠它：v1 行继续用旧键 `matter.schedule.last_fire.{id}`，
    换键会让升级瞬间「从没 fire 过」而立刻补跑一次。
    """
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return False
    return isinstance(raw, Mapping) and "triggers" not in raw and "kind" in raw


def marker_key(matter_id: int, entry: TriggerEntry, *, legacy: bool) -> str:
    """per-trigger 的 last-fire marker 键（D16）。

    两条 trigger 不得互吞 marker —— 共用一个键时，先 fire 的那条会把 marker 推到未来，
    另一条永远被判成「已经跑过了」。
    """
    if legacy:
        return f"matter.schedule.last_fire.{matter_id}"
    return f"matter.trigger.last_fire.{matter_id}.{entry.id}"


def idempotency_key(matter_id: int, entry: TriggerEntry, occurrence: str, *, legacy: bool) -> str:
    """入队幂等键。v1 行沿用旧形状，避免升级瞬间产生一个"新"键而重复入队。"""
    if legacy and entry.kind == MatterRunTrigger.SCHEDULE:
        return f"matter_followup:{matter_id}:schedule:{occurrence}"
    return f"matter_followup:{matter_id}:{entry.id}:{occurrence}"
