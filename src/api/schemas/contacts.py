"""Pydantic request and response schemas for the Contact Directory REST face.

Request models keep the deliberately lightweight governance contract (no version CAS
or idempotency envelope; value-domain validation stays in ``src/contacts/service.py``).
Response models pair with ``SuccessEnvelope[T]`` for typed OpenAPI ``200``/``202`` schemas.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ── Request models ─────────────────────────────────────────────────────────────


class ContactResolveRequest(BaseModel):
    """批量精确解析 (WP4 互链): 邮件详情头一封一次把地址集换成 chip 数据。
    上限 100 在 router 校验 (400 E_INVALID_ARG, 跟随本面 view/sort 的错误形状,
    不用 pydantic 422)。"""

    emails: list[str] = Field(default_factory=list)


class ContactPatchRequest(BaseModel):
    """身份字段编辑。🔴 「未提供」≠「置空」—— router 用 ``model_dump(
    exclude_unset=True)`` 区分, 只把显式出现的键交给 service (保存即落锁)。"""

    display_name: Optional[str] = None
    formal_name: Optional[str] = None
    organization: Optional[str] = None
    department: Optional[str] = None
    role_title: Optional[str] = None
    phone: Optional[str] = None
    notes: Optional[str] = None
    function: Optional[str] = None
    seniority: Optional[str] = None
    gender: Optional[str] = None


class ContactLockRequest(BaseModel):
    field: str = Field(min_length=1)
    locked: bool


class ContactHideRequest(BaseModel):
    hidden: bool


class ContactKindRequest(BaseModel):
    kind: str = Field(min_length=1)


class ContactSelfRequest(BaseModel):
    is_self: bool


class ContactMergeRequest(BaseModel):
    """人级合并 (WP3, D6)。URL 里的 contact_id = winner (保留方)。

    主邮箱/曾用是**预览页勾选结果** —— 默认值推导 (last_seen 最新者做主 +
    60 天条款) 是前端纯函数职责 (`mergeModel.ts`), 服务端只按入参落库
    (service docstring 钉死)。跟随本文件头惯例: 无 CAS / 无幂等信封。"""

    loser_id: int
    primary_email: str = Field(min_length=3)
    former_emails: list[str] = Field(default_factory=list)


class ContactManagerRequest(BaseModel):
    """组织关系 (WP5): 指定/解除上级。null = 解除 (manager_src 一并清)。
    src **不在 wire 形状里** —— REST 面恒写 'manual' (auto 是 WP6/WP7 的
    建议采纳链路, 不从这里进)。"""

    manager_contact_id: Optional[int] = None


class ContactPrimaryEmailRequest(BaseModel):
    email: str = Field(min_length=3)


class ContactFormerEmailRequest(BaseModel):
    email: str = Field(min_length=3)
    former: bool


class ContactProfileSuggestionAdoptRequest(BaseModel):
    field: str = Field(min_length=1)
    value: Any


class ContactProfileSuggestionIgnoreRequest(BaseModel):
    field: str = Field(min_length=1)


class ContactSuggestionBulkRequest(BaseModel):
    """整批采纳 / 忽略待审建议。**不带 id 列表** —— 范围是服务端全量 pending
    (队列是分页的, 按已加载页做只会清一半积压)。

    动作值域跟随本面惯例在域函数 (``governance.bulk_resolve_suggestions``) 校验,
    非法值 → 400 E_INVALID_ARG (与 view/sort/kind 同一种错误形状, 不用 pydantic 422)。
    """

    action: str = Field(min_length=1)


class ContactGovernanceEvidence(BaseModel):
    message_id: str = Field(min_length=1)
    quote: str = Field(min_length=1, max_length=5000)


class ContactGovernanceProposalRequest(BaseModel):
    type: str = Field(min_length=1)
    contact_ids: list[int] = Field(min_length=1)
    payload: dict[str, Any]
    evidence: list[ContactGovernanceEvidence] = Field(min_length=1)
    confidence: Optional[float] = None


# ── Response models ────────────────────────────────────────────────────────────


class ContactRowDto(BaseModel):
    id: int
    display_name: Optional[str] = None
    formal_name: Optional[str] = None
    organization: Optional[str] = None
    department: Optional[str] = None
    role_title: Optional[str] = None
    function: Optional[str] = None
    seniority: Optional[str] = None
    gender: Optional[str] = None
    kind: str
    hidden_at: Optional[int] = None
    is_self: bool
    mail_count: int
    sent_to_count: int
    first_seen_at: Optional[int] = None
    last_seen_at: Optional[int] = None
    meeting_count: Optional[int] = None
    last_met_at: Optional[int] = None
    next_meeting_at: Optional[int] = None
    email_count: int
    primary_email: Optional[str] = None
    manager_contact_id: Optional[int] = None
    manager_display_name: Optional[str] = None
    profile_summary: Optional[str] = None
    profile_min: int
    profile_eligible: bool


class ContactListResponse(BaseModel):
    items: list[ContactRowDto]
    total: int
    next_cursor: Optional[str] = None


class ContactEmailDto(BaseModel):
    address: str
    is_primary: bool
    former_at: Optional[int] = None
    mail_count: int
    first_seen_at: Optional[int] = None
    last_seen_at: Optional[int] = None


class ContactRelPersonDto(BaseModel):
    id: int
    display_name: Optional[str] = None
    formal_name: Optional[str] = None
    organization: Optional[str] = None
    role_title: Optional[str] = None
    kind: str
    mail_count: int
    primary_email: Optional[str] = None


class ContactProfileSuggestionDto(BaseModel):
    field: str
    value: str
    out_of_frame: Optional[bool] = None


class ContactProfileDocumentDto(BaseModel):
    model_config = ConfigDict(extra="allow")

    summary: Optional[str] = None
    role_title: Optional[str] = None
    formal_name: Optional[str] = None
    department: Optional[str] = None
    topics: Optional[list[str]] = Field(default_factory=list)
    projects: Optional[list[str]] = Field(default_factory=list)
    communication_style: Optional[str] = None
    contact_info: Optional[dict[str, Any]] = Field(default_factory=dict)
    evolution: Optional[list[dict[str, Any]]] = Field(default_factory=list)
    contradictions: Optional[list[str]] = Field(default_factory=list)
    evidence_window: Optional[dict[str, Any]] = None


class ContactProfileDto(BaseModel):
    document: Optional[ContactProfileDocumentDto] = None
    profile_json: Optional[ContactProfileDocumentDto] = None
    profile_updated_at: Optional[int] = None
    profile_mail_count: Optional[int] = None
    profile_model: Optional[str] = None
    profile_status: Optional[str] = None
    profile_attempted_at: Optional[int] = None
    profile_error: Optional[str] = None
    attempted_mail_count: Optional[int] = None
    status: str
    profile_min: int
    eligible: bool
    needed_mail_count: int
    suggestions: list[ContactProfileSuggestionDto]


class ContactDetailResponse(BaseModel):
    id: int
    display_name: Optional[str] = None
    formal_name: Optional[str] = None
    organization: Optional[str] = None
    department: Optional[str] = None
    role_title: Optional[str] = None
    function: Optional[str] = None
    seniority: Optional[str] = None
    gender: Optional[str] = None
    kind: str
    kind_locked_at: Optional[int] = None
    is_self: bool
    hidden_at: Optional[int] = None
    merged_into: Optional[int] = None
    notes: Optional[str] = None
    phone: Optional[str] = None
    contact_info: dict[str, Any]
    name_variants: list[str]
    identity_locks: dict[str, int]
    mail_count: int
    sent_to_count: int
    first_seen_at: Optional[int] = None
    last_seen_at: Optional[int] = None
    meeting_count: Optional[int] = None
    last_met_at: Optional[int] = None
    next_meeting_at: Optional[int] = None
    created_at: int
    updated_at: int
    emails: list[ContactEmailDto]
    manager: Optional[ContactRelPersonDto] = None
    manager_src: Optional[str] = None
    reports: list[ContactRelPersonDto]
    peers: list[ContactRelPersonDto]
    profile: ContactProfileDto


class ContactChipDto(BaseModel):
    id: int
    display_name: Optional[str] = None
    formal_name: Optional[str] = None
    kind: str
    primary_email: Optional[str] = None


class ContactResolveResponse(BaseModel):
    items: dict[str, Optional[ContactChipDto]]


class ContactMailDto(BaseModel):
    internal_id: int
    subject: Optional[str] = None
    sender: Optional[str] = None
    sender_name: Optional[str] = None
    mailbox: Optional[str] = None
    date_received: Optional[str] = None
    is_read: bool
    message_id: Optional[str] = None
    seen_at: Optional[int] = None
    roles: list[str]
    direction: str


class ContactMailsResponse(BaseModel):
    items: list[ContactMailDto]
    next_cursor: Optional[str] = None
    total: int


class ContactMatterDto(BaseModel):
    matter_id: int
    public_id: str
    title: str
    status: str
    role: Optional[str] = None
    archived_at: Optional[int] = None


class ContactMattersResponse(BaseModel):
    items: list[ContactMatterDto]


class ContactBackfillProgressResponse(BaseModel):
    scanned: int
    total: int
    drained: bool


class ContactPatchResponse(BaseModel):
    fields: dict[str, Any]
    locks: dict[str, int]
    contact: ContactDetailResponse


class ContactLocksResponse(BaseModel):
    locks: dict[str, int]


class ContactHideResponse(BaseModel):
    hidden: bool


class ContactKindResponse(BaseModel):
    kind: str


class ContactSelfResponse(BaseModel):
    is_self: bool


class ContactPrimaryEmailResponse(BaseModel):
    primary_email: str


class ContactFormerEmailResponse(BaseModel):
    email: str
    former: bool


class ContactProfileRefreshResponse(BaseModel):
    contact_id: int
    status: str
    started: bool


class ContactProfileDailySummaryResponse(BaseModel):
    date: str
    attempted: int
    ok: int
    skipped: int
    failed: int
    last_attempted_at: Optional[int] = None
    fire_hour: int


class ContactSuggestionEvidenceDto(BaseModel):
    model_config = ConfigDict(extra="allow")

    message_id: str
    quote: str


class ContactGovernanceSuggestionDto(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    type: str
    contact_ids: list[int]
    payload: dict[str, Any]
    evidence: list[ContactSuggestionEvidenceDto]
    confidence: Optional[float] = None
    status: str
    block_reason: Optional[str] = None
    created_at: int
    decided_at: Optional[int] = None


class ContactSuggestionListResponse(BaseModel):
    items: list[ContactGovernanceSuggestionDto]
    next_cursor: Optional[str] = None


class ContactSuggestionAdoptResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    status: Literal["adopted"] = "adopted"
    decided_at: int
    contact_ids: list[int] = Field(default_factory=list)
    merge_pair: Optional[list[int]] = None


class ContactSuggestionIgnoreResponse(BaseModel):
    id: int
    status: Literal["ignored"] = "ignored"
    decided_at: int


class ContactSuggestionBulkBlockedItem(BaseModel):
    id: int
    code: str
    message: str


class ContactSuggestionBulkSkippedItem(BaseModel):
    id: int
    reason: str


class ContactSuggestionBulkResponse(BaseModel):
    action: str
    adopted: int
    ignored: int
    blocked: list[ContactSuggestionBulkBlockedItem]
    skipped: list[ContactSuggestionBulkSkippedItem]
    remaining: int
    contact_ids: list[int]


class ContactAgentRunResponse(BaseModel):
    job_id: int
    status: str
    created: bool
    coalesced: bool


class ContactAgentStatusResponse(BaseModel):
    enabled: bool
    pending_count: int
    last_fire_day: Optional[str] = None
    last_scan_at: Optional[int] = None
    last_scan_status: Optional[str] = None
    last_scan_error: Optional[str] = None


class ContactAgentHistoryItemDto(BaseModel):
    job_id: int
    status: str
    created_at: Optional[int] = None
    started_at: Optional[int] = None
    finished_at: Optional[int] = None
    last_error: Optional[str] = None
    suggestions_created: Optional[int] = None
    trigger_kind: Optional[str] = None


class ContactAgentHistoryResponse(BaseModel):
    items: list[ContactAgentHistoryItemDto]


class ContactGovernanceProposalResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    created: bool
    status: str
