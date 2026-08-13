import {
  Activity,
  ArrowDown,
  ArrowUp,
  Ban,
  Calendar,
  CheckCircle2,
  Eye,
  FileText,
  Gavel,
  HelpCircle,
  History,
  Hourglass,
  Inbox,
  Layers,
  ListChecks,
  Milestone,
  Minus,
  Play,
  Target,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-react'

import type {
  MatterHealth,
  MatterItemKind,
  MatterItemStatus,
  MatterPriority,
  MatterStatus
} from '@shared/api/types/matter'

/**
 * 事项词表的**外观**单源：status / health / priority / 详情 tab 各自的 icon 与 tone。
 *
 * 🔴 为什么单独一个文件：这几张表要在详情头、列表、焦点页三处用，抄第二份就会漂
 * （0812 dogfood 实测：视图轨 12 项里 7 项、资源 kind 6 项里 4 项与原型不符）。
 * 逐项对照设计原型 `helpers.jsx` 的 `MATTER_STATUS` / `HEALTH` / `PRIORITY` 与
 * `detail.jsx` 的 `DETAIL_TABS`，右侧注释是原型写的语义名。对照关系有闸：
 * `tests/components/matters/matterDesignIcons.test.ts`。
 *
 * 🔴 导出的是**表**不是查表函数 —— eslint `react-hooks/static-components` 不接受
 * `const Icon = someFn(...)`（调用表达式证明不了每次 render 返回同一个组件身份），
 * 成员索引 `MAP[key]` 可以。同 `matterResource.ts` 的先例。
 */

/** 设计 `helpers.jsx` 的 TONE_VAR 值域（neutral/info/success/warn/critical）。 */
export type MatterTone = 'neutral' | 'info' | 'success' | 'warn' | 'critical'

export const MATTER_STATUS_ICONS: Record<MatterStatus, LucideIcon> = {
  inbox: Inbox, // inbox
  planned: Calendar, // calendar
  active: Play, // play
  waiting: Hourglass, // hourglass
  blocked: Ban, // ban
  monitoring: Eye, // eye
  done: CheckCircle2, // checkcircle
  canceled: X // x
}

export const MATTER_STATUS_TONES: Record<MatterStatus, MatterTone> = {
  inbox: 'neutral',
  planned: 'info',
  active: 'success',
  waiting: 'warn',
  blocked: 'critical',
  monitoring: 'info',
  done: 'success',
  canceled: 'neutral'
}

export const MATTER_HEALTH_ICONS: Record<MatterHealth, LucideIcon> = {
  unknown: Minus, // minus
  on_track: ArrowUp, // arrowup
  at_risk: TriangleAlert, // alert
  off_track: ArrowDown // arrowdown
}

/** 设计 HEALTH[x].color：unknown=--ink-fg-3 / on_track=--c-ok / at_risk=--c-warn / off_track=--c-crit。 */
export const MATTER_HEALTH_TEXT_CLASS: Record<MatterHealth, string> = {
  unknown: 'text-ink-fg-3',
  on_track: 'text-ok',
  at_risk: 'text-warn',
  off_track: 'text-crit'
}

/**
 * 条目类型的 icon（设计 `helpers.jsx` 的 `ITEM_KIND[*].icon`）—— D8：状态 tab 的六个分节
 * 此前是**裸标题、一个 icon 都没有**，设计里每节标签前都带本类型的符号。
 *
 * `note` 取 `FileText`：设计的 `note` path 画的就是「带折角与横线的文档」
 * （helpers.jsx:60），不是便签。与 `RESOURCE_KIND_ICONS.doc` 同符号但分属两张表。
 */
export const MATTER_ITEM_KIND_ICONS: Record<MatterItemKind, LucideIcon> = {
  action: ListChecks, // listcheck
  milestone: Milestone, // milestone
  decision: Gavel, // gavel
  blocker: Ban, // ban
  question: HelpCircle, // helpcircle
  note: FileText // note
}

/** 设计 `ITEM_KIND[*].color`：action=--c-accent / milestone=--c-info / decision=--c-ai /
 *  blocker=--c-crit / question=--c-warn / note=--ink-fg-2。 */
export const MATTER_ITEM_KIND_TEXT_CLASS: Record<MatterItemKind, string> = {
  action: 'text-coral',
  milestone: 'text-info',
  decision: 'text-ai',
  blocker: 'text-crit',
  question: 'text-warn',
  note: 'text-ink-fg-2'
}

/** 设计 `detail.jsx` 的 `ITEM_STATUS[*].tone`（done/canceled 在行内不出 Pip，仍给全值域）。 */
export const MATTER_ITEM_STATUS_TONES: Record<MatterItemStatus, MatterTone> = {
  open: 'neutral',
  in_progress: 'info',
  waiting: 'warn',
  blocked: 'critical',
  done: 'success',
  canceled: 'neutral'
}

export const MATTER_PRIORITY_TONES: Record<MatterPriority, MatterTone> = {
  p0: 'critical',
  p1: 'warn',
  p2: 'neutral',
  p3: 'neutral'
}

export type MatterDetailTab = 'state' | 'context' | 'timeline' | 'runs'

export const MATTER_DETAIL_TAB_ICONS: Record<MatterDetailTab, LucideIcon> = {
  state: Target, // target
  context: Layers, // layers
  timeline: History, // history
  runs: Activity // activity
}

/**
 * Pip 形态（底 12% + 边 25%），对应设计 `ui.jsx` 的 `Pip`。
 *
 * 🔴 底色带 `!`：这两张 chip 挂在 shadcn `SelectTrigger` 上，而它自带 authored 类
 * `.input-surface`（index.css 里写在 `@tailwind utilities` **之后**且不在任何 layer 里，
 * 故必胜 utilities）会把背景刷成输入框底色。不加 `!` 的话 tone 色的底根本不出现 ——
 * 8 档状态仍然长得一模一样，正是这次要修的病。先例见 RecipientField 的 `!bg-ink-3`。
 */
export const MATTER_TONE_CHIP_CLASS: Record<MatterTone, string> = {
  neutral: 'border-ink-border !bg-ink-fg/[0.05] text-ink-fg-1',
  info: 'border-info/25 !bg-info/[0.12] text-info',
  success: 'border-ok/25 !bg-ok/[0.12] text-ok',
  warn: 'border-warn/25 !bg-warn/[0.12] text-warn',
  critical: 'border-crit/25 !bg-crit/[0.12] text-crit'
}

export const MATTER_TONE_TEXT_CLASS: Record<MatterTone, string> = {
  neutral: 'text-ink-fg-2',
  info: 'text-info',
  success: 'text-ok',
  warn: 'text-warn',
  critical: 'text-crit'
}

/** 透明底 + tone 色描边（设计 `DueButton`：`border: 1px solid alpha(c, 0.3)`）。 */
export const MATTER_TONE_OUTLINE_CLASS: Record<MatterTone, string> = {
  neutral: 'border-ink-border text-ink-fg-2',
  info: 'border-info/30 text-info',
  success: 'border-ok/30 text-ok',
  warn: 'border-warn/30 text-warn',
  critical: 'border-crit/30 text-crit'
}

export const MATTER_TONE_DOT_CLASS: Record<MatterTone, string> = {
  neutral: 'bg-ink-fg-3',
  info: 'bg-info',
  success: 'bg-ok',
  warn: 'bg-warn',
  critical: 'bg-crit'
}

/**
 * 截止时间的 tone（设计 `helpers.jsx::fmtDue`）：今天/逾期=critical、明天与三天内=warn、
 * 其余=neutral。**只取 tone 不取文案** —— 文案仍走既有 locale 的「截止 {date}」，
 * 不在这一批里发明五种新句式。
 */
export function matterDueTone(dueAt: number | null, now: number): MatterTone | null {
  if (dueAt == null) return null
  const startOfDay = (value: number): number => {
    const date = new Date(value)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / 86_400_000)
  if (days <= 0) return 'critical'
  if (days <= 3) return 'warn'
  return 'neutral'
}
