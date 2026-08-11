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


class TriggerError(ValueError):
    """trigger 配置非法。调用侧转成 `E_INVALID_ARG`。"""


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


def dump_trigger_set(entries: Iterable[TriggerEntry]) -> dict[str, Any]:
    return {
        "v": TRIGGER_ENVELOPE_VERSION,
        "triggers": [entry.to_dict() for entry in entries],
    }


def normalize_trigger_json(raw: Any, *, seed: str = "") -> dict[str, Any] | None:
    """写侧归一化：任何合法输入 → v2 envelope。空集合返回 None（列写 NULL）。"""
    entries = parse_trigger_set(raw, seed=seed)
    if not entries:
        return None
    return dump_trigger_set(entries)


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
