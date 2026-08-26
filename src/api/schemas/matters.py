"""Pydantic DTOs for the Matters REST surface."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from src.matters.models import (
    MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS,
    MATTER_PROGRESS_BODY_MAX_CHARS,
    MATTER_PROGRESS_MAX_REFS,
    MATTER_PROGRESS_TITLE_MAX_CHARS,
    MATTER_RESOURCE_SUMMARY_MAX_CHARS,
    MATTER_STAKEHOLDER_REORDER_MAX,
    MATTER_SUGGESTION_BULK_MAX,
    MatterProgressKind,
    MatterStakeholderTier,
    MatterSuggestionBulkAction,
)


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
    # v61：背景与目标是**两个独立字段**（DB 同名两列）。合存单字段 + `## 背景` /
    # `## 目标` 小标题分段的老形状已下线 —— 这是一次**破坏性**的线上契约变更。
    background: str = ""
    goal: str = ""
    matter_type: str | None = Field(default=None, max_length=128)
    tags: list[str] = Field(default_factory=list)
    status: str = "inbox"
    health: str = "unknown"
    priority: str = "p1"
    due_at: int | None = None
    waiting_context: dict[str, Any] | None = None
    # 完成标志（0813 轮 3 O2）：**创建面**开放 —— 与 background / goal 同一 D7 语义（create 时
    # agent 可写、之后只有 user 能改；patch 面见 MatterPatchRequest 上方注释）。值域
    # （文本长度/条数/形状）仍由 service 的 `normalize_goal_checks` 单判（400 E_INVALID_ARG）。
    goal_checks: list[dict[str, Any]] | None = None
    source_resource: MatterSourceResource | None = None
    mutation: MutationEnvelope


class MatterPatchRequest(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    background: str | None = None
    goal: str | None = None
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
    #: per-行动项执行档（v71）。只有 kind='action' 能设，值域由 service 单判。
    exec_profile: str | None = None
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
    exec_profile: str | None = None
    source_resource_id: int | None = None
    source_locator: dict[str, Any] | None = None
    mutation: MutationEnvelope


class MatterItemDispatchRequest(StrictModel):
    """把一条行动项派给执行器（task 08-25 批次 3）。

    两个字段都可缺省：`executor_id` 缺省 = 内建跟进 Agent；`profile` 缺省 = 取 item 的
    `exec_profile`，仍缺省 = 出厂档 `propose_only`。
    🔴 值域（执行器存不存在 / 启没启用、执行档词表）由 service 单判 —— 在 DTO 里再抄一份
    枚举就是又一份会漂的手抄清单（PATCH 白名单那个 bug 的病根）。
    """

    executor_id: str | None = Field(default=None, max_length=128)
    profile: str | None = None
    mutation: MutationEnvelope


class MatterItemDispatchAnswerRequest(StrictModel):
    """owner 回答 agent 的反问。回答后开新一轮 run（不是唤醒旧 run，见 service 注释）。"""

    text: str = Field(min_length=1, max_length=MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS)
    mutation: MutationEnvelope


class MatterNoteCreateRequest(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    text: str | None = None
    mutation: MutationEnvelope


class MatterProgressCreateRequest(StrictModel):
    """curated 进展条目的新增（task 08-25）。

    🔴 值域与长度上限都从 `src/matters/models.py` 取，不在这里手抄第二份。
    `actor_kind` / `source` 不在 schema 里 —— 服务端从 mutation 信封与调用者身份盖章，
    调用方结构性不可伪造「这条是 Agent 写的」。
    """

    kind: MatterProgressKind
    title: str = Field(min_length=1, max_length=MATTER_PROGRESS_TITLE_MAX_CHARS)
    body: str | None = Field(default=None, max_length=MATTER_PROGRESS_BODY_MAX_CHARS)
    #: 叙事时间，epoch **毫秒**（缺省 = 现在）。秒值服务端恒拒不换算（§2.2）。
    happened_at: int | None = None
    refs: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MATTER_PROGRESS_MAX_REFS
    )
    mutation: MutationEnvelope


class MatterProgressPatchRequest(StrictModel):
    """进展条目的编辑。`deleted_at` 有意不在写面上 —— 删除 / 恢复走各自的端点。"""

    kind: MatterProgressKind | None = None
    title: str | None = Field(
        default=None, min_length=1, max_length=MATTER_PROGRESS_TITLE_MAX_CHARS
    )
    body: str | None = Field(default=None, max_length=MATTER_PROGRESS_BODY_MAX_CHARS)
    happened_at: int | None = None
    refs: list[dict[str, Any]] | None = Field(
        default=None, max_length=MATTER_PROGRESS_MAX_REFS
    )
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
    #: v60 —— 在**这件事**里的重要度。缺省 `normal`（核心组是给 owner 一眼扫的短名单，
    #: 默认进核心会让它当场失去意义）。`sort_order` **不接受逐条传**，见 reorder 端点。
    tier: MatterStakeholderTier | None = None
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
    tier: MatterStakeholderTier | None = None
    last_contact_at: int | None = None
    source_resource_id: int | None = None
    mutation: MutationEnvelope


class MatterStakeholderReorderItem(StrictModel):
    id: int = Field(ge=1)
    sort_order: int = Field(ge=0)
    #: 省略 = 不改档（纯组内重排）；给了 = 顺带换组（跨组拖拽）。
    tier: MatterStakeholderTier | None = None


class MatterStakeholderReorderRequest(StrictModel):
    """整批重排 / 换组。

    🔴 一次拖拽同时改多行（被拖的那行 + 让位的所有行）。逐条 PATCH 意味着一次拖拽发
    N 个带 `expected_version` 的请求，第 2 个必定撞版本冲突 —— 那正是 0812 dogfood P0
    「不管点哪个都是 matter version changed」的形状。整批一个事务、一次 CAS。
    """

    items: list[MatterStakeholderReorderItem] = Field(
        min_length=1, max_length=MATTER_STAKEHOLDER_REORDER_MAX
    )
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

    🔴 ``StrictModel`` = ``extra="forbid"``：gateway zod 加了字段而这里没加 → 每一条带该
    字段的提案在 REST 边界 **422**，而两侧单测与 typecheck 全绿。四份手抄的一致性闸见
    ``tests/matters/test_matters_contract_parity.py``。
    """

    provider: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=32)
    external_key: str = Field(min_length=1, max_length=512)
    title: str | None = Field(default=None, max_length=500)
    canonical_url: str | None = Field(default=None, max_length=2000)
    #: 这份资料**在说什么**（1-3 句，H3§6）。落库进 ``resource.sum``；邮件/会话类模型写了
    #: 也不生效（``resource_proposal._optional_summary`` 丢弃 → 邮件侧 ai_summary 权威）。
    summary: str | None = Field(default=None, max_length=MATTER_RESOURCE_SUMMARY_MAX_CHARS)
    #: 检出到新版本时「这一版相对上一版变了什么」的一句话（H3§5.4）。落进版本轨迹最新
    #: 一行的 ``diff_text``；这份资料还没有过版本变化时无处可落，静默丢弃（不新建行 ——
    #: 没有"上一版"就没有差异）。邮件/会话类在归一层就丢（邮件不会有新版本）。
    diff: str | None = Field(default=None, max_length=MATTER_RESOURCE_SUMMARY_MAX_CHARS)


class MatterProposalProgress(StrictModel):
    """提案里**记一条进展**（task 08-25，`kind=progress` 的载荷）。

    跟进 run 拿不到进展写工具（结构红线 §1），提案是它维护脉络的唯一通道，且只有「追加」
    这一种形态 —— 更正既有条目要 owner 在场，走事项对话。

    🔴 值域裁决全在服务端（`run_service._validate_changes` 剔一轮 +
    `service._progress_insert_fields` backstop）；这里只做形状与长度。
    """

    kind: MatterProgressKind
    title: str = Field(min_length=1, max_length=MATTER_PROGRESS_TITLE_MAX_CHARS)
    body: str | None = Field(default=None, max_length=MATTER_PROGRESS_BODY_MAX_CHARS)
    #: 叙事时间，epoch **毫秒**（缺省 = 接受的那一刻）。秒值在 propose 侧就被剔除。
    happened_at: int | None = None
    refs: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MATTER_PROGRESS_MAX_REFS
    )


class MatterProposalChange(StrictModel):
    """D6 Change 形状。🔴 matter_id/run_id/from|to_event_id/anchored_matter_version
    不在 schema 里 —— 全部服务端从 run 语境盖章，模型结构性不可传（extra=forbid）。"""

    id: str = Field(min_length=1, max_length=64)
    kind: str = Field(pattern="^(fact|inference|field|action|resource|progress)$")
    target: dict[str, Any] | None = None
    #: ``kind=resource`` 的第二形态：新建一条资料关联（与 ``target.id`` 的"确认既有"互斥）。
    resource: MatterProposalNewResource | None = None
    #: ``kind=progress`` 的载荷（task 08-25）。
    progress: MatterProposalProgress | None = None
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


class MatterItemReportQuestion(StrictModel):
    """行动项 run 的反问载荷（`needs_input`）。

    选项是可选的：能列清楚就列（owner 一键选），列不清楚就只问一句话。
    """

    question: str = Field(min_length=1, max_length=MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS)
    options: list[str] = Field(default_factory=list, max_length=8)


class MatterItemReportRequest(StrictModel):
    """`matter_item_report` 工具入参原样（task 08-25 批次 3）。

    锚字段（matter / dispatch）全在 path，模型结构性传不进来（extra=forbid）。
    🔴 「changes/summary 与 needs_input 二选一且必居其一」**不在这里判**：分支约束一律下沉
    `run_service.report_item_dispatch`（D11 —— schema 顶层分支两次把整条工具链打瘫的前科）。
    """

    summary: str | None = Field(default=None, max_length=2000)
    changes: list[MatterProposalChange] = Field(default_factory=list, max_length=20)
    needs_input: MatterItemReportQuestion | None = None
