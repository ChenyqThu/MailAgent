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

export const MATTER_CHANGE_KINDS = ['fact', 'inference', 'field', 'action', 'resource'] as const
export type MatterChangeKind = (typeof MATTER_CHANGE_KINDS)[number]

export const MATTER_RUN_STATUSES = ['ok', 'noop', 'warn', 'fail'] as const
export type MatterRunStatus = (typeof MATTER_RUN_STATUSES)[number]

export const MATTER_RUN_TRIGGERS = ['manual', 'schedule'] as const
export type MatterRunTrigger = (typeof MATTER_RUN_TRIGGERS)[number]

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
  kind: MatterAttentionKind
  state: MatterAttentionState
  severity?: 'critical' | 'warning' | 'info'
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

export interface MatterPatchInput {
  title?: string
  description?: string
  matter_type?: string | null
  tags?: string[]
  status?: MatterStatus
  health?: MatterHealth
  current_summary?: string | null
  due_at?: number | null
  waiting_context?: Record<string, unknown> | null
  next_attention_at?: number | null
  attention_reason?: string | null
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
}
