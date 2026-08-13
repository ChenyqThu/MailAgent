// G-16 —— 干系人候选推导（纯函数，与 Picker 组件分开放：`react-refresh/only-export-components`
// 不允许组件文件再导出非组件，而这段逻辑值得单测）。
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
