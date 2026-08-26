import {
  AlertTriangle,
  Bot,
  CheckCheck,
  CircleDashed,
  ListChecks,
  ShieldAlert,
  SquarePen,
  TimerOff,
  type LucideIcon
} from 'lucide-react'

import type { AttentionAction } from '@shared/components/matters/hooks'

import type { TodayGroupId, TodayItemSource } from './todayGroups'

/**
 * 例外面的**外观**单源（图标 / 色调）。分组语义住在 `todayGroups.ts`，这里只管它长什么样。
 *
 * 🔴 导出的是**表**不是查表函数 —— eslint `react-hooks/static-components` 不接受
 * `const Icon = someFn(...)`（同 `matterProgressVocab.ts` 的先例）。
 *
 * 色调取语义色 token 的现成六档，配方照 `NotificationPanel::TONE_CLASS`（静态字面量，
 * Tailwind 扫得到；拼串 class 扫不到）。
 */
export type TodayTone = 'coral' | 'info' | 'ok' | 'warn' | 'fail' | 'neutral'

export const TODAY_TONE_CLASS: Record<TodayTone, { icon: string; chip: string }> = {
  coral: { icon: 'bg-coral/12 text-coral', chip: 'border-coral/40 bg-coral/12 text-coral' },
  info: { icon: 'bg-info/12 text-info', chip: 'border-info/40 bg-info/12 text-info' },
  ok: { icon: 'bg-ok/12 text-ok', chip: 'border-ok/40 bg-ok/12 text-ok' },
  warn: { icon: 'bg-warn/12 text-warn', chip: 'border-warn/40 bg-warn/12 text-warn' },
  fail: { icon: 'bg-fail/12 text-fail', chip: 'border-fail/40 bg-fail/12 text-fail' },
  neutral: {
    icon: 'bg-ink-fg/[0.07] text-ink-fg-3',
    chip: 'border-ink-border bg-ink-3 text-ink-fg-3'
  }
}

/** 组头图标（组的脸）。 */
export const TODAY_GROUP_ICONS: Record<TodayGroupId, LucideIcon> = {
  waiting: ShieldAlert,
  inProgress: CircleDashed,
  expired: TimerOff,
  attention: AlertTriangle,
  recent: CheckCheck
}

/** 组的色调 —— 行图标底衬按**组**上色（同一条 run 在不同组里色调不同，正是它现在
 *  的处境不同）。 */
export const TODAY_GROUP_TONE: Record<TodayGroupId, TodayTone> = {
  waiting: 'coral',
  inProgress: 'info',
  expired: 'neutral',
  attention: 'fail',
  recent: 'ok'
}

/** 行图标按**源**走（这一条是 agent 跑的、是提案、是信号，还是一次行动项派发）。 */
export const TODAY_SOURCE_ICONS: Record<TodayItemSource, LucideIcon> = {
  run: Bot,
  proposal: SquarePen,
  signal: AlertTriangle,
  dispatch: ListChecks
}

/**
 * 信号 triage 菜单的文案 —— **复用事项域既有的三条 key**，不在这里另写一套。
 *
 * 🔴 这三个词是有语义后果的（`attention.py:405-423` 的抑制律：判据型信号 resolved / dismissed
 * 都不再重开，事件型只认 dismissed）。既有文案已经按那套语义定过（「解决」/「稍后提醒
 * （3 天）」/「忽略本次」）—— 换个说法就是重新承诺一遍，很容易承诺错。
 */
export const TODAY_SIGNAL_ACTION_LABEL_KEY: Record<AttentionAction, string> = {
  resolved: 'matters.attention.resolve',
  snoozed: 'matters.attention.snooze',
  dismissed: 'matters.attention.dismiss'
}
