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

/** 干系人在**这件事**里的重要度（v60）。两档是有意的 —— 折叠只需要一条线。 */
export const MATTER_STAKEHOLDER_TIERS = ['core', 'normal'] as const
export type MatterStakeholderTier = (typeof MATTER_STAKEHOLDER_TIERS)[number]
/** 🔴 拿不准一律 `normal`：核心组是给 owner 一眼扫的短名单，默认进核心会让它当场失去意义。
 *  也是**读侧兜底**——旧后端不发 tier 时按它渲染。 */
export const MATTER_STAKEHOLDER_DEFAULT_TIER: MatterStakeholderTier = 'normal'

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

/**
 * curated 进展条目的叙事类型（task 08-25）。
 *
 * 🔴 与 `MATTER_ITEM_KINDS` 的 `milestone` / `decision` **同名不同物**：item 是工作对象
 * （可勾、可改状态），progress 是叙事节点（发生过的一件事，写给未来读者看）。
 * 图标 / 色调只活在 TS（`components/matters/matterProgressVocab.ts`），Python 不存样式。
 */
export const MATTER_PROGRESS_KINDS = [
  'goal',
  'milestone',
  'progress',
  'signal',
  'decision'
] as const
export type MatterProgressKind = (typeof MATTER_PROGRESS_KINDS)[number]

/** 进展条目文本上限。canonical: `src/matters/models.MATTER_PROGRESS_TITLE/BODY_MAX_CHARS`
 *  （服务端拒绝而非截断）；gateway 的 `matterProgressFields` / 提案 progress 用它当 zod max，
 *  闸 = `test_matters_contract_parity.py`（正则抽数值 + schemas.ts 的 max() 在位断言）。 */
export const MATTER_PROGRESS_TITLE_MAX_CHARS = 500
export const MATTER_PROGRESS_BODY_MAX_CHARS = 4000
/** 一条进展最多挂几条证据链引用。canonical: `src/matters/models.MATTER_PROGRESS_MAX_REFS`
 *  （REST DTO 与 `normalize_progress_refs` 都用它），同一道闸。 */
export const MATTER_PROGRESS_MAX_REFS = 20

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

// `progress`（task 08-25）= 跟进 run 对 curated 进展的唯一通道（它拿不到进展写工具）。
// 🔴 注释只能待在数组**外面**：跨语言闸的抽取器（`ts_const_string_array`）不剥注释，
// 数组体里出现非字符串字面量一律判成「部分抽取」当场红。
export const MATTER_CHANGE_KINDS = [
  'fact',
  'inference',
  'field',
  'action',
  'resource',
  'progress'
] as const
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

/** 事件型触发的可选项。**刻意小于设计稿**：只收录能映射到既有判据的项。「会议结束」
 *  自 L4 批次 1 起由 calendar_event_ended 落地（判据 = 本事项已确认的 event 资料有
 *  刚结束的 occurrence，Python 侧 `worker._calendar_ended_evidence`）。 */
export const MATTER_EVENT_TRIGGER_TYPES = [
  'calendar_event_ended',
  'resource_doc_updated',
  'resource_linked_mail'
] as const
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
/** 事项级模型覆盖（0813 dogfood 轮 3 反馈 #10），跟着同一个 envelope 走 —— 三项和触发方式
 *  同属「跟进规则」那张卡，零 DB 迁移。归一化单源 = Python `src/matters/triggers.py`。
 *
 *  🔴 三项都是**覆盖**：键缺席 = 跟随现状（绑定 profile 的 model / fallback、全局默认），
 *  不是"存一份等于默认值的快照"。唯一例外 `fallback_models: []` = **显式不设兜底**，
 *  与"没配过"不是一回事，必须能表达。
 *
 *  🔴 键名是 snake_case（与 wire 的其余部分一致），不是 TS 习惯的 camelCase。 */
export interface MatterAgentOverrides {
  model?: string
  /** `@shared/modelCatalog/effortTiers` 的 `EffortTier`；Python 侧值域有 parity 闸。 */
  effort?: string
  fallback_models?: string[]
}

export interface MatterTriggerEnvelope {
  v: number
  triggers: Record<string, unknown>[]
  actions?: MatterRunAction[]
  agent?: MatterAgentOverrides
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

/** 资料摘要来源（v56，H3§6）。canonical: `src/matters/models.MatterResourceSummarySource`；
 *  跨语言闸 `tests/matters/test_matters_contract_parity.py` TS_ARRAYS。
 *  `mail` = 沿用邮件侧 AI 摘要（不重新生成）· `agent` = 跟进 Agent 生成；
 *  无摘要 = `sum/sum_src/sum_at` 三键全 null（空态，「下次跟进运行时生成」）。 */
export const MATTER_RESOURCE_SUMMARY_SOURCES = ['mail', 'agent'] as const
export type MatterResourceSummarySource = (typeof MATTER_RESOURCE_SUMMARY_SOURCES)[number]

/** 摘要文本上限。canonical: `src/matters/models.MATTER_RESOURCE_SUMMARY_MAX_CHARS`（服务端
 *  截断而非拒绝）；gateway 的 `matterProposalNewResourceSchema.summary` 用它当 zod max，闸同上。 */
export const MATTER_RESOURCE_SUMMARY_MAX_CHARS = 2000

/** FTS 投影的字段名（`matched_fields` 的值域）。canonical: `src/matters/models.MATTER_SEARCH_FIELDS`。
 *  🔴 这里的 `description` **不是** matter 行的字段（v61 已拆成 background + goal），而是检索
 *  投影里「背景 + 目标」合成的那个文本桶 —— 有意不改名（改名要重建 fts5 虚表）。 */
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
  /** v61：背景（这件事怎么来的）与目标（做完时什么成立）是**两个独立字段**。
   *  合存单字段 + `## 背景` / `## 目标` 小标题分段的老形状已下线，别再写解析器。 */
  background: string
  goal: string
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
  /** 清单行头像组用的有界预览，**仅 `GET /matters` 产出**（详情走 `/stakeholders` 全量列）。 */
  stakeholder_summary?: MatterStakeholderSummary[]
  /** 上面那份预览截断前的总数 —— 头像组的 `+N` 靠它，别拿 `stakeholder_summary.length` 当总数。 */
  stakeholder_count?: number
  /** 清单行「下一步」的条目投影，**仅 `GET /matters` 产出**（详情有 `items` 可就地算）。
   *  `null` = 三档条目都没有；缺键 = 老后端没这个投影（两者在 `nextAction` 里同样 fail-soft）。 */
  next_action?: MatterNextActionItem | null
}

/** 清单端点的「下一步」投影（canonical: `src/matters/repository.py::list_next_action_summaries`；
 *  消费与优先级同表在 `shared/lib/matterDerive.ts::itemNextAction`）。 */
export interface MatterNextActionItem {
  kind: 'action' | 'waiting' | 'blocker'
  title: string
  due_at: number | null
}

/** 清单端点的批量干系人投影（canonical: `src/matters/repository.py::list_stakeholder_summaries`）。 */
export interface MatterStakeholderSummary {
  display_name: string | null
  email_normalized: string | null
  is_waiting_on: boolean
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
  /** 资料内容摘要三键（v56，H3§6）。wire 上恒在（后端 `dict(row)` 投影），标成可选是
   *  给存量测试 fixture 留后向兼容 —— 消费端一律按 `?? null` 读，空态 = 三键全 null。 */
  sum?: string | null
  sum_src?: MatterResourceSummarySource | null
  sum_at?: number | null
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

/** 一份**已被取代的**资料版本快照（v57 `resource_version` 行，H3§5.4）。
 *
 *  🔴 当前版本不在这个列表里 —— 它就是 `MatterResource` 自己（`revision` /
 *  `content_hash` / `sum`），面板把两者拼成完整轨迹。`sum` 是这一版当时那份摘要，
 *  留档的理由就是当前值可被覆盖、覆盖即永久丢失。 */
export interface MatterResourceVersion {
  id: number
  resource_id: number
  revision: string | null
  content_hash: string | null
  /** 这一版停止成为「当前」的时刻（= 检出到下一版那一刻）。epoch ms。 */
  superseded_at: number
  /** 被取代时「变了什么」的一句话，由跟进 Agent 在提案里写；没人写过就是 null，
   *  服务端不编。 */
  diff_text: string | null
  sum: string | null
  sum_src: MatterResourceSummarySource | null
  sum_at: number | null
}

export interface MatterResourceVersionTrail {
  /** 这类资料**会不会**有版本轨迹（服务端判据单源 `_resource_tracks_versions`）。
   *  false = 结构上不跟踪（邮件 / 会话 / 文档 / 附件），不是「还没检出过」—— 两种空态
   *  的文案不同，前端不自己按 kind 推。 */
  tracks_versions: boolean
  items: MatterResourceVersion[]
}

// `MatterResourceExpansionReason` 已随关键词命中式资料推荐整条退役（task 08-25）——
// 那条链的唯一入口是 `POST /{id}/resource-suggestions/discover`，端点、gateway 工具、
// chat 缺口卡的「外扩检索」按钮一并下线。

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
  background?: string
  goal?: string
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
  background?: string | null
  goal?: string | null
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
    /** 调研链路没有 LLM，写不出目标 —— `goal` 恒为空串，由 owner 自己补。 */
    background: string
    goal: string
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

/** G-14 tab ①「与本事项相关」的一条候选（`GET /{id}/resource-candidates`，只读）。
 *  形状 = 服务端 `_email_resource_candidates` 的候选投影，**不是** `MatterResourceListItem`
 *  —— 它还没有 link 行，`resource` 表里也可能还没有行。 */
export interface MatterResourceCandidate {
  external_key: string
  title: string | null
  metadata: {
    internal_id: number
    message_id?: string | null
    thread_id?: string | null
    date_received?: string | null
    /** 干系人候选（G-16）的来源列 —— 与 `MatterResource.metadata` 里同名键同源，见
     *  `matterStakeholderCandidates.ts` 的 `ADDRESS_KEYS`。 */
    sender?: string | null
    to_addr?: string | null
    cc_addr?: string | null
  }
  scope: 'local' | 'expanded'
  reason: string
  evidence: string[]
  confidence: number
}

export interface MatterResourceCandidateResult {
  items: MatterResourceCandidate[]
  local_candidate_count: number
}

/** G-14 tab ③：本事项已关联邮件里的一份附件（`GET /{id}/resource-attachments`，批量只读）。
 *  Q5 裁定「不做独立上传」，所以这里只有引用，没有 upload 面。 */
export interface MatterResourceAttachment {
  attachment_id: number
  internal_id: number
  filename: string
  content_type: string | null
  size_bytes: number | null
  email_subject: string | null
  email_sender: string | null
  email_date: string | null
  /** 关联后的稳定标识（`attachment:<id>`），提交时原样当 external_key 用。 */
  external_key: string
  /** 已经关联过一次了 —— 行置灰不可再选。 */
  linked: boolean
}

/** G-15 关联事项。`matter_relation` 行 + JOIN 出来的两端标题/PubId。 */
export interface MatterRelation {
  id: number
  source_matter_id: number
  target_matter_id: number
  relation_type: MatterRelationType | null
  confidence: number | null
  /** 服务端解析好的 provenance（`service._relation_row`）。用户备注挂在 `note` 上 ——
   *  `matter_relation` 没有 note 列，加列要 bump DB_VERSION，本批不动 schema。 */
  provenance: Record<string, unknown>
  provenance_json: string
  confirmed_at: number | null
  deleted_at: number | null
  created_at: number
  updated_at: number
  source_public_id: string
  source_title: string
  target_public_id: string
  target_title: string
}

export interface MatterRelationCreateInput {
  target_public_id: string
  relation_type?: MatterRelationType | null
  provenance?: Record<string, unknown>
  confirmed?: boolean
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
  /** v60 —— 在**这件事**里的重要度。`core` 一组常展开，`normal` 一组默认折叠。
   *  旧后端不发 ⇒ optional（读侧按 `normal` 兜底）。 */
  tier?: MatterStakeholderTier
  /** v60 —— 组内显示顺序（用户拖出来的）。
   *  🔴 读侧**不得** `sorted()` 覆盖服务端顺序（同 `SYNC_FOLDERS` 数组序那条纪律）。 */
  sort_order?: number
  last_contact_at: number | null
  source_resource_id: number | null
  /** W-C（v52）：全局干系人库关联。null = 无 email（没有全局身份，纯本事项行）。 */
  contact_id: number | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

// `MatterContact` / `MatterContactCandidate`（W-C 全局干系人库两个只读端点的行形状）
// 已随通讯录 WP3 退役 —— picker 改读 `@shared/api/types/contact` 的 ContactRowDto。

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

/**
 * 一条进展的证据链引用（`refs_json` 的元素）。
 *
 * 🔴 形状**有意宽松**，与服务端 `models.normalize_progress_refs` 同一条纪律：那边只校验
 * 「是对象 + `type` 非空」，把 email / resource / url 各自的键写死在这里就成了第二处契约
 * （加一种引用形态要改两边，漏改的表现是「Agent 写了但存不进去」）。渲染侧本来就得对
 * 认不出的形态兜底（存量行、未来形态）。
 */
export interface MatterProgressRef {
  type: string
  [key: string]: unknown
}

/** curated 进展条目（`matter_progress` 行，task 08-25）。`refs` 是服务端解好的数组，
 *  wire 上不出现 `refs_json`。 */
export interface MatterProgress {
  id: number
  matter_id: number
  kind: MatterProgressKind
  title: string
  body: string | null
  /** 叙事时间（这件事什么时候发生），与 `created_at`（什么时候被记下来）是两回事。epoch ms。 */
  happened_at: number
  actor_kind: MatterActorKind
  actor_id: string | null
  source: string
  refs: MatterProgressRef[]
  version: number
  deleted_at: number | null
  created_at: number
  updated_at: number
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
  progress?: MatterProgress
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
  /** 这份资料在说什么（≤3 句，H3§6）。接受时落进 `resource.sum`（`sum_src='agent'`）。
   *  邮件/会话恒为 null —— 那类沿用邮件自带摘要，服务端在归一层就把模型写的丢掉了。 */
  summary?: string | null
  /** 这一版相对上一版变了什么（一句，H3§5.4）。接受时落进版本轨迹里被取代那一版的
   *  `diff_text`；首次关联与邮件/会话恒为 null（没有上一版，无处可落）。 */
  diff?: string | null
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
/** 跨事项的待审提案聚合（`GET /api/matters/updates`）。
 *
 *  🔴 一条事项一个条目、提案是**完整**行（不是摘要）：看板待审阅卡要读 `changes`
 *  数引用条数、判有没有字段级变化。这正是它替代掉的那轮 N+1（每条事项一次
 *  `listUpdates` + 每条提案一次 `getUpdate`）存在的理由。 */
export interface MatterPendingUpdatesEntry {
  matter_public_id: string
  updates: MatterUpdate[]
}
export interface MatterPendingUpdatesResponse {
  items: MatterPendingUpdatesEntry[]
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
  /** 服务端当前 where 子句下的总行数（wire 上在 envelope 的 `meta.total`，不在 data 块 ——
   *  由 `api/matters.ts::list` 抬进返回值）。V3-07 列表头「范围总数」的唯一可信来源：
   *  列表分页截断在 100，客户端数出来的总数在超一页时是错的。老 mock / 无 meta 时缺省。 */
  total?: number | null
}

export interface MatterDetailResponse {
  matter: Matter
  items?: MatterItem[]
  /** `include=progress`。🔴 软删的条目**不在**里面（与 `items` 的 include_deleted 不同源：
   *  条目删了还要渲染成划掉的行，进展删了就是从脉络里拿掉）。 */
  progress?: MatterProgress[]
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
  background?: string
  goal?: string
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
  background?: string
  goal?: string
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

/**
 * 记一条进展。
 *
 * 🔴 `actor_kind` / `source` **不在**写面上：服务端从 mutation 信封与调用者身份盖章，
 * 调用方结构上伪造不了「这条是 Agent 写的」（REST DTO `MatterProgressCreateRequest` 同形）。
 * `happened_at` 省略 = 现在；秒值服务端恒拒不换算（matters 域全域 epoch **毫秒**）。
 */
export interface MatterProgressCreateInput {
  kind: MatterProgressKind
  title: string
  body?: string | null
  happened_at?: number | null
  refs?: MatterProgressRef[]
}

/** 编辑一条进展。`deleted_at` 有意不在写面上 —— 删除 / 恢复走各自的端点。 */
export type MatterProgressPatchInput = Partial<MatterProgressCreateInput>

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
  tier?: MatterStakeholderTier
  last_contact_at?: number | null
  source_resource_id?: number | null
}

export type MatterStakeholderPatchInput = Partial<MatterStakeholderCreateInput>

/** 一次拖拽里被移动的一行。`tier` 省略 = 不换组（纯组内重排）。 */
export interface MatterStakeholderReorderItem {
  id: number
  sort_order: number
  tier?: MatterStakeholderTier
}

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
  /** curated 进展（task 08-25）。详情页走 `get(id, ['progress'])` 一次取回，这个清单口
   *  留给需要 kind 过滤 / 软删可见的调用方。 */
  listProgress(
    matterId: string,
    options?: { kind?: MatterProgressKind; includeDeleted?: boolean; limit?: number }
  ): Promise<MatterProgress[]>
  createProgress(
    matterId: string,
    input: MatterProgressCreateInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  patchProgress(
    matterId: string,
    progressId: number,
    input: MatterProgressPatchInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  deleteProgress(
    matterId: string,
    progressId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  restoreProgress(
    matterId: string,
    progressId: number,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  listResources(
    matterId: string,
    options?: MatterResourceListOptions
  ): Promise<MatterResourceListItem[]>
  /** V3-22 资料版本轨迹：**只读历史**（当前版本在 `listResources` 给的 resource 行上）。
   *  抽屉打开时才拉 —— 列表行不需要它，挂在 listResources 上就是每份资料一次扇出。 */
  listResourceVersions(
    matterId: string,
    resourceId: number,
    options?: { limit?: number }
  ): Promise<MatterResourceVersionTrail>
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
  /** G-14 tab ①：只读候选（owner 自己挑，**不写任何东西** —— 打开「关联资料」弹窗不该在
   *  事项上留下建议行 / 事件 / 版本推进）。
   *  🔴 task 08-25 起这是唯一的确定性资料候选面：关键词命中式的「外扩检索」写面
   *  （`POST /resource-suggestions/discover`）已整条退役，资料推荐改由有 LLM 能力的 agent
   *  给出（跟进 run 的提案 `resource` change / 对话里的 `matter_resource_mutate`）。 */
  listResourceCandidates(
    matterId: string,
    options?: { limit?: number }
  ): Promise<MatterResourceCandidateResult>
  /** G-14 tab ③：已关联邮件的附件，**一次批量**（禁逐封扇出，ARCHITECTURE §7.1）。 */
  listResourceAttachments(
    matterId: string,
    options?: { limit?: number }
  ): Promise<MatterResourceAttachment[]>
  listRelations(
    matterId: string,
    options?: { direction?: 'both' | 'outgoing' | 'incoming' }
  ): Promise<MatterRelation[]>
  createRelation(
    matterId: string,
    input: MatterRelationCreateInput,
    options: MatterMutationOptions
  ): Promise<MatterMutationResult>
  deleteRelation(
    matterId: string,
    relationId: number,
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
  /** 整批重排 / 换组。🔴 一次拖拽发**一个**请求 —— 逐条 patch 的话第 2 个必撞版本冲突。 */
  reorderStakeholders(
    matterId: string,
    items: readonly MatterStakeholderReorderItem[],
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
  listPendingUpdates(): Promise<MatterPendingUpdatesResponse>
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
