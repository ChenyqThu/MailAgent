// G-16 + W-C —— 干系人候选推导与三分组池（纯函数，与 Picker 组件分开放：
// `react-refresh/only-export-components` 不允许组件文件再导出非组件，而这段逻辑值得单测）。
//
// dogfood 轮 2（W-C）：前轮裁决 #21「不建 person 表」被 owner 反馈推翻 —— v52 起
// `matter_contact` 是真表（全局一份），Picker 的池 = 本组推导 ∪ 联系人库 ∪ 邮件提取。
//
// 🔴 候选**不打任何新请求**：`MatterResourceListItem.resource.metadata` 里带着邮件的
// 发件人/收件人，ContextTab 本来就持有这份资料列表；扇出去逐封查邮件才是列表性能铁律禁止的
// 那种写法。
//
// 🔴 生产者只有两处，都在 `src/matters/service.py`：`_resolve_source_resource`（手动/捕获关联）
// 与 `_email_resource_candidates::build_candidate`（Agent 建议）。这三个地址键是 2a review
// 之后才补进去的 —— 在那之前两处都只写 internal_id/message_id/thread_id/date_received，
// 于是这份候选列在生产上**恒空**（不是「只有老资料推不出」）。
// 现在的准确边界：**批次 2a review 修复之前落库的存量 resource 行一律推不出人**（metadata 是
// 关联那一刻的快照，后端不回填），新关联/新建议的行才有地址。存量事项上候选列仍会空，由
// 「按邮箱新建」手输入口兜底 —— 不做「看起来有候选其实是编的」。

import type {
  MatterContact,
  MatterContactCandidate,
  MatterResourceListItem,
  MatterStakeholder
} from '@shared/api/types/matter'

/** 角色预设 —— 6 档，与设计 §2.21 对齐。值走 i18n，落库存译文（`role` 是自由文本列）。 */
export const MATTER_STAKEHOLDER_ROLE_PRESETS = [
  'decisionMaker',
  'approver',
  'executor',
  'informed',
  'external',
  'other'
] as const
export type MatterStakeholderRolePreset = (typeof MATTER_STAKEHOLDER_ROLE_PRESETS)[number]

export const MATTER_STAKEHOLDER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface MatterStakeholderCandidate {
  email: string
  displayName: string | null
}

/** 资料 metadata 里可能装地址的键。
 *  🔴 后端**实际产出**的只有前三个（`sender` / `to_addr` / `cc_addr`，两处 email_spec 逐字
 *  对齐）。`from` / `organizer` / `attendees` 目前**没有任何生产路径** —— 保留是为了将来接
 *  会议类资料时不用再动这里，不是「已经在用」。改后端那两处 metadata 时同步这份清单。 */
const ADDRESS_KEYS = ['sender', 'from', 'to_addr', 'cc_addr', 'organizer', 'attendees'] as const

/** 从一行 `Foo Bar <a@b.com>, c@d.com` 里挖出地址与显示名。 */
export function parseAddressList(raw: string): MatterStakeholderCandidate[] {
  const out: MatterStakeholderCandidate[] = []
  for (const chunk of raw.split(/[,;]/)) {
    const part = chunk.trim()
    if (!part) continue
    const angled = /<([^>]+)>/.exec(part)
    const email = (angled ? angled[1] : part).trim().toLowerCase()
    if (!MATTER_STAKEHOLDER_EMAIL_RE.test(email)) continue
    const name = angled
      ? part
          .slice(0, angled.index)
          .trim()
          .replace(/^["']|["']$/g, '')
      : ''
    out.push({ email, displayName: name || null })
  }
  return out
}

/** 已关联资料的 metadata → 「本事项往来里出现过」的人。已经是干系人的剔掉。 */
export function deriveStakeholderCandidates(
  resources: readonly MatterResourceListItem[],
  stakeholders: readonly MatterStakeholder[]
): MatterStakeholderCandidate[] {
  const taken = new Set(
    stakeholders
      .map((entry) => entry.email_normalized?.toLowerCase())
      .filter((value): value is string => Boolean(value))
  )
  const byEmail = new Map<string, MatterStakeholderCandidate>()
  for (const item of resources) {
    const metadata = item.resource.metadata ?? {}
    for (const key of ADDRESS_KEYS) {
      const value = metadata[key]
      const raw = Array.isArray(value) ? value.join(',') : value
      if (typeof raw !== 'string' || !raw.trim()) continue
      for (const person of parseAddressList(raw)) {
        if (taken.has(person.email)) continue
        const existing = byEmail.get(person.email)
        // 先到者为准，但补一个缺失的显示名。
        if (!existing) byEmail.set(person.email, person)
        else if (!existing.displayName && person.displayName)
          byEmail.set(person.email, { ...existing, displayName: person.displayName })
      }
    }
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
}

// ---- W-C 三分组池（dogfood 轮 2）------------------------------------------
// 设计 §2.21 的第一步三组：「本事项往来里出现过」→「联系人库」→ 邮件提取。
// 这里只做**纯合并/去重**（分组互斥、已是干系人的剔掉、跨组信息补全），
// 数据获取归 Picker（联系人库一次批量取、提取一键触发 —— 不逐行发请求）。

export type MatterStakeholderPoolSource = 'matter' | 'library' | 'email_scan'

export interface MatterStakeholderPoolPerson {
  email: string
  displayName: string | null
  organization: string | null
  source: MatterStakeholderPoolSource
  /** 「N 个事项」——仅库条目有。 */
  matterCount: number | null
  /** 「往来 N 封」——仅邮件提取条目有。 */
  mailCount: number | null
  lastSeenAt: number | null
}

export interface MatterStakeholderPools {
  fromMatter: MatterStakeholderPoolPerson[]
  library: MatterStakeholderPoolPerson[]
  extracted: MatterStakeholderPoolPerson[]
}

/** 三组互斥合并：本事项往来 > 联系人库 > 邮件提取（先到组独占，后组只补显示名/组织）。 */
export function buildStakeholderPickerPools(
  derived: readonly MatterStakeholderCandidate[],
  contacts: readonly MatterContact[],
  extracted: readonly MatterContactCandidate[],
  stakeholders: readonly MatterStakeholder[]
): MatterStakeholderPools {
  const taken = new Set(
    stakeholders
      .map((entry) => entry.email_normalized?.toLowerCase())
      .filter((value): value is string => Boolean(value))
  )
  const contactByEmail = new Map(contacts.map((entry) => [entry.email_normalized, entry]))
  const seen = new Set<string>()

  const fromMatter: MatterStakeholderPoolPerson[] = []
  for (const person of derived) {
    if (taken.has(person.email) || seen.has(person.email)) continue
    seen.add(person.email)
    const contact = contactByEmail.get(person.email)
    fromMatter.push({
      email: person.email,
      // 库里的名字是「全局一份」，优先于邮件头里解析出来的
      displayName: contact?.display_name ?? person.displayName,
      organization: contact?.organization ?? null,
      source: 'matter',
      matterCount: contact?.matter_count ?? null,
      mailCount: null,
      lastSeenAt: contact?.last_contact_at ?? null
    })
  }

  const library: MatterStakeholderPoolPerson[] = []
  for (const contact of contacts) {
    const email = contact.email_normalized
    if (taken.has(email) || seen.has(email)) continue
    seen.add(email)
    library.push({
      email,
      displayName: contact.display_name,
      organization: contact.organization,
      source: 'library',
      matterCount: contact.matter_count,
      mailCount: null,
      lastSeenAt: contact.last_contact_at
    })
  }

  const extractedPool: MatterStakeholderPoolPerson[] = []
  for (const candidate of extracted) {
    const email = candidate.email.toLowerCase()
    if (taken.has(email) || seen.has(email)) continue
    seen.add(email)
    extractedPool.push({
      email,
      displayName: candidate.display_name,
      organization: null,
      source: 'email_scan',
      matterCount: null,
      mailCount: candidate.mail_count,
      lastSeenAt: candidate.last_seen_at
    })
  }

  return { fromMatter, library, extracted: extractedPool }
}

/** Picker 搜索框的组内过滤（邮箱 / 姓名 / 组织，大小写不敏感）。 */
export function filterStakeholderPool(
  pool: readonly MatterStakeholderPoolPerson[],
  search: string
): MatterStakeholderPoolPerson[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return [...pool]
  return pool.filter(
    (person) =>
      person.email.includes(needle) ||
      (person.displayName ?? '').toLowerCase().includes(needle) ||
      (person.organization ?? '').toLowerCase().includes(needle)
  )
}
