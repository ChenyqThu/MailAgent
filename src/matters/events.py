"""Canonical Matter event-kind registry.

P3 establishes the registry without mechanically replacing the existing literals in
``service.py``/``new_watcher.py``. P7 will finish that cleanup; all new code must import constants
from this module meanwhile.
"""

MATTER_CREATED = "matter_created"
MATTER_UPDATED = "matter_updated"
MATTER_ARCHIVED = "matter_archived"
MATTER_REOPENED = "matter_reopened"
MATTER_TRASHED = "matter_trashed"
MATTER_RESTORED = "matter_restored"
ITEM_CREATED = "item_created"
ITEM_UPDATED = "item_updated"
ITEM_DELETED = "item_deleted"
ITEM_RESTORED = "item_restored"
RESOURCE_LINKED = "resource_linked"
RESOURCE_UPDATED = "resource_updated"
RESOURCE_UNLINKED = "resource_unlinked"
RESOURCE_RESTORED = "resource_restored"
RESOURCE_SUGGESTION_ACCEPTED = "resource_suggestion_accepted"
RESOURCE_SUGGESTION_REJECTED = "resource_suggestion_rejected"
RESOURCE_ACCESS_POLICY_CHANGED = "resource_access_policy_changed"
RESOURCE_SUBSCRIPTION_PAUSED = "resource_subscription_paused"
RESOURCE_SUBSCRIPTION_RESUMED = "resource_subscription_resumed"
STAKEHOLDER_ADDED = "stakeholder_added"
STAKEHOLDER_UPDATED = "stakeholder_updated"
STAKEHOLDER_REMOVED = "stakeholder_removed"
STAKEHOLDER_RESTORED = "stakeholder_restored"
RELATION_ADDED = "relation_added"
RELATION_UPDATED = "relation_updated"
RELATION_REMOVED = "relation_removed"
RELATION_RESTORED = "relation_restored"
# 🔴 产出路径已退役（0812 dogfood：事项对话的检索范围开关整体移除，默认恒全库；写侧
# `record_chat_scope` 与 `POST /{id}/chat-scope` 已删）。这两个常量**保留仅为渲染历史事件**
# —— 活库里已有 chat_scope_* 事件行，从 MATTER_EVENT_KINDS 里拿掉会让它们变成非法 kind。
CHAT_SCOPE_EXPANDED = "chat_scope_expanded"
CHAT_SCOPE_RESTORED = "chat_scope_restored"
# P4 (跟进 Agent 提案/评审/绑定)
UPDATE_PROPOSED = "update_proposed"
UPDATE_ACCEPTED = "update_accepted"
UPDATE_REJECTED = "update_rejected"
UPDATE_SUPERSEDED = "update_superseded"
AGENT_BINDING_CHANGED = "agent_binding_changed"
# P5 (Attention lifecycle)
ATTENTION_OPENED = "attention_opened"
ATTENTION_RESOLVED = "attention_resolved"
ATTENTION_SNOOZED = "attention_snoozed"
ATTENTION_DISMISSED = "attention_dismissed"
# task 08-25 (curated 进展 lane): 进展是独立于操作日志的 curated 条目, 但它的**维护动作**
# 照样是操作 —— 三条入口 (用户内联编辑 / 事项对话工具 / 提案被接受) 都经 service 单写面
# append 这四条之一, 于是操作日志天然看得到「谁在什么时候动了哪条进展」。
PROGRESS_ADDED = "progress_added"
PROGRESS_UPDATED = "progress_updated"
PROGRESS_REMOVED = "progress_removed"
PROGRESS_RESTORED = "progress_restored"
# task 08-25 批次 3 (行动项执行契约): 一条行动项被派给执行器之后的整条执行史。
# 🔴 事件带真实 FK `item_id`（matter_event 有这一列）；派发行自己的 id 只进 payload 的
# `dispatch_id` —— 为它再加一根 FK 列要重建整张事件表（P3 就定死的三根：item / resource /
# update），与 matter_progress 同一条取舍。
ITEM_DISPATCHED = "item_dispatched"
ITEM_DISPATCH_ANSWERED = "item_dispatch_answered"
ITEM_DISPATCH_CANCELED = "item_dispatch_canceled"
ITEM_DISPATCH_DELIVERED = "item_dispatch_delivered"
ITEM_DISPATCH_FAILED = "item_dispatch_failed"
ITEM_DISPATCH_SETTLED = "item_dispatch_settled"

MATTER_EVENT_KINDS = (
    MATTER_CREATED,
    MATTER_UPDATED,
    MATTER_ARCHIVED,
    MATTER_REOPENED,
    MATTER_TRASHED,
    MATTER_RESTORED,
    ITEM_CREATED,
    ITEM_UPDATED,
    ITEM_DELETED,
    ITEM_RESTORED,
    RESOURCE_LINKED,
    RESOURCE_UPDATED,
    RESOURCE_UNLINKED,
    RESOURCE_RESTORED,
    RESOURCE_SUGGESTION_ACCEPTED,
    RESOURCE_SUGGESTION_REJECTED,
    RESOURCE_ACCESS_POLICY_CHANGED,
    RESOURCE_SUBSCRIPTION_PAUSED,
    RESOURCE_SUBSCRIPTION_RESUMED,
    STAKEHOLDER_ADDED,
    STAKEHOLDER_UPDATED,
    STAKEHOLDER_REMOVED,
    STAKEHOLDER_RESTORED,
    RELATION_ADDED,
    RELATION_UPDATED,
    RELATION_REMOVED,
    RELATION_RESTORED,
    CHAT_SCOPE_EXPANDED,
    CHAT_SCOPE_RESTORED,
    UPDATE_PROPOSED,
    UPDATE_ACCEPTED,
    UPDATE_REJECTED,
    UPDATE_SUPERSEDED,
    AGENT_BINDING_CHANGED,
    ATTENTION_OPENED,
    ATTENTION_RESOLVED,
    ATTENTION_SNOOZED,
    ATTENTION_DISMISSED,
    PROGRESS_ADDED,
    PROGRESS_UPDATED,
    PROGRESS_REMOVED,
    PROGRESS_RESTORED,
    ITEM_DISPATCHED,
    ITEM_DISPATCH_ANSWERED,
    ITEM_DISPATCH_CANCELED,
    ITEM_DISPATCH_DELIVERED,
    ITEM_DISPATCH_FAILED,
    ITEM_DISPATCH_SETTLED,
)
