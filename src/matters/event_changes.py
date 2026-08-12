"""Matter 时间线事件的「值级」变更投影。

时间线要从审计日志（"改动字段：状态、优先级"）变成能写出句子的跟进历史
（"状态 进行中 → 等待中"），前提是事件 payload 里**有值**。本模块就是那层投影：
把一次写入的 before/after 压成一个有界的 ``changes`` 数组。

契约（前端叙述层按这个消费）::

    {
      "fields": ["status", "priority"],           # 保留：本次 patch 触及的字段名
      "changes": [                                 # 新增：真正变了的字段的值级前后像
        {"field": "status",   "from": "active", "to": "waiting"},
        {"field": "priority", "from": "p2",     "to": "p0"}
      ]
    }

五条纪律：

1. **存原始值** —— 枚举存枚举字面量、时间戳存数字、bool 存 bool。本地化文案是前端
   i18n 的事；后端塞中文会同时污染 en-US 与 API 契约。
2. **有界** —— 长文本截断到 :data:`CHANGE_TEXT_MAX_CHARS`，列表截到
   :data:`CHANGE_LIST_MAX_ITEMS`。事件表不是正文存储，把整段摘要塞进去只会让它膨胀。
   🔴 截断标记**分两侧**：``from_truncated`` / ``to_truncated`` 各自只在那一侧真被截断
   时出现。合成一个 ``truncated`` 布尔会让前端说谎 —— 它只能靠「哪侧长度等于两侧最大
   值」反推是谁被截了，而旧值恰好 120 字、新值 121 字被截成 120 字时两侧一样长，于是
   两边都被加上省略号，谎称旧值也被截断。🔴 截断限额**有意不跨语言镜像**：前端读的是
   这两个布尔，不重新推导限额，所以这里不需要一致性闸。
3. **``from`` 键在 / 不在语义不同** —— 键在且值为 ``null`` = 之前确实是空；键**不在**
   = 前像不可知（新建对象 / 调用方没给前像）。两者不许合并。
4. **append-only 不回填** —— 只改新写入的形状。历史行没有 ``changes`` 键，前端降级到
   字段名渲染，这是有意的（``prd.md``：时间线 append-only，纠错用反向事件）。
   同理，写于分侧标记之前的老行带的是单个 ``truncated`` 键：**不回填**，前端按
   「有 ``truncated`` 键 = 老行」走它自己的降级路径。
5. **投影层永远不许把一次业务写入弄失败** —— 叙述不出来的值（dict、NaN/Infinity）一律
   跳过，字段名仍留在 ``fields`` 里。见 :func:`_narratable`。
"""

from __future__ import annotations

import math
from collections.abc import Collection, Iterable, Mapping
from typing import Any

CHANGE_TEXT_MAX_CHARS = 120
CHANGE_LIST_MAX_ITEMS = 20

# matter 的 17 个可 patch 字段里，能写出一句自然语言的那些。
# 排除的三个见 MATTER_STRUCTURED_FIELDS —— 它们的"前后值"是一坨 JSON，写不出句子，
# 塞进事件表只会让 payload 膨胀；它们仍然出现在 `fields` 里，前端照旧渲染字段名。
MATTER_STRUCTURED_FIELDS = frozenset(
    {"goal_checks", "waiting_context", "schedule_json"}
)
MATTER_CHANGE_FIELDS = frozenset(
    {
        "title",
        "description",
        "current_summary",
        "status",
        "health",
        "priority",
        "matter_type",
        "tags",
        "due_at",
        "next_attention_at",
        "attention_reason",
        "agent_profile_id",
        "agent_enabled",
        "matter_instructions",
    }
)

# item：`checklist`（结构化）/ `position`（渲染顺序）/ `deleted_at`（事件 kind 已经说了）
# / `source_*`（内部指针）/ `waiting_on_stakeholder_id`（裸 id，没名字写不出句子）不进。
ITEM_CHANGE_FIELDS = frozenset(
    {"title", "description", "kind", "status", "priority", "due_at", "completed_at"}
)

# stakeholder：email 有意不进 —— 它是 PII，事件表不需要再存一份才能写出句子。
STAKEHOLDER_CHANGE_FIELDS = frozenset(
    {"display_name", "organization", "role", "relationship", "is_waiting_on"}
)

_MISSING = object()


def truncated_text(value: Any) -> str | None:
    """事件 payload 里的「标识」字段（item 标题 / 资料名 / 干系人名）统一截断。

    ``None`` 原样透传 —— "没有标题"和"标题是空串"在渲染时是两种句子。
    """
    if value is None:
        return None
    text = str(value)
    return text[:CHANGE_TEXT_MAX_CHARS]


def _scalar_narratable(value: Any) -> bool:
    # 🔴 NaN / Infinity / -Infinity 不算可叙述：``json.dumps`` 默认会把它们输出成
    # **非标准** JSON 字面量（``NaN`` / ``Infinity``），SQLite 的
    # ``CHECK (json_valid(payload_json))`` 当场拒收 —— 而此时业务更新已经写完，只有
    # 事件那一句失败 ⇒ **整笔事务回滚**，对外表现成 500 而不是参数错误。契约 = 跳过
    # 这条 change（字段名仍在 ``fields`` 里），投影层不许把一次合法写入弄失败。
    if isinstance(value, float) and not math.isfinite(value):
        return False
    return value is None or isinstance(value, (str, bool, int, float))


def _narratable(value: Any) -> bool:
    if isinstance(value, (list, tuple)):
        return all(_scalar_narratable(element) for element in value)
    return _scalar_narratable(value)


def _project(value: Any) -> tuple[Any, bool]:
    """→ ``(投影后的值, 是否被截断)``。"""
    if isinstance(value, str):
        if len(value) > CHANGE_TEXT_MAX_CHARS:
            return value[:CHANGE_TEXT_MAX_CHARS], True
        return value, False
    if isinstance(value, (list, tuple)):
        truncated = len(value) > CHANGE_LIST_MAX_ITEMS
        projected: list[Any] = []
        for element in list(value)[:CHANGE_LIST_MAX_ITEMS]:
            element_value, element_truncated = _project(element)
            truncated = truncated or element_truncated
            projected.append(element_value)
        return projected, truncated
    return value, False


def build_changes(
    fields: Iterable[str],
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
    *,
    allowed: Collection[str],
) -> list[dict[str, Any]]:
    """把 ``fields`` 里能叙述的那些压成 ``changes`` 数组。

    - ``after`` 里没有这个字段 ⇒ 跳过（写不出 "→ 什么"）。
    - 前后**原始值**相等 ⇒ 跳过。"状态 进行中 → 进行中"正是 owner 说的 audit-log 噪音；
      比较用截断**前**的原始值，否则两段只有前 120 字不同的长文本会被误判成没变。
    - 值的形状不可叙述（dict / NaN / Infinity 之类）⇒ 跳过，字段名仍留在 ``fields`` 里。
    - 截断标记分两侧：``from_truncated`` / ``to_truncated``，各自只在那一侧真被截断时
      出现（纪律 2）。两侧都没被截 ⇒ 两个键都不在。
    """
    changes: list[dict[str, Any]] = []
    for field in sorted(dict.fromkeys(fields)):
        if field not in allowed:
            continue
        raw_before = _MISSING if before is None else before.get(field, _MISSING)
        raw_after = _MISSING if after is None else after.get(field, _MISSING)
        if raw_after is _MISSING:
            continue
        if raw_before is not _MISSING and raw_before == raw_after:
            continue
        if not _narratable(raw_after):
            continue
        if raw_before is not _MISSING and not _narratable(raw_before):
            continue
        entry: dict[str, Any] = {"field": field}
        if raw_before is not _MISSING:
            entry["from"], before_truncated = _project(raw_before)
            if before_truncated:
                entry["from_truncated"] = True
        entry["to"], after_truncated = _project(raw_after)
        if after_truncated:
            entry["to_truncated"] = True
        changes.append(entry)
    return changes
