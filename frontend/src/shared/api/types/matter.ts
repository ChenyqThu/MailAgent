// Canonical source: src/matters/models.py.
// Cross-language drift gate: tests/matters/test_matters_contract_parity.py.

export const MATTER_STATUSES = [
  'inbox',
  'planned',
  'active',
  'waiting',
  'blocked',
  'monitoring',
  'done',
  'canceled'
] as const
export type MatterStatus = (typeof MATTER_STATUSES)[number]

export const MATTER_HEALTH_VALUES = ['unknown', 'on_track', 'at_risk', 'off_track'] as const
export type MatterHealth = (typeof MATTER_HEALTH_VALUES)[number]

export const MATTER_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const
export type MatterPriority = (typeof MATTER_PRIORITIES)[number]

export const MATTER_ITEM_KINDS = [
  'action',
  'milestone',
  'decision',
  'blocker',
  'question',
  'note'
] as const
export type MatterItemKind = (typeof MATTER_ITEM_KINDS)[number]

export const MATTER_ITEM_STATUSES = [
  'open',
  'in_progress',
  'waiting',
  'blocked',
  'done',
  'canceled'
] as const
export type MatterItemStatus = (typeof MATTER_ITEM_STATUSES)[number]

export const MATTER_RESOURCE_KINDS = ['email', 'thread', 'event', 'doc', 'file', 'url'] as const
export type MatterResourceKind = (typeof MATTER_RESOURCE_KINDS)[number]

export const MATTER_RELATION_TYPES = [
  'related_to',
  'depends_on',
  'blocks',
  'follow_up_of',
  'supersedes'
] as const
export type MatterRelationType = (typeof MATTER_RELATION_TYPES)[number]

export const MATTER_ATTENTION_KINDS = [
  'wait_overdue',
  'action_overdue',
  'deadline_near',
  'health_down',
  'needs_review',
  'run_failed',
  'context_gap'
] as const
export type MatterAttentionKind = (typeof MATTER_ATTENTION_KINDS)[number]

export const MATTER_ATTENTION_STATES = ['open', 'resolved', 'snoozed', 'dismissed'] as const
export type MatterAttentionState = (typeof MATTER_ATTENTION_STATES)[number]

export const MATTER_ATTENTION_SEVERITIES = ['info', 'warn', 'critical'] as const
export type MatterAttentionSeverity = (typeof MATTER_ATTENTION_SEVERITIES)[number]

export const MATTER_NOTIFY_LEVELS = ['high', 'all', 'off'] as const
export type MatterNotifyLevel = (typeof MATTER_NOTIFY_LEVELS)[number]

export const MATTER_CHANGE_KINDS = ['fact', 'inference', 'field', 'action', 'resource'] as const
export type MatterChangeKind = (typeof MATTER_CHANGE_KINDS)[number]

export const MATTER_RUN_STATUSES = ['ok', 'noop', 'warn', 'fail'] as const
export type MatterRunStatus = (typeof MATTER_RUN_STATUSES)[number]
export type MatterRunLifecycleState =
  | 'queued'
  | 'running'
  | 'ok'
  | 'noop'
  | 'warn'
  | 'fail'
  | 'canceled'

export const MATTER_RUN_TRIGGERS = ['manual', 'schedule', 'event', 'condition'] as const
export type MatterRunTrigger = (typeof MATTER_RUN_TRIGGERS)[number]

/** 事件型触发的可选项。**刻意小于设计稿**：只收录能映射到既有判据的项 —— 设计画的
 *  「会议结束」（日历与事项零接线）不做，与其给一个永不触发的选项，不如不给。 */
export const MATTER_EVENT_TRIGGER_TYPES = ['resource_doc_updated', 'resource_linked_mail'] as const
export type MatterEventTriggerType = (typeof MATTER_EVENT_TRIGGER_TYPES)[number]

/** 条件型触发的可选项，各自直接对应一条既有的 attention 信号。设计画的「超过 5 天无进展」
 *  后端没有对应判据，不做。 */
export const MATTER_CONDITION_TRIGGER_TYPES = [
  'action_overdue',
  'health_down',
  'wait_overdue'
] as const
export type MatterConditionTriggerType = (typeof MATTER_CONDITION_TRIGGER_TYPES)[number]

/** 「跟进时执行」四项（设计 §5.2 ACTIONS），跟着 schedule_json 的 v2 envelope 走。
 *  🔴 勾选**不扩大工具面** —— 工具 allowlist 与 Observe+Assist 上限由服务端强制，
 *  这四项定的是「本次跟进要产出什么」，不是「能调用什么」。 */
export const MATTER_RUN_ACTIONS = ['summary', 'items', 'draft', 'proposal'] as const
export type MatterRunAction = (typeof MATTER_RUN_ACTIONS)[number]

/** 出厂默认 = 设计稿里预先勾上的前两项（与 Python DEFAULT_RUN_ACTIONS 同源，有 parity 闸）。 */
export const MATTER_DEFAULT_RUN_ACTIONS = ['summary', 'items'] as const

/**
 * 「跟进规则」写侧的线上形状 —— PATCH body 里 `schedule_json` 的值。
 *
 * 🔴 **写侧是对象，读侧是字符串**，两者不是一个东西，别互抄：
 * - 写：`MatterPatchInput.schedule_json` ↔ pydantic `MatterPatchWithScheduleRequest.schedule_json:
 *   dict[str, Any] | None` —— 发字符串会在 FastAPI 校验层 422，整条 PATCH（含 agent_enabled /
 *   profile / instructions）全被拒（0812 dogfood「跟进规则保存必定失败」的根因就是这里抄成了
 *   字符串）。
 * - 读：`Matter.schedule_json` 是 DB 列，确实是字符串（服务端 `_dump` 后落库）。
 *
 * 跨语言闸：`tests/fixtures/matter_trigger_envelope.json`
 * （vitest `matterTriggerEnvelopeParity.test.ts` + pytest `test_matter_trigger_envelope_parity.py`）。
 */
export interface MatterTriggerEnvelope {
  v: number
  triggers: Record<string, unknown>[]
  actions?: MatterRunAction[]
}

/** 标签色 —— 值是既有主题 token 名，不新增颜色（P6-B D4）。 */
export const MATTER_TAG_COLORS = [
  '--c-accent',
  '--c-info',
  '--c-ok',
  '--c-warn',
  '--c-crit',
  '--c-ai'
] as const
export type MatterTagColor = (typeof MATTER_TAG_COLORS)[number]

/** 标签形状。与颜色是两个独立维度：同色可靠形状区分，同形可靠颜色区分。 */
export const MATTER_TAG_SHAPES = ['circle', 'ring', 'square', 'diamond', 'bar'] as const
export type MatterTagShape = (typeof MATTER_TAG_SHAPES)[number]

/** `matter.tags_json` 里出现但 `matter_tag` 定义表没有的名字按这两个默认值渲染 —— 定义表
 *  缺行不让标签变成孤儿。与 Python `MATTER_TAG_DEFAULT_*` 同值。 */
export const MATTER_TAG_DEFAULT_COLOR: MatterTagColor = '--c-accent'
export const MATTER_TAG_DEFAULT_SHAPE: MatterTagShape = 'circle'

export interface MatterTagDefinition {
  name: string
  color: MatterTagColor
  shape: MatterTagShape
  created_at: number | null
  usage_count: number
  inferred?: boolean
}

export interface MatterTagListResponse {
  items: MatterTagDefinition[]
}

export interface MatterTagMutationResult {
  tag?: MatterTagDefinition
  deleted?: boolean
  name?: string
  event_ids?: number[]
  warnings?: string[]
  affected_count?: number
}

export const MATTER_ACCESS_POLICIES = ['allowed', 'metadata_only', 'excluded'] as const
export type MatterAccessPolicy = (typeof MATTER_ACCESS_POLICIES)[number]

export const MATTER_UPDATE_REVIEW_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'superseded'
] as const
export type MatterUpdateReviewStatus = (typeof MATTER_UPDATE_REVIEW_STATUSES)[number]

export const MATTER_ACTOR_KINDS = ['user', 'agent', 'system'] as const
export type MatterActorKind = (typeof MATTER_ACTOR_KINDS)[number]

export const MATTER_RESOURCE_SUBSCRIPTION_STATES = ['none', 'active', 'paused'] as const
export type MatterResourceSubscriptionState = (typeof MATTER_RESOURCE_SUBSCRIPTION_STATES)[number]

export const MATTER_SEARCH_FIELDS = [
  'title',
  'description',
  'current_summary',
  'status',
  'items',
  'stakeholders',
  'notes'
] as const
export type MatterSearchField = (typeof MATTER_SEARCH_FIELDS)[number]

export const MATTER_LINK_SCOPES = ['thread', 'single'] as const
export type MatterLinkScope = (typeof MATTER_LINK_SCOPES)[number]

export const BUILTIN_MATTER_TYPES = ['客户交付', '商务', '售前', '问题', '内部', '产品'] as const
export type BuiltinMatterType = (typeof BUILTIN_MATTER_TYPES)[number]

export interface MutationEnvelope {
  source: string
  idempotency_key: string
  expected_version: number | null
  reason: string | null
}

export interface MatterChecklistEntry {
  id: string
  text: string
  done: boolean
}

export interface MatterGoalCheck {
  t: string
  done: boolean
}

export interface MatterAttentionSignal {
  id?: number
  matter_id?: number
  kind: MatterAttentionKind
  state: MatterAttentionState
  severity?: MatterAttentionSeverity
  why?: string
  recurrence_no?: number
  first_opened_at?: number
  last_observed_at?: number
  snoozed_until?: number | null
  resolved_at?: number | null
  dismissed_at?: number | null
  cleared_at?: number | null
  last_notified_at?: number | null
  payload?: Record<string, unknown> | null
  matter?: Pick<Matter, 'public_id' | 'title' | 'status' | 'health' | 'priority'>
}

export interface MatterAttentionListResponse {
  items: MatterAttentionSignal[]
}

export interface MatterNotifyLevelResponse {
  level: MatterNotifyLevel
}

export interface Matter {
  id: number
  public_id: string
  title: string
  description: string
  matter_type: string | null
  tags: string[]
  goal_checks?: MatterGoalCheck[]
  status: MatterStatus
  health: MatterHealth
  priority: MatterPriority
  owner_id: string | null
  source: string
  due_at: number | null
  waiting_context: Record<string, unknown> | null
  next_attention_at: number | null
  attention_reason: string | null
  last_activity_at: number | null
  latest_accepted_update_id: number | null
  current_summary: string | null
  summary_at: number | null
  summary_by_kind: MatterActorKind | null
  summary_by_id: string | null
  version: number
  archived_at: number | null
  archived_by_kind: MatterActorKind | null
  archived_by_id: string | null
  deleted_at: number | null
  deleted_by_kind: MatterActorKind | null
  deleted_by_id: string | null
  purge_after: number | null
  created_at: number
  updated_at: number
  agent_profile_id?: string | null
  agent_enabled?: number | boolean
  matter_instructions?: string | null
  schedule_json?: string | null
  attention_signals?: MatterAttentionSignal[]
  items?: MatterItem[]
  matched_fields?: MatterSearchField[]
  snippets?: Partial<Record<MatterSearchField, string>>
}

export interface MatterSourceResourceInput {
  provider: 'mailagent'
  kind: 'email'
  internal_id: number
  link_scope: MatterLinkScope
}

export interface MatterResource {
  id: number
  kind: MatterResourceKind
  provider: string
  external_key: string
  canonical_url: string | null
  title: string | null
  metadata: Record<string, unknown>
  revision: string | null
  content_hash: string | null
  permission_state: string | null
  sync_state: string | null
  access_policy: MatterAccessPolicy
  last_checked_at: number | null
  created_at: number
  updated_at: number
  available?: boolean
  url_fetch_cache?: MatterUrlFetchCache
}

export interface MatterUrlFetchCache {
  state: 'missing' | 'stale' | 'fresh'
  has_content: boolean
  is_fresh: boolean
  fetched_at: number | null
  fresh_until: number | null
  age_ms: number | null
  freshness_ms: number
  content_hash: string | null
  final_url: string | null
  content_type: string | null
  status: number | null
  truncated: boolean
  content_chars: number
}

export interface MatterResourceLink {
  id: number
  matter_id: number
  resource_id: number
  relation_type: string | null
  pinned: boolean
  added_by_kind: MatterActorKind
  added_by_id: string | null
  confidence: number | null
  provenance: Record<string, unknown>
  confirmed_at: number | null
  sub_state: MatterResourceSubscriptionState
  deleted_at: number | null
  created_at: number
  updated_at: number
}

export interface MatterResourceListItem {
  resource: MatterResource
  link: MatterResourceLink
  available?: boolean
}

export type MatterResourceExpansionReason = 'context_gap' | 'verification' | 'matter_instructions'

export interface MatterCandidateReason {
  kind: 'resource_overlap' | 'stakeholder_overlap' | 'semantic_overlap' | 'time_proximity'
  label: string
  weight: number
  evidence: string[]
}

export interface MatterDuplicateCandidate {
  matter: Pick<Matter, 'public_id' | 'title' | 'status' | 'health' | 'priority' | 'updated_at'>
  confidence: number
  reasons: MatterCandidateReason[]
}

export interface MatterDuplicateCandidateInput {
  matter_id?: string
  title?: string
  description?: string
  current_summary?: string
  stakeholders?: Array<{ email?: string | null } | string>
  resources?: Array<{ provider: string; kind: string; external_key: string }>
  reference_at?: number
}

export interface MatterCreateDraftRequest {
  internal_id: number
  thread_id?: string | null
  link_scope?: MatterLinkScope | null
  title?: string | null
  matter_type?: BuiltinMatterType | null
  description?: string | null
}

export type MatterCreateDraftResourceReasonKind =
  | 'source_email'
  | 'same_thread'
  | 'full_text_match'
  | 'notion_search_match'

export interface MatterCreateDraftReason {
  kind: MatterCreateDraftResourceReasonKind | 'sender' | 'recipient'
  label: string
  evidence: string[]
}

export interface MatterCreateDraftResource {
  provider: 'mailagent' | 'notion'
  kind: 'email' | 'doc'
  external_key: string
  title: string
  url: string | null
  excerpt: string | null
  reason: MatterCreateDraftReason
}

export interface MatterCreateDraftStakeholder {
  email: string
  display_name: string | null
  reason: MatterCreateDraftReason
}

export interface MatterCreateDraftResponse {
  source: {
    internal_id: number
    thread_id: string | null
    link_scope: MatterLinkScope
  }
  draft: {
    title: string
    matter_type: BuiltinMatterType | null
    description: string
    resources: MatterCreateDraftResource[]
    stakeholders: MatterCreateDraftStakeholder[]
    duplicate_candidates: MatterDuplicateCandidate[]
  }
  research: {
    thread_email_count: number
    related_email_count: number
    notion_status: 'disabled' | 'searched' | 'failed'
    warnings: Array<{ code: 'notion_search_failed'; message: string }>
  }
}

export interface MatterResourceSuggestion extends MatterResourceListItem {
  reason: string
  confidence: number
}

/** 整批处置资料建议。逐条口不变，这是「全部确认 / 全部忽略」的整批口。 */
export const MATTER_SUGGESTION_BULK_ACTIONS = ['confirm', 'reject'] as const
export type MatterSuggestionBulkAction = (typeof MATTER_SUGGESTION_BULK_ACTIONS)[number]

/** 批里**没做**的那些条各自的原因。混成一个数字就说不清「到底成了几条」，所以分开计数。 */
export const MATTER_SUGGESTION_BULK_SKIP_REASONS = [
  'already_applied',
  'already_confirmed',
  'not_linked'
] as const
export type MatterSuggestionBulkSkipReason = (typeof MATTER_SUGGESTION_BULK_SKIP_REASONS)[number]

export interface MatterSuggestionBulkResult extends MatterMutationResult {
  action: MatterSuggestionBulkAction
  applied: number[]
  skipped: Array<{ resource_id: number; reason: MatterSuggestionBulkSkipReason }>
  counts: { applied: number; skipped: number }
}

export interface MatterResourceDiscoveryResult {
  items: MatterResourceSuggestion[]
  suppressed: Array<{ external_key: string; reason: 'rejected_same_evidence' }>
  local_candidate_count: number
  expanded: boolean
  /** true = 该事项已挂满未审建议（服务端 `RESOURCE_SUGGESTION_BACKLOG_CAP`），本次不再堆新的。 */
  backlog_capped?: boolean
}

export interface MatterStakeholder {
  id: number
  matter_id: number
  person_key: string
  display_name: string | null
  email_normalized: string | null
  organization: string | null
  role: string | null
  relationship: string | null
  is_waiting_on: boolean
  last_contact_at: number | null
  source_resource_id: number | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

export interface MatterResourceLinkHit {
  public_id: string
  title: string
  status: MatterStatus
  health: MatterHealth
  priority: MatterPriority
  link_id: number
  resource_id: number
  pinned: boolean
  sub_state: MatterResourceSubscriptionState
  archived_at: number | null
  available?: boolean
}

export interface MatterResourceLookupResponse {
  results: Record<string, MatterResourceLinkHit[]>
}

export interface MatterItem {
  id: number
  matter_id: number
  kind: MatterItemKind
  title: string
  description: string | null
  position: number
  status: MatterItemStatus | null
  priority: MatterPriority | null
  owner_kind: MatterActorKind | null
  owner_id: string | null
  waiting_on_stakeholder_id: number | null
  due_at: number | null
  completed_at: number | null
  checklist: MatterChecklistEntry[]
  source_resource_id: number | null
  source_locator: Record<string, unknown> | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface MatterEvent {
  id: number
  matter_id: number
  kind: string
  happened_at: number
  actor_kind: MatterActorKind
  actor_id: string | null
  source: string
  item_id: number | null
  update_id: number | null
  /** 资料类事件的对象指针。后端一直在返回（`_event_row` 是整行 dict），此前漏声明。 */
  resource_id: number | null
  /** 反向事件（撤销）指回被它抵消的那条。时间线 append-only，纠错就靠这个字段。 */
  reverses_event_id: number | null
  dedupe_key: string
  payload: Record<string, unknown>
  created_at: number
}

export interface MatterMutationResult {
  matter?: Matter | null
  event_ids?: number[]
  item?: MatterItem
  deleted?: boolean
  public_id?: string
  resource?: MatterResource
  link?: MatterResourceLink
  stakeholder?: MatterStakeholder
  warnings?: string[]
}

export interface MatterRun {
  id: number
  matter_id: number
  agent_profile_id: string | null
  trigger_kind: MatterRunTrigger
  lifecycle_state: MatterRunLifecycleState
  status: MatterRunStatus | null
  model: string | null
  usage: Record<string, unknown> | null
  cost_usd: number | null
  error: Record<string, unknown> | null
  queued_at: number
  started_at: number | null
  completed_at: number | null
  cancel_requested_at: number | null
  canceled_at: number | null
  update_id: number | null
  duration_ms: number | null
  [key: string]: unknown
}

export interface MatterRunListResponse {
  items: MatterRun[]
  next_cursor: number | null
}
export interface MatterRunStartResult {
  run: MatterRun
  coalesced: boolean
}
export interface MatterProposalSource {
  /** 已关联资源的 id。与 `change_id` 二选一（同提案新建的资源此时还没有 id）。 */
  resource_id?: number | null
  /** 引用同一份提案里 `kind: 'resource'` 的新建关联（服务端校验它确实存在且未被剔除）。 */
  change_id?: string | null
  locator?: Record<string, unknown> | null
  evidence?: string | null
}
/** 提案要**新建**关联的一份外部资料的身份（服务端归一后的产物，非模型原话）。 */
export interface MatterProposalNewResource {
  provider: string
  kind: MatterResourceKind
  external_key: string
  title?: string | null
  canonical_url?: string | null
}
export interface MatterProposalChange {
  id: string
  kind: MatterChangeKind
  target?: Record<string, unknown> | null
  /** `kind: 'resource'` 的第二形态：把这份新资料关联进事项（与 `target.id` 的确认互斥）。 */
  resource?: MatterProposalNewResource | null
  before?: unknown
  after?: unknown
  text?: string | null
  reason?: string | null
  detail?: string | null
  confidence?: number | null
  conf?: number | null
  sources?: MatterProposalSource[]
}
export interface MatterUpdateSummary {
  id: number
  review_status: MatterUpdateReviewStatus
  summary: string | null
  created_at: number
  change_count: number
  is_stale: boolean
  agent_run_id: number | null
  confidence: number | null
  anchored_matter_version: number
  created_by_kind: MatterActorKind
}
export interface MatterUpdate extends MatterUpdateSummary {
  matter_id: number
  from_event_id: number | null
  to_event_id: number | null
  original_proposal: {
    summary?: string | null
    changes?: MatterProposalChange[]
    open_questions?: string[]
    confidence?: number | null
  }
  reviewed_result: Record<string, unknown> | null
  changes: MatterProposalChange[]
  accepted_change_ids: string[] | null
  citations: MatterProposalSource[]
  stale_at: number | null
  stale_reason: string | null
}
export interface MatterUpdateListResponse {
  items: MatterUpdateSummary[]
  next_cursor: number | null
}
export interface MatterUpdateAcceptInput {
  selected_change_ids: string[]
  edited_changes?: Array<{
    change_id: string
    after?: unknown
    text?: string | null
    edit_reason?: string | null
  }>
  edited_summary?: string | null
}

export interface MatterListResponse {
  items: Matter[]
  next_cursor: string | null
}

export interface MatterDetailResponse {
  matter: Matter
  items?: MatterItem[]
  resources?: MatterResourceListItem[]
  stakeholders?: MatterStakeholder[]
  timeline?: MatterEvent[]
  updates?: unknown[]
}

export interface MatterTimelineResponse {
  items: MatterEvent[]
  next_cursor: number | null
}

export interface MatterListOptions {
  q?: string
  status?: MatterStatus
  health?: MatterHealth
  priority?: MatterPriority
  type?: string
  tag?: string
  view?: string
  archived?: boolean
  deleted?: boolean
  cursor?: string
  limit?: number
  sort?: 'updated_at' | 'created_at'
}

export interface MatterCreateInput {
  title: string
  description?: string
  matter_type?: string | null
  tags?: string[]
  status?: MatterStatus
  health?: MatterHealth
  priority?: MatterPriority
  due_at?: number | null
  waiting_context?: Record<string, unknown> | null
  source_resource?: MatterSourceResourceInput
}

// 字段集镜像后端 service.py 的 DIRECT_PATCH_FIELDS + BINDING_PATCH_FIELDS。
// priority 原本只在「接受提案」路径可写（_apply_accepted_change），手动 PATCH 不能改 ——
// 0811 dogfood 反馈「创建后优先级不能改」时把后端白名单补齐，此处同步。
export interface MatterPatchInput {
  title?: string
  description?: string
  matter_type?: string | null
  priority?: MatterPriority
  tags?: string[]
  goal_checks?: MatterGoalCheck[]
  status?: MatterStatus
  health?: MatterHealth
  current_summary?: string | null
  due_at?: number | null
  waiting_context?: Record<string, unknown> | null
  next_attention_at?: number | null
  attention_reason?: string | null
  agent_profile_id?: string | null
  agent_enabled?: boolean
  matter_instructions?: string | null
  /** 🔴 对象，不是字符串 —— 见 `MatterTriggerEnvelope` 的注释。 */
  schedule_json?: MatterTriggerEnvelope | null
}

export interface MatterItemCreateInput {
  kind: MatterItemKind
  title: string
  description?: string | null
  position?: number
  status?: MatterItemStatus | null
  priority?: MatterPriority | null
  owner_kind?: MatterActorKind | null
  owner_id?: string | null
  waiting_on_stakeholder_id?: number | null
  due_at?: number | null
  completed_at?: number | null
  checklist?: MatterChecklistEntry[]
  source_resource_id?: number | null
  source_locator?: Record<string, unknown> | null
}

export type MatterItemPatchInput = Partial<MatterItemCreateInput>

export interface MatterNoteCreateInput {
  title?: string | null
  text?: string | null
}

export interface MatterMutationOptions {
  expectedVersion?: number | null
  reason?: string | null
  source?: string
}

export interface MatterItemListOptions {
  kind?: MatterItemKind
  status?: MatterItemStatus
  includeDeleted?: boolean
}

export interface MatterResourceListOptions {
  kind?: MatterResourceKind
  pinned?: boolean
  accessPolicy?: MatterAccessPolicy
  subState?: MatterResourceSubscriptionState
  includeUnavailable?: boolean
}

export interface MatterResourceLinkInput {
  resource_id?: number
  provider?: string
  external_key?: string
  kind?: MatterResourceKind
  canonical_url?: string | null
  title?: string | null
  pinned?: boolean
  relation_type?: string | null
  sub_state?: MatterResourceSubscriptionState
  confirmed?: boolean
  source_resource?: MatterSourceResourceInput
}

export interface MatterResourcePatchInput {
  pinned?: boolean
  relation_type?: string | null
  sub_state?: MatterResourceSubscriptionState
  confirmed?: boolean
  access_policy?: MatterAccessPolicy
  scope?: 'resource'
}

export interface MatterStakeholderListOptions {
  waitingOnly?: boolean
  includeDeleted?: boolean
}

export interface MatterStakeholderCreateInput {
  person_key?: string
  display_name?: string | null
  email?: string | null
  organization?: string | null
  role?: string | null
  relationship?: string | null
  is_waiting_on?: boolean
  last_contact_at?: number | null
  source_resource_id?: number | null
}

export type MatterStakeholderPatchInput = Partial<MatterStakeholderCreateInput>

export interface MattersApi {
  list(options?: MatterListOptions): Promise<MatterListResponse>
  create(input: MatterCreateInput, options?: MatterMutationOptions): Promise<MatterMutationResult>
  createDraft(
    input: MatterCreateDraftRequest,
    signal?: AbortSignal
  ): Promise<MatterCreateDraftResponse>
  duplicateCandidates(input: MatterDuplicateCandidateInput): Promise<MatterDuplicateCandidate[]>
  listTags(): Promise<MatterTagListResponse>
  setTagStyle(
    name: string,
    input: { color: MatterTagColor; shape: MatterTagShape },
    options?: MatterMutationOptions
  ): Promise<MatterTagMutationResult>
  renameTag(
    name: string,
    nextName: string,
    options?: MatterMutationOptions
  ): Promise<MatterTagMutationResult>
  deleteTag(name: string, options?: MatterMutationOptions): Promise<MatterTagMutationResult>
  get(matterId: string, include?: string[]): Promise<MatterDetailResponse>
  patch(
    matterId: string,
    input: MatterPatchInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  archive(matterId: string, options: MatterMutationOptions): Promise<MatterMutationResult>
  reopen(matterId: string, options: MatterMutationOptions): Promise<MatterMutationResult>
  trash(matterId: string, options: MatterMutationOptions): Promise<MatterMutationResult>
  restore(matterId: string, options: MatterMutationOptions): Promise<MatterMutationResult>
  permanentDelete(
    matterId: string,
    confirmation: string,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  listItems(matterId: string, options?: MatterItemListOptions): Promise<MatterItem[]>
  createItem(
    matterId: string,
    input: MatterItemCreateInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  patchItem(
    matterId: string,
    itemId: number,
    input: MatterItemPatchInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  deleteItem(
    matterId: string,
    itemId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  restoreItem(
    matterId: string,
    itemId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  listResources(
    matterId: string,
    options?: MatterResourceListOptions
  ): Promise<MatterResourceListItem[]>
  linkResource(
    matterId: string,
    input: MatterResourceLinkInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  patchResource(
    matterId: string,
    resourceId: number,
    input: MatterResourcePatchInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  unlinkResource(
    matterId: string,
    resourceId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  restoreResource(
    matterId: string,
    resourceId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  rejectResourceSuggestion(
    matterId: string,
    resourceId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  /** 整批确认 / 整批忽略 —— 一次版本校验、一次版本推进。批里混进已处置 / 不属于本事项的
   *  id 不整批失败，各自落在返回的 `skipped` 里。 */
  bulkResolveResourceSuggestions(
    matterId: string,
    input: { action: MatterSuggestionBulkAction; resourceIds: number[] },
    options: MatterMutationOptions
  ): Promise<MatterSuggestionBulkResult>
  discoverResourceSuggestions(
    matterId: string,
    input?: { query?: string; expandReason?: MatterResourceExpansionReason; limit?: number }
  ): Promise<MatterResourceDiscoveryResult>
  listStakeholders(
    matterId: string,
    options?: MatterStakeholderListOptions
  ): Promise<MatterStakeholder[]>
  createStakeholder(
    matterId: string,
    input: MatterStakeholderCreateInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  patchStakeholder(
    matterId: string,
    stakeholderId: number,
    input: MatterStakeholderPatchInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  deleteStakeholder(
    matterId: string,
    stakeholderId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  restoreStakeholder(
    matterId: string,
    stakeholderId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  lookupResourceLinks(provider: string, keys: string[]): Promise<MatterResourceLookupResponse>
  timeline(matterId: string, cursor?: number, limit?: number): Promise<MatterTimelineResponse>
  addNote(
    matterId: string,
    input: MatterNoteCreateInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  listRuns(matterId: string): Promise<MatterRunListResponse>
  getRun(matterId: string, runId: number): Promise<MatterRun>
  startRun(matterId: string, options: MatterMutationOptions): Promise<MatterRunStartResult>
  cancelRun(matterId: string, runId: number): Promise<MatterMutationResult>
  listUpdates(
    matterId: string,
    reviewStatus?: MatterUpdateReviewStatus
  ): Promise<MatterUpdateListResponse>
  getUpdate(matterId: string, updateId: number): Promise<MatterUpdate>
  acceptUpdate(
    matterId: string,
    updateId: number,
    input: MatterUpdateAcceptInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  rejectUpdate(
    matterId: string,
    updateId: number,
    reason: string,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  listAttention(
    state?: MatterAttentionState,
    kind?: MatterAttentionKind
  ): Promise<MatterAttentionListResponse>
  listMatterAttention(
    matterId: string,
    state?: MatterAttentionState,
    kind?: MatterAttentionKind
  ): Promise<MatterAttentionListResponse>
  resolveAttention(matterId: string, signalId: number): Promise<MatterAttentionSignal>
  snoozeAttention(
    matterId: string,
    signalId: number,
    input: { preset: '3d' } | { until: number }
  ): Promise<MatterAttentionSignal>
  dismissAttention(
    matterId: string,
    signalId: number,
    reason?: string
  ): Promise<MatterAttentionSignal>
  getNotifyLevel(): Promise<MatterNotifyLevelResponse>
  setNotifyLevel(level: MatterNotifyLevel): Promise<MatterNotifyLevelResponse>
}
