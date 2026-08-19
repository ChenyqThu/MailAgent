// Canonical source: src/contacts/taxonomy.py (contact 表 CHECK 值域 + 可锁字段词表).
// Cross-language drift gate: tests/config/test_contact_enum_parity.py.

export const CONTACT_KIND_VALUES = ['person', 'robot', 'list'] as const
export type ContactKind = (typeof CONTACT_KIND_VALUES)[number]

export const CONTACT_FUNCTION_VALUES = [
  'tech',
  'product',
  'delivery',
  'legal',
  'compliance',
  'procurement',
  'data',
  'security',
  'pm',
  'maillist',
  'system'
] as const
export type ContactFunction = (typeof CONTACT_FUNCTION_VALUES)[number]

export const CONTACT_SENIORITY_VALUES = ['vp', 'director', 'lead', 'manager', 'staff'] as const
export type ContactSeniority = (typeof CONTACT_SENIORITY_VALUES)[number]

export const CONTACT_LOCKABLE_FIELDS = [
  'display_name',
  'formal_name',
  'organization',
  'department',
  'role_title',
  'phone',
  'function',
  'seniority'
] as const
export type ContactLockableField = (typeof CONTACT_LOCKABLE_FIELDS)[number]

export const CONTACT_SUGGESTION_TYPE_VALUES = ['merge', 'identity', 'former_email', 'relation', 'kind'] as const
export const CONTACT_SUGGESTION_STATUS_VALUES = ['pending', 'adopted', 'ignored', 'blocked'] as const

// ---- REST payloads (src/api/routers/contacts.py) ----

export type ContactView = 'known' | 'all'
export type ContactSort = 'density' | 'recent' | 'name'

/** 关联邮件的 tab 轴（task 08-14 WP-5，取代老 role 轴）。判据在后端算，见
 *  `src/api/routers/contacts.py::_direction_expr`。`cc` 不再占 tab 轴 ——
 *  「谁发的」与「to/cc」是正交两维，后者降级为行内次要标记。 */
export const CONTACT_MAIL_DIRECTIONS = ['all', 'from_them', 'from_me', 'from_third'] as const
export type ContactMailDirection = (typeof CONTACT_MAIL_DIRECTIONS)[number]
/** 单封邮件的实际方向（三类互斥；`all` 只是「不过滤」，不是一封邮件的取值）。 */
export type ContactMailDirectionValue = Exclude<ContactMailDirection, 'all'>

/** GET /api/contacts 的行 (一条聚合 SQL 给齐, 禁逐行取数). */
export interface ContactRowDto {
  id: number
  display_name: string | null
  formal_name: string | null
  organization: string | null
  department: string | null
  role_title: string | null
  function: ContactFunction | null
  seniority: ContactSeniority | null
  kind: ContactKind
  hidden_at: number | null
  is_self: boolean
  mail_count: number
  sent_to_count: number
  first_seen_at: number | null
  last_seen_at: number | null
  email_count: number
  primary_email: string | null
  /** WP5 汇报线: 上级 id + 显示名 (分组 label / 行菜单「写邮件并抄送上级」可用性). */
  manager_contact_id: number | null
  manager_display_name: string | null
  /** WP6 画像摘要 (后端已单行截断)。 */
  profile_summary: string | null
  /** WP6 画像阈值 (🔒 §4.4 单一来源: 文案禁写死 50)。 */
  profile_min: number
  /** WP6 该行是否够格生成画像 (未隐藏 + person + 达阈值 + 至少发出过 1 封)。 */
  profile_eligible: boolean
}

export interface ContactListResponse {
  items: ContactRowDto[]
  total: number
}

export interface ContactEmailDto {
  address: string
  is_primary: boolean
  former_at: number | null
  mail_count: number
  first_seen_at: number | null
  last_seen_at: number | null
}

/** 组织关系投影的人物行 (裁决 4 最小集 + primary_email/kind —— Monogram 色相
 *  锚点 = 主邮箱 (D10), 分区头「写邮件并抄送上级」需要上级主邮箱)。 */
export interface ContactRelPersonDto {
  id: number
  display_name: string | null
  formal_name: string | null
  organization: string | null
  role_title: string | null
  kind: ContactKind
  mail_count: number
  primary_email: string | null
}

export interface ContactDetailDto {
  id: number
  display_name: string | null
  formal_name: string | null
  organization: string | null
  department: string | null
  role_title: string | null
  function: ContactFunction | null
  seniority: ContactSeniority | null
  kind: ContactKind
  kind_locked_at: number | null
  is_self: boolean
  hidden_at: number | null
  merged_into: number | null
  notes: string | null
  phone: string | null
  contact_info: Record<string, unknown>
  name_variants: string[]
  identity_locks: Partial<Record<ContactLockableField, number>>
  mail_count: number
  sent_to_count: number
  first_seen_at: number | null
  last_seen_at: number | null
  created_at: number
  updated_at: number
  emails: ContactEmailDto[]
  /** WP5 组织关系 (设计 §2.2.1, 🔒 只存一侧): manager 单行 / reports 反查 /
   *  peers 同组织派生前 6。manager_src='auto' 是 WP6 的 AI 标记结构位 ——
   *  WP5 REST 面恒写 'manual'. */
  manager: ContactRelPersonDto | null
  manager_src: 'manual' | 'auto' | null
  reports: ContactRelPersonDto[]
  peers: ContactRelPersonDto[]
  /** WP6 画像投影 (`src/contacts/profile.py::profile_projection`)。 */
  profile: ContactProfileDto
}

// ---- WP6 画像 (canonical: src/contacts/profile.py + profile_prompts.py::PROFILE_TOOL_SCHEMA) ----

/** 画像文档里的一条轨迹 (D5)。`at` 后端保证 `^\d{4}-\d{2}$`;
 *  `ev` = 证据邮件的 internal_id (可 null —— 模型没给出处时)。 */
export interface ContactProfileEvolutionItem {
  at: string
  text: string
  ev: number | null
}

/** 证据窗。🔴 `from`/`to` 是 **internal_id 整数**不是月份串 —— 与 `evolution[].ev`
 *  同一坐标系 (原型 mock 里的 '2026-06' 是演示内容, 不作数)。0 封新证据的增量轮
 *  两端都可能是 null。 */
export interface ContactProfileEvidenceWindow {
  from: number | null
  to: number | null
  mail_count: number
  mode: 'first' | 'incremental'
}

/** 画像正文文档 (`profile_json` 列)。🔒 全部字段纯文本渲染, 不解析 markdown/HTML。 */
export interface ContactProfileDocument {
  summary: string
  role_title: string | null
  formal_name: string | null
  department: string | null
  topics: string[]
  projects: string[]
  communication_style: string | null
  contact_info: { phone?: string | null }
  evolution: ContactProfileEvolutionItem[]
  /** 🔴 是 `string[]` 不是 `{text}[]` (schema: `array of string`)。 */
  contradictions: string[]
  evidence_window: ContactProfileEvidenceWindow
}

/** 可采纳的建议字段 —— 后端 `PROFILE_SUGGESTION_FIELDS`
 *  (`src/api/routers/contacts.py`) 的三值, adopt/ignore 的 body 只收这三个。 */
export const CONTACT_PROFILE_SUGGESTION_FIELDS = ['formal_name', 'department', 'phone'] as const
export type ContactProfileSuggestionField = (typeof CONTACT_PROFILE_SUGGESTION_FIELDS)[number]

export interface ContactProfileSuggestion {
  field: ContactProfileSuggestionField
  value: string
}

/** 画像派生态 (后端算, 前端只消费):
 *  `unconfigured` = 总闸或 agent 行未开 / `below_threshold` = 往来不足
 *  `pending_batch` = 够格但批处理没跑到 / `ok` / `skipped` = 模型判证据不足
 *  `failed` / `running`。 */
export type ContactProfileStatus =
  | 'unconfigured'
  | 'below_threshold'
  | 'pending_batch'
  | 'ok'
  | 'skipped'
  | 'failed'
  | 'running'

/** `profile_status` 列的原始值 (未派生; 无行时 null)。 */
export type ContactProfileRawStatus = 'ok' | 'skipped' | 'failed' | 'running' | null

export interface ContactProfileDto {
  document: ContactProfileDocument | null
  /** `document` 的同物别名 (后端两个键指同一个对象)。 */
  profile_json: ContactProfileDocument | null
  profile_updated_at: number | null
  profile_mail_count: number | null
  profile_model: string | null
  profile_status: ContactProfileRawStatus
  profile_attempted_at: number | null
  profile_error: string | null
  /** skipped 态「已读过 n 封」的取数口径。 */
  attempted_mail_count: number | null
  status: ContactProfileStatus
  /** 🔒 §4.4 单一来源: 阈值文案读这里, 前端禁写死 50。 */
  profile_min: number
  eligible: boolean
  needed_mail_count: number
  suggestions: ContactProfileSuggestion[]
}

/** POST /api/contacts/resolve 的 chip 最小集 (WP4 互链: Monogram+姓名所需)。 */
export interface ContactChipDto {
  id: number
  display_name: string | null
  formal_name: string | null
  kind: ContactKind
  primary_email: string | null
}

/** 键 = 请求里的原输入串; null = 不在库 (或非法形状)。 */
export interface ContactResolveResponse {
  items: Record<string, ContactChipDto | null>
}

export interface ContactMailDto {
  internal_id: number
  subject: string | null
  sender: string | null
  sender_name: string | null
  mailbox: string | null
  date_received: string | null
  is_read: boolean
  seen_at: number | null
  /** 账本角色（sender / to / cc）。方向轴之外只用来出「抄送」次要标记。 */
  roles: string[]
  direction: ContactMailDirectionValue
}

export interface ContactMailsResponse {
  items: ContactMailDto[]
  next_cursor: string | null
  total: number
}

export interface ContactMatterDto {
  matter_id: number
  public_id: string
  title: string
  status: string
  role: string | null
  archived_at: number | null
}

export interface ContactMattersResponse {
  items: ContactMatterDto[]
}

export interface ContactBackfillProgress {
  scanned: number
  total: number
  drained: boolean
}

/** PATCH /api/contacts/{id} body (显式出现的键才会被写入并落锁; notes 无锁). */
export interface ContactPatchBody {
  display_name?: string | null
  formal_name?: string | null
  organization?: string | null
  department?: string | null
  role_title?: string | null
  phone?: string | null
  notes?: string | null
  function?: ContactFunction | null
  seniority?: ContactSeniority | null
}

export interface ContactPatchResponse {
  fields: Partial<Record<string, string | null>>
  locks: Partial<Record<ContactLockableField, number>>
  contact: ContactDetailDto
}

/** POST /api/contacts/{winner}/merge body (WP3)。主邮箱/曾用 = 预览页勾选结果
 *  (默认值推导在前端 `mergeModel.ts`, 服务端只按入参落库)。 */
export interface ContactMergeBody {
  loser_id: number
  primary_email: string
  former_emails: string[]
}

// ---- WP7 治理建议队列 (src/contacts/governance.py) ----

export type ContactSuggestionType = (typeof CONTACT_SUGGESTION_TYPE_VALUES)[number]
export type ContactSuggestionStatus = (typeof CONTACT_SUGGESTION_STATUS_VALUES)[number]

/** 一条邮件证据。`message_id` 是 RFC Message-ID (服务端 `validate_evidence` 已确认它
 *  真的落在 `email_metadata` 里); `quote` 是 LLM 摘的一句原文 (截断 500)。 */
export interface ContactSuggestionEvidence {
  message_id: string
  quote: string
}

/** 🔴 类型名不叫 `ContactSuggestion` —— 那个名字已被 compose 收件人补全占用
 *  (`electron/main/handlers/contacts.ts`)。Python 侧同名 TypedDict 也是
 *  `ContactGovernanceSuggestion`。
 *
 *  `payload` 的形状按 `type` 分叉 (governance.py 的 propose 落库口):
 *    identity     `{ field, value }`
 *    former_email `{ email }`
 *    relation     `{ manager_id: number | null }`
 *    kind         `{ kind }`
 *    merge        `{ winner_contact_id, loser_contact_id }`
 *  外加一个跨类型可选键 `reason` —— 模型写的一句「为什么」(propose 三工具的
 *  `reasonField`, ≤300 字)。🔴 **没有** `text` 键: 建议卡的**结论句**由前端按
 *  type + payload 用 i18n 模板拼 (确定性), 只有 `reason` 是模型散文, 按 LLM 产物
 *  纯文本渲染。 */
export interface ContactGovernanceSuggestion {
  id: number
  type: ContactSuggestionType
  contact_ids: number[]
  payload: Record<string, unknown>
  evidence: ContactSuggestionEvidence[]
  confidence: number | null
  status: ContactSuggestionStatus
  /** blocked 行的原因, 形如 `"E_FIELD_LOCKED: identity field is locked: department"`。 */
  block_reason: string | null
  created_at: number
  decided_at: number | null
}

/** GET /api/contacts/suggestions。keyset 游标 `"<created_at>:<id>"`。 */
export interface ContactSuggestionListResponse {
  items: ContactGovernanceSuggestion[]
  next_cursor: string | null
}

/** POST /api/contacts/suggestions/{id}/adopt 的成功载荷。`merge_pair` 只在 merge 类
 *  出现 —— 服务端**不**执行合并, 只把这条标 adopted 并把两个 id 交回来给合并预览
 *  (升序归一, 不是 winner-first)。 */
export interface ContactSuggestionAdoptResult {
  id: number
  status: 'adopted'
  decided_at: number
  merge_pair?: number[]
}

export interface ContactSuggestionIgnoreResult {
  id: number
  status: 'ignored'
  decided_at: number
}

/** POST /api/contacts/agent/run —— 只入队, 不等结果。`coalesced` = 已有一轮
 *  queued/running, 复用了它。 */
export interface ContactAgentRunResult {
  job_id: number
  status: string
  created: boolean
  coalesced: boolean
}

/** GET /api/contacts/agent/status —— 胶囊徽标 + 抽屉脚的数据源 (一个端点拿全)。 */
export interface ContactAgentStatus {
  enabled: boolean
  pending_count: number
  /** 每日 due marker (`YYYY-MM-DD`), 从没跑过 → null。 */
  last_fire_day: string | null
  /** 最近一次治理 job 的入队时间 (epoch 秒), 从没跑过 → null。 */
  last_scan_at: number | null
}
