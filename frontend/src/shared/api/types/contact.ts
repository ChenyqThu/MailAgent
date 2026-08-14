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
  'name_en',
  'organization',
  'department',
  'role_title',
  'phone',
  'function',
  'seniority'
] as const
export type ContactLockableField = (typeof CONTACT_LOCKABLE_FIELDS)[number]

// ---- REST payloads (src/api/routers/contacts.py) ----

export type ContactView = 'known' | 'all'
export type ContactSort = 'density' | 'recent' | 'name'
export type ContactMailRole = 'all' | 'from' | 'to' | 'cc'

/** GET /api/contacts 的行 (一条聚合 SQL 给齐, 禁逐行取数). */
export interface ContactRowDto {
  id: number
  display_name: string | null
  name_en: string | null
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
  /** WP6 画像期接真值; WP2 恒 null 占位. */
  profile_summary: string | null
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
  name_en: string | null
  organization: string | null
  role_title: string | null
  kind: ContactKind
  mail_count: number
  primary_email: string | null
}

export interface ContactDetailDto {
  id: number
  display_name: string | null
  name_en: string | null
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
  /** WP6 画像期接真值; WP2 恒 null. */
  profile: null
}

/** POST /api/contacts/resolve 的 chip 最小集 (WP4 互链: Monogram+姓名所需)。 */
export interface ContactChipDto {
  id: number
  display_name: string | null
  name_en: string | null
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
  roles: string[]
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
  name_en?: string | null
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
