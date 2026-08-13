"""Pydantic DTOs for the Matters REST surface."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from src.matters.models import MATTER_SUGGESTION_BULK_MAX, MatterSuggestionBulkAction


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
    # 这里只声明**线上形状**；值域（合法 priority / goal check 文本长度与条数）仍由 service
    # 的 `_require_value` / `normalize_goal_checks` 单判（400 E_INVALID_ARG），与
    # MatterCreateRequest 的 `priority: str` 同形 —— 在 DTO 里再抄一份枚举 = 又一份会漂的
    # 手抄清单，正是本 bug（DTO 漏了这两个字段导致改优先级/存完成标志恒 422）的病根。
    priority: str | None = None
    tags: list[str] | None = None
    goal_checks: list[dict[str, Any]] | None = None
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


class MatterSuggestionBulkRequest(StrictModel):
    """整批确认 / 忽略资料建议。`resource_ids` 里混进已处置 / 不属于本事项的 id 不算错误
    （服务端逐条分类计数返回），故这里只校验形状与上限。

    🔴 动作值域与条数上限都从 `src/matters/models.py` 取，不在这里手抄第二份。"""

    action: MatterSuggestionBulkAction
    resource_ids: list[int] = Field(min_length=1, max_length=MATTER_SUGGESTION_BULK_MAX)
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
    """提案证据源（gateway matter_update_propose 工具入参形状，lane ② 契约）。

    二选一：``resource_id`` 指本事项**已关联**的资源；``change_id`` 指同一份提案里正在
    **新建**关联的那条 ``kind=resource`` change（那时还没有 resource_id）。两者都不给 /
    都给 → 服务端按越界处理（source 丢弃，fact 随之整条丢弃）。
    """

    resource_id: int | None = Field(default=None, ge=1)
    change_id: str | None = Field(default=None, min_length=1, max_length=64)
    locator: dict[str, Any] | None = None
    evidence: str | None = Field(default=None, max_length=2000)


class MatterProposalNewResource(StrictModel):
    """提案里**新建**的一份外部资料的身份（0812）。

    键名逐个取自 ``resource`` 表既有列 / ``MatterService._upsert_resource`` 既有入参 ——
    不另造命名。值域裁决全在服务端 ``src/matters/resource_proposal.py``（provider 白名单
    = builtin + 已连接 connector，external_key 按 provider 既有约定，mailagent 侧还验存在
    性）；这里只做长度与非空。
    """

    provider: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=32)
    external_key: str = Field(min_length=1, max_length=512)
    title: str | None = Field(default=None, max_length=500)
    canonical_url: str | None = Field(default=None, max_length=2000)


class MatterProposalChange(StrictModel):
    """D6 Change 形状。🔴 matter_id/run_id/from|to_event_id/anchored_matter_version
    不在 schema 里 —— 全部服务端从 run 语境盖章，模型结构性不可传（extra=forbid）。"""

    id: str = Field(min_length=1, max_length=64)
    kind: str = Field(pattern="^(fact|inference|field|action|resource)$")
    target: dict[str, Any] | None = None
    #: ``kind=resource`` 的第二形态：新建一条资料关联（与 ``target.id`` 的"确认既有"互斥）。
    resource: MatterProposalNewResource | None = None
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
