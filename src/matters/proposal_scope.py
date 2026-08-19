"""提案失效判据的目标集推导（"证据变了" 而不是 "版本号变了"）。

背景：`matter_update` 的 stale 判定原本是「matter.version 前进 ⇒ 所有 pending 提案作废」。
这是对规格意图的钝化代理 —— 规格要的是**证据变了**（contracts §2.10「stale proposal 不允许
静默应用」/ HANDOFF「冲突的旧值不能静默套用」），而 version 会被任何一次无关写入推前：
owner 在评审自己的提案期间点了 12 次「接受资料建议」+ 4 次改标签，就把正等着自己审的提案
作废了。

本模块把两侧都归一成一个 `MatterWriteScope`（matter 字段名 / item id / resource id 三元组），
只有**有交集**时才判定失效。

🔴 fail-closed 是硬要求：任何一侧只要有一个环节推导不出可靠目标（JSON 非法、结构不认识、
payload 形状意外），就退化成 `wildcard=True`（与任何东西都算重叠）。宁可多作废一次让用户
重跑，也绝不能放过一次真冲突让提案里的旧值静默覆盖用户刚写的新值。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

# 提案能触及的 matter 字段（canonical 名）。
# 除 `current_summary` 外 = `run_service.PROPOSAL_FIELD_WHITELIST`（kind='field' 的
# target.field 值域）；
# `current_summary` 不在那张白名单里但同样会被 accept 写（accept 把提案 summary 或
# 调用方传来的 `edited_summary` 落成 matter.current_summary），所以它也是一个真实的冲突面。
PROPOSAL_TOUCHABLE_FIELDS = frozenset(
    {
        "status",
        "health",
        "priority",
        "due_at",
        "waiting_context",
        "current_summary",
        # S3（08-18）：背景与目标、完成标志进了提案面；v61（08-19）前者拆两项。
        # 🔴 它们**必须**在这里出现 —— 少一个就等于「owner 手改了背景（或目标），而
        # Agent 那份带旧文案的提案不算 stale」，accept 时静默覆盖 owner 刚写的新值。
        # 这正是本文件头说的那种「放过一次真冲突」。
        "background",
        "goal",
        "goal_checks",
    }
)

# matter 表列名 → 提案侧 canonical 字段名。未列出的列取自身名字；两侧归一后不在
# PROPOSAL_TOUCHABLE_FIELDS 里的（title/tags_json/archived_at/updated_at…）一律不进
# 目标集 —— 提案结构上碰不到它们，碰不到就不可能冲突。
#: 🔴 凡是「列名 ≠ canonical 字段名」的可提案字段都必须在这里映射，否则
#: `scope_from_matter_columns` 推不出目标 ⇒ owner 手改了它、提案却不算 stale ⇒
#: accept 时静默覆盖 owner 刚写的值。`background` / `goal` 两侧同名，不需要条目。
_COLUMN_TO_FIELD = {
    "waiting_context_json": "waiting_context",
    "goal_checks_json": "goal_checks",
}


@dataclass(frozen=True)
class MatterWriteScope:
    """一次写入（或一份提案）触及的对象集合。

    `stakeholder_ids` / `relation_ids`（0813 A2）：提案结构上碰不到干系人/关系（change kind
    只有 fact/inference/field/action/resource），所以这两个集合对**提案失效**永远不产生重叠 ——
    它们存在是为了版本账本（`service._cas_update` 落的 gap scan 判据）：并发的两笔干系人写
    只在打到**同一行**时才算真冲突。
    """

    fields: frozenset[str] = frozenset()
    item_ids: frozenset[int] = frozenset()
    resource_ids: frozenset[int] = frozenset()
    stakeholder_ids: frozenset[int] = frozenset()
    relation_ids: frozenset[int] = frozenset()
    #: 推导不出可靠目标 / 语义上触及整个聚合 → 与任何提案都算重叠（fail-closed）。
    wildcard: bool = False

    def overlaps(self, other: "MatterWriteScope") -> bool:
        if self.wildcard or other.wildcard:
            return True
        return bool(
            self.fields & other.fields
            or self.item_ids & other.item_ids
            or self.resource_ids & other.resource_ids
            or self.stakeholder_ids & other.stakeholder_ids
            or self.relation_ids & other.relation_ids
        )


#: 什么都没触及（拒绝提案、改标签、增删干系人/关系…）——不作废任何提案。
SCOPE_NOTHING = MatterWriteScope()
#: 触及一切 —— 判据不明或整聚合级变更（归档/回收站/永久删除）时的保守值。
SCOPE_EVERYTHING = MatterWriteScope(wildcard=True)


def scope_from_matter_columns(changes: Mapping[str, Any]) -> MatterWriteScope:
    """从 `cas_update_matter` 的列改动推导写入侧目标集。

    只保留提案结构上碰得到的字段；`updated_at`/`last_activity_at`/`version` 这类记账列，
    以及 `title`/`tags_json` 这类提案永远改不了的列，都不进目标集。
    """
    fields = {
        _COLUMN_TO_FIELD.get(column, column)
        for column in changes
        if _COLUMN_TO_FIELD.get(column, column) in PROPOSAL_TOUCHABLE_FIELDS
    }
    return MatterWriteScope(fields=frozenset(fields))


def scope_from_items(item_ids: Any) -> MatterWriteScope:
    """从被改动的 item id 集合推导。非 int 元素 → fail closed。"""
    return _scope_from_ids(item_ids, "item_ids")


def scope_from_resources(resource_ids: Any) -> MatterWriteScope:
    """从被改动的 resource id 集合推导。非 int 元素 → fail closed。"""
    return _scope_from_ids(resource_ids, "resource_ids")


def scope_from_stakeholders(stakeholder_ids: Any) -> MatterWriteScope:
    """从被改动的干系人 id 集合推导。非 int 元素 → fail closed。"""
    return _scope_from_ids(stakeholder_ids, "stakeholder_ids")


def scope_from_relations(relation_ids: Any) -> MatterWriteScope:
    """从被改动的关系 id 集合推导。非 int 元素 → fail closed。"""
    return _scope_from_ids(relation_ids, "relation_ids")


def _scope_from_ids(values: Any, field: str) -> MatterWriteScope:
    ids: set[int] = set()
    for value in values or ():
        if isinstance(value, bool) or not isinstance(value, int):
            return SCOPE_EVERYTHING  # fail closed：拿不到确定的目标 id
        ids.add(int(value))
    return MatterWriteScope(**{field: frozenset(ids)})


#: 版本账本（sync_state `matter_version_scopes:*`）里 scope 的 JSON 键。顺序即序列化顺序。
_SCOPE_ID_FIELDS = ("item_ids", "resource_ids", "stakeholder_ids", "relation_ids")


def scope_to_payload(scope: MatterWriteScope) -> dict[str, Any]:
    """MatterWriteScope → 账本 JSON。wildcard 时不落集合（读侧也不会看）。"""
    if scope.wildcard:
        return {"wildcard": True}
    payload: dict[str, Any] = {"fields": sorted(scope.fields)}
    for field in _SCOPE_ID_FIELDS:
        payload[field] = sorted(getattr(scope, field))
    return payload


def scope_from_payload(value: Any) -> MatterWriteScope:
    """账本 JSON → MatterWriteScope。任何形状不对 → fail closed 触及一切。"""
    if not isinstance(value, Mapping):
        return SCOPE_EVERYTHING
    if value.get("wildcard"):
        return SCOPE_EVERYTHING
    fields = value.get("fields")
    if not isinstance(fields, list) or any(not isinstance(f, str) for f in fields):
        return SCOPE_EVERYTHING
    id_sets: dict[str, frozenset[int]] = {}
    for field in _SCOPE_ID_FIELDS:
        raw = value.get(field)
        if raw is None:
            raw = []
        if not isinstance(raw, list) or any(
            isinstance(v, bool) or not isinstance(v, int) for v in raw
        ):
            return SCOPE_EVERYTHING
        id_sets[field] = frozenset(raw)
    return MatterWriteScope(fields=frozenset(fields), **id_sets)


def proposal_scope(
    changes_json: Any,
    *,
    resolve_new_resource: Optional[
        Callable[[Mapping[str, Any]], Optional[int]]
    ] = None,
) -> MatterWriteScope:
    """从 `matter_update.changes_json` 推导这份提案**接受时会写到哪些对象**。

    与 `MatterService._apply_accepted_change` 的分支一一对应：
    - `fact` / `inference`：只留档，不落结构化状态 → 不触及任何对象。
    - `field`：写 matter 的一个字段列。
    - `action` 且 `target=None`：新建 item（纯追加，不可能与既有对象冲突）→ 不触及。
    - `action` 且 `target={"id": <int>}`：改那一条 item。
    - `resource` 且带 `target.id`：确认那一条 resource link。
    - `resource` 且带 `resource`（新建关联）：由 `resolve_new_resource` 回答「本事项**已经**
      有过这份资料的 link 吗」—— 有（含 owner 解除过的 soft-deleted 行）就把那个
      `resource_id` 纳入目标集，没有才是纯追加。见下方 🔴。
    - 其余（含未知 kind / 形状意外 / JSON 不是数组）→ fail closed 触及一切。

    🔴 `resource` 的新建形态**不是**无条件的纯追加：`_apply_new_resource_link` 对
    soft-deleted 的 link 走的是「复活那一行 + 标 confirmed」。所以「Agent 提案里含资源 X →
    owner 评审期间解除 X 的关联 / 忽略这条建议 → 接受旧提案」会把 owner 刚做的明确决定
    静默翻回来（`expected_version` 只保护「请求发出之后」的并发，补不了错误的目标集）。
    `resolve_new_resource(spec) -> resource_id | None` 就是那一问：返回 id = 有既有对象
    ⇒ 进目标集；返回 None = 真·全新 ⇒ 纯追加（**不**退回 wildcard —— 那正是本模块要
    收窄掉的钝化代理）；**没给回调 / 回调抛异常 / 返回值不是 int** ⇒ fail closed 触及一切
    （身份推导不出来时不许猜"它是全新的"）。

    🔴 `current_summary` **恒在**目标集里，与提案自己有没有 summary 无关：判据必须按
    「accept **能**写到哪」推，不能按「提案自己写了什么」推。accept 接口允许**任意**提案
    携带 `edited_summary`（contracts §3.8 accept 载荷；UI 的摘要编辑框对无摘要提案照样
    可写），service 会把它落成 `matter.current_summary`。按提案内容推会漏掉这条**调用方
    带进来的**写入面：无 summary 的提案不会被「用户刚改了摘要」标 stale，接受时却能带
    `edited_summary` 把刚写的摘要静默覆盖 —— 正是 contracts「stale proposal 不允许静默
    应用」要防的事。
    """
    fields: set[str] = {"current_summary"}
    item_ids: set[int] = set()
    resource_ids: set[int] = set()

    if isinstance(changes_json, (str, bytes, bytearray)):
        try:
            parsed: Any = json.loads(changes_json)
        except (ValueError, TypeError):
            return SCOPE_EVERYTHING  # fail closed：JSON 非法
    else:
        parsed = changes_json
    if parsed is None:
        parsed = []
    if not isinstance(parsed, list):
        return SCOPE_EVERYTHING  # fail closed：changes 不是数组

    for change in parsed:
        if not isinstance(change, Mapping):
            return SCOPE_EVERYTHING  # fail closed：条目不是对象
        kind = change.get("kind")
        if kind in ("fact", "inference"):
            continue
        if kind == "field":
            target = change.get("target")
            field = target.get("field") if isinstance(target, Mapping) else None
            if not isinstance(field, str) or field not in PROPOSAL_TOUCHABLE_FIELDS:
                return SCOPE_EVERYTHING  # fail closed：认不出这个字段
            fields.add(field)
            continue
        if kind == "action":
            target = change.get("target")
            if target is None:
                continue  # 新建 item：纯追加，没有可冲突的既有对象
            item_id = target.get("id") if isinstance(target, Mapping) else None
            if isinstance(item_id, bool) or not isinstance(item_id, int):
                return SCOPE_EVERYTHING  # fail closed：拿不到目标 item
            item_ids.add(int(item_id))
            continue
        if kind == "resource":
            spec = change.get("resource")
            if isinstance(spec, Mapping):
                # 新建一条资料关联。落这里不判 target.id：新形状本来就没有 id，按老分支走会
                # fail-closed 成 wildcard，让任何一次无关写入都把带新资料的提案作废。但它也
                # **不是**无条件纯追加 —— accept 会复活 owner 解除过的那一行，所以先问身份。
                if resolve_new_resource is None:
                    return SCOPE_EVERYTHING  # fail closed：没有解析器就断不出是不是全新
                try:
                    existing_id = resolve_new_resource(spec)
                except Exception:  # noqa: BLE001 — 身份推导失败一律 fail closed
                    return SCOPE_EVERYTHING
                if existing_id is None:
                    continue  # 真·全新资料：本事项从没关联过，纯追加
                if isinstance(existing_id, bool) or not isinstance(existing_id, int):
                    return SCOPE_EVERYTHING  # fail closed：回调给了个认不出的东西
                resource_ids.add(int(existing_id))
                continue
            target = change.get("target")
            resource_id = target.get("id") if isinstance(target, Mapping) else None
            if isinstance(resource_id, bool) or not isinstance(resource_id, int):
                return SCOPE_EVERYTHING  # fail closed：拿不到目标 resource
            resource_ids.add(int(resource_id))
            continue
        return SCOPE_EVERYTHING  # fail closed：未知 kind

    return MatterWriteScope(
        fields=frozenset(fields),
        item_ids=frozenset(item_ids),
        resource_ids=frozenset(resource_ids),
    )
