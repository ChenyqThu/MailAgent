// 干系人 picker 的纯逻辑（与组件分开放：`react-refresh/only-export-components`
// 不允许组件文件再导出非组件，而这段逻辑值得单测）。
//
// 通讯录 WP3（task 08-13）：原「三池组装」（本事项 metadata 推导 ∪ 全局干系人库 ∪
// 一键邮件提取）随设计 S3 单页化整体退役 —— 数据源只剩通讯录 `contactsApi.list`
// （按往来密度排序，任一锚点邮箱可搜）。这里保留角色预设/邮箱形状闸，并新增
// 单页 picker 的三个纯判据（taken 置灰 / onlyPeople 过滤 / 库外邮箱可建入）。

import type { ContactRowDto } from '@shared/api/types/contact'
import type { MatterStakeholder } from '@shared/api/types/matter'

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

/** 弹窗池的展示上限（镜像旧 `/matters/contacts` 的 limit=200 语义）：dialog 列表
 *  无虚拟滚动，1,300 行全渲染是 DOM 成本；按往来密度排序 + 服务端 q 收窄，
 *  截断的都是长尾 —— 搜即中不受影响。 */
export const PICKER_POOL_CAP = 200

/** 「已在事项中」的判据索引。🔴 人级判据是 `stakeholder.contact_id` —— 任一锚点
 *  邮箱（含曾用）在写侧都归一到同一 contact_id（`_upsert_contact`），所以对
 *  contact_id 判等即覆盖「该联系人任一邮箱命中」；email 集只兜底 contact_id 为
 *  null 的老行（v52 之前落库、或无 email 的纯本地行）。 */
export interface StakeholderTakenIndex {
  contactIds: ReadonlySet<number>
  emails: ReadonlySet<string>
}

export function buildStakeholderTakenIndex(
  stakeholders: readonly MatterStakeholder[]
): StakeholderTakenIndex {
  const contactIds = new Set<number>()
  const emails = new Set<string>()
  for (const entry of stakeholders) {
    if (entry.deleted_at != null) continue
    if (entry.contact_id != null) contactIds.add(entry.contact_id)
    else if (entry.email_normalized) emails.add(entry.email_normalized.toLowerCase())
  }
  return { contactIds, emails }
}

export function isPickerRowTaken(row: ContactRowDto, index: StakeholderTakenIndex): boolean {
  if (index.contactIds.has(row.id)) return true
  return row.primary_email != null && index.emails.has(row.primary_email.toLowerCase())
}

/** 单页 picker 的池过滤：hidden / 自己的地址恒不出现（墓碑服务端已滤，
 *  `merged_into IS NULL`）；`onlyPeople`（默认）→ 只留 kind='person'，
 *  「也显示邮件组 / 机器人」开关翻到 false 时机器人/群发列表进池。 */
export function filterPickerRows(
  rows: readonly ContactRowDto[],
  options: { onlyPeople: boolean }
): ContactRowDto[] {
  return rows.filter((row) => {
    if (row.hidden_at != null || row.is_self) return false
    return options.onlyPeople ? row.kind === 'person' : true
  })
}

/** 输入的是库里没有的邮箱 → 返回归一地址（首行出现「以这个邮箱新建联系人并添加」）。
 *  与返回行主邮箱同址时不出现 —— 那个人就在列表里，直接选即可。已知边界：若输入
 *  的是某联系人的**非主**锚点邮箱，服务端 q 会把那个人搜出来（选人即得），但行上
 *  只显示主邮箱、无从判等 ⇒ 虚线行会同时出现；经它建入时写侧 `_upsert_contact`
 *  按锚点归一到同一个人，不会产生重复联系人。 */
export function pickerManualEmail(
  search: string,
  rows: readonly ContactRowDto[]
): string | null {
  const normalized = search.trim().toLowerCase()
  if (!MATTER_STAKEHOLDER_EMAIL_RE.test(normalized)) return null
  const known = rows.some((row) => row.primary_email?.toLowerCase() === normalized)
  return known ? null : normalized
}
