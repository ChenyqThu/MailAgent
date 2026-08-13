// G-16 —— 干系人候选推导（纯函数，与 Picker 组件分开放：`react-refresh/only-export-components`
// 不允许组件文件再导出非组件，而这段逻辑值得单测）。
//
// 🔴 候选**不打任何新请求**：`MatterResourceListItem.resource.metadata` 里已经有邮件的
// 发件人/收件人（`_resolve_source_resource` 与候选引擎写进去的），ContextTab 本来就持有这份
// 资料列表；扇出去逐封查邮件才是列表性能铁律禁止的那种写法。
// 代价（有意接受）：metadata 里没有地址的老资料行推不出人来，此时候选列为空，由「按邮箱新建」
// 手输入口兜底 —— 不做「看起来有候选其实是编的」。

import type { MatterResourceListItem, MatterStakeholder } from '@shared/api/types/matter'

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

/** 资料 metadata 里可能装地址的键。email 资料由后端写 `sender`；会议类资料写 `organizer`。 */
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
