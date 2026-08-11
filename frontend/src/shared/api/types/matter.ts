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

export interface MatterResourceDiscoveryResult {
  items: MatterResourceSuggestion[]
  suppressed: Array<{ external_key: string; reason: 'rejected_same_evidence' }>
  local_candidate_count: number
  expanded: boolean
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
  resource_id: number
  locator?: Record<string, unknown> | null
  evidence?: string | null
}
export interface MatterProposalChange {
  id: string
  kind: MatterChangeKind
  target?: Record<string, unknown> | null
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
  schedule_json?: string | null
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
