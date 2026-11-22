"""Shared constants, Actor value object, and pure helpers for MatterService modules."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from .models import MatterActorKind

TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
ACTION_ONLY_ITEM_FIELDS = {
    "status",
    "priority",
    "owner_kind",
    "owner_id",
    "waiting_on_stakeholder_id",
    "due_at",
    "completed_at",
    "checklist",
    # 执行档只对行动项有意义（只有它派得出去）。🔴 这条约束**在这里判**而不是进表级
    # CHECK：那条 CHECK 改不动（SQLite 要重建整张表），列名单只能保持原样。
    "exec_profile",
}
MANUAL_UPDATE_FIELDS = {"status", "health", "current_summary"}

def proposal_change_count(changes: Sequence[Any] | None, summary: str | None) -> int:
    """提案「几项变化」的唯一口径：逐项变化条数 + 摘要算一项。

    摘要是「当前状态」的新版本，接受时恒写进 ``current_summary``，所以只改了当前状态的提案
    也是一项真实更新 —— 只数 ``changes`` 会把它显示成「0 项变化」，看上去像空提案。
    """
    return len(changes or []) + (1 if summary and summary.strip() else 0)

# P4 绑定三键（D2）：走既有 PATCH 白名单 + 事件 agent_binding_changed；
# schedule_json P5 才有写面（本相位零消费，不进白名单）。
BINDING_PATCH_FIELDS = {
    "agent_profile_id", "agent_enabled", "matter_instructions", "schedule_json",
}
MATTER_INSTRUCTIONS_MAX_CHARS = 4000
DIRECT_PATCH_FIELDS = {
    "title",
    # v61：背景与目标是**两个独立字段**（列同名）。合存单字段靠 `## 背景` / `## 目标`
    # 小标题分段的老方案已推翻 —— 解析的异常面（读态 / 编辑态 / 保存 / 导出 / Agent 写
    # 五处得同意同一套正则）比多一列贵。
    "background",
    "goal",
    "matter_type",
    "priority",
    "tags",
    "goal_checks",
    "due_at",
    "waiting_context",
    "next_attention_at",
    "attention_reason",
}
# 「撤销事项更新」的前像要快照哪些字段（patch_matter 的 undo descriptor）。
# 🔴 **从写面派生，不再手抄**：这里曾是同一份白名单的第四份手抄，且漏了 priority 与
# goal_checks —— 于是只改优先级时前像是 `{}`，撤销发出一个空 patch：不报错、版本照 bump、
# 值一动不动，用户看到的是「撤销成功」而实际什么都没还原。前像的每个字段都会经
# `PATCH /api/matters/{id}` 原样回放（renderer 直连 REST、user actor），所以取值范围必须
# 恰好是写面本身。
# BINDING_PATCH_FIELDS **有意**不在内（维持现状，本批不扩面）：纯 binding 的 patch 只写
# agent_binding_changed 一条事件，不产生 matter_updated，「撤销事项更新」这颗按钮不代表它；
# 混合 patch 里的 binding 部分同样不进前像。要不要让撤销覆盖 agent 绑定是独立决策。
UNDOABLE_PATCH_FIELDS = DIRECT_PATCH_FIELDS | MANUAL_UPDATE_FIELDS

@dataclass(frozen=True)
class Actor:
    kind: str = MatterActorKind.USER.value
    actor_id: str | None = None
