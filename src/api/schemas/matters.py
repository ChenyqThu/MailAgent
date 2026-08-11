"""Pydantic DTOs for the Matters REST surface."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MutationEnvelope(StrictModel):
    source: str = Field(min_length=1, max_length=64)
    idempotency_key: str = Field(min_length=1, max_length=256)
    expected_version: int | None = Field(default=None, ge=1)
    reason: str | None = Field(default=None, max_length=2000)
    reverses_event_id: int | None = Field(default=None, ge=1)


class MatterUndoDescriptor(StrictModel):
    tool: str = Field(min_length=1, max_length=128)
    input: dict[str, Any]
    label: str = Field(min_length=1, max_length=500)


class MutationOnly(StrictModel):
    mutation: MutationEnvelope


class PermanentDeleteRequest(StrictModel):
    confirmation: str = Field(min_length=1, max_length=128)
    mutation: MutationEnvelope


class MatterChatScopeRequest(StrictModel):
    scope: str = Field(pattern="^(matter|global)$")
    session_id: int = Field(ge=1)
    mutation: MutationEnvelope


class MatterSourceResource(StrictModel):
    provider: str = "mailagent"
    kind: str = "email"
    internal_id: int = Field(ge=1)
    link_scope: str = Field(default="thread", pattern="^(thread|single)$")


class MatterCreateRequest(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    description: str = ""
    matter_type: str | None = Field(default=None, max_length=128)
    tags: list[str] = Field(default_factory=list)
    status: str = "inbox"
    health: str = "unknown"
    priority: str = "p1"
    due_at: int | None = None
    waiting_context: dict[str, Any] | None = None
    source_resource: MatterSourceResource | None = None
    mutation: MutationEnvelope


class MatterPatchRequest(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    description: str | None = None
    matter_type: str | None = Field(default=None, max_length=128)
    tags: list[str] | None = None
    status: str | None = None
    health: str | None = None
    current_summary: str | None = None
    due_at: int | None = None
    waiting_context: dict[str, Any] | None = None
    next_attention_at: int | None = None
    attention_reason: str | None = None
    # P4 绑定三键（D2）：agent_profile_id 显式 null = 解绑。
    agent_profile_id: str | None = Field(default=None, max_length=128)
    agent_enabled: bool | None = None
    matter_instructions: str | None = Field(default=None, max_length=4000)
    mutation: MutationEnvelope


class MatterItemCreateRequest(StrictModel):
    kind: str
    title: str = Field(min_length=1, max_length=500)
    description: str | None = None
    position: int = 0
    status: str | None = None
    priority: str | None = None
    owner_kind: str | None = None
    owner_id: str | None = None
    waiting_on_stakeholder_id: int | None = None
    due_at: int | None = None
    completed_at: int | None = None
    checklist: list[dict[str, Any]] = Field(default_factory=list)
    source_resource_id: int | None = None
    source_locator: dict[str, Any] | None = None
    mutation: MutationEnvelope


class MatterItemPatchRequest(StrictModel):
    kind: str | None = None
    title: str | None = Field(default=None, max_length=500)
    description: str | None = None
    position: int | None = None
    status: str | None = None
    priority: str | None = None
    owner_kind: str | None = None
    owner_id: str | None = None
    waiting_on_stakeholder_id: int | None = None
    due_at: int | None = None
    completed_at: int | None = None
    checklist: list[dict[str, Any]] | None = None
    source_resource_id: int | None = None
    source_locator: dict[str, Any] | None = None
    mutation: MutationEnvelope


class MatterNoteCreateRequest(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    text: str | None = None
    mutation: MutationEnvelope


class MatterResourceCreateRequest(StrictModel):
    resource_id: int | None = Field(default=None, ge=1)
    provider: str | None = None
    external_key: str | None = None
    kind: str | None = None
    canonical_url: str | None = None
    title: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    access_policy: str = "allowed"
    relation_type: str | None = None
    pinned: bool = False
    confidence: float | None = Field(default=None, ge=0, le=1)
    provenance: dict[str, Any] = Field(default_factory=dict)
    confirmed: bool = False
    sub_state: str = "none"
    source_resource: MatterSourceResource | None = None
    mutation: MutationEnvelope


class MatterResourcePatchRequest(StrictModel):
    scope: str | None = None
    access_policy: str | None = None
    pinned: bool | None = None
    relation_type: str | None = None
    sub_state: str | None = None
    confirmed: bool | None = None
    mutation: MutationEnvelope


class MatterStakeholderCreateRequest(StrictModel):
    person_key: str | None = None
    display_name: str | None = None
    email: str | None = None
    organization: str | None = None
    role: str | None = None
    relationship: str | None = None
    is_waiting_on: bool = False
    last_contact_at: int | None = None
    source_resource_id: int | None = None
    mutation: MutationEnvelope


class MatterStakeholderPatchRequest(StrictModel):
    display_name: str | None = None
    email: str | None = None
    organization: str | None = None
    role: str | None = None
    relationship: str | None = None
    is_waiting_on: bool | None = None
    last_contact_at: int | None = None
    source_resource_id: int | None = None
    mutation: MutationEnvelope


class MatterRelationCreateRequest(StrictModel):
    target_public_id: str
    relation_type: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    provenance: dict[str, Any] = Field(default_factory=dict)
    confirmed: bool = False
    mutation: MutationEnvelope


class MatterRelationPatchRequest(StrictModel):
    relation_type: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    confirmed: bool | None = None
    mutation: MutationEnvelope


# ── P4: Updates 评审 / Runs / 提案（D6/D9/D10）─────────────────────────────────


class MatterUpdateEditedChange(StrictModel):
    """编辑后接受的单条编辑（D9）：只引用原 change id，**不许新 target**（extra=forbid）。"""

    change_id: str = Field(min_length=1, max_length=64)
    after: Any = None
    text: str | None = Field(default=None, max_length=2000)
    edit_reason: str | None = Field(default=None, max_length=2000)


class MatterUpdateAcceptRequest(StrictModel):
    selected_change_ids: list[str] | None = Field(default=None, max_length=50)
    edited_changes: list[MatterUpdateEditedChange] | None = Field(
        default=None, max_length=50
    )
    edited_summary: str | None = Field(default=None, max_length=2000)
    mutation: MutationEnvelope


class MatterUpdateRejectRequest(StrictModel):
    reason: str = Field(min_length=1, max_length=2000)
    mutation: MutationEnvelope


class MatterProposalSource(StrictModel):
    """提案证据源（gateway matter_update_propose 工具入参形状，lane ② 契约）。"""

    resource_id: int = Field(ge=1)
    locator: dict[str, Any] | None = None
    evidence: str | None = Field(default=None, max_length=2000)


class MatterProposalChange(StrictModel):
    """D6 Change 形状。🔴 matter_id/run_id/from|to_event_id/anchored_matter_version
    不在 schema 里 —— 全部服务端从 run 语境盖章，模型结构性不可传（extra=forbid）。"""

    id: str = Field(min_length=1, max_length=64)
    kind: str = Field(pattern="^(fact|inference|field|action|resource)$")
    target: dict[str, Any] | None = None
    operation: str | None = Field(default=None, pattern="^(add|replace|remove)$")
    before: Any = None
    after: Any = None
    text: str | None = Field(default=None, max_length=2000)
    reason: str | None = Field(default=None, max_length=2000)
    is_inference: bool | None = None
    sources: list[MatterProposalSource] = Field(default_factory=list, max_length=5)


class MatterProposalRequest(StrictModel):
    summary: str | None = Field(default=None, max_length=2000)
    changes: list[MatterProposalChange] = Field(default_factory=list, max_length=20)
    open_questions: list[str] | None = Field(default=None, max_length=5)
    confidence: float | None = Field(default=None, ge=0, le=1)
