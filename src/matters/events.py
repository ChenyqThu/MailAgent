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
)
