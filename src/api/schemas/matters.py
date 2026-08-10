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
