// 活的排程句子 —— 上游组件的核心价值之一，i18n 化到中英双语。
//
// 结构：`[频率短语] [目标短语?] [时刻短语]`。中英**语序恰好一致**，故不需要按语言分支排序：
//   en  Every 2 weeks · on Tuesday and Thursday · at 9:00 AM
//   zh  每 2 周      · 周二和周四            · 09:00
// 「1 = 特殊说法」（每天 / Every day，而非「每 1 天」）用**显式 key**（…1 / …N）表达，
// 不走 ICU plural —— 这不是语法复数，是措辞差异，中文根本没有 plural 分支。
//
// 词级 morph 动画要求把句子切成 token：按空白切即可。英文天然分词；中文短语里
// 「每 2 周」自带空格 → 3 token，「周二和周四」→ 1 token。粒度随语言自然落，够用。

import type { ScheduleRule } from './types'

/** 最小化的 t 签名，避免把 i18next 的 TFunction 泛型拖进纯逻辑模块。 */
export type Translate = (key: string, opts?: Record<string, unknown>) => string

export interface SentenceToken {
  word: string
  /** 词级 morph 的稳定身份：文本 + 第几次出现（存活的词滑动，新词淡入）。 */
  key: string
}

const NS = 'agents.schedule.sentence'

/** 本地化星期名（长）。0=周日 … 6=周六。 */
export function weekdayName(t: Translate, w: number): string {
  return t(`agents.schedule.weekday.${((w % 7) + 7) % 7}`)
}

/** 本地化序数（1st/2nd/…/last · 第 1/2/…/最后一个）。 */
export function ordinalName(t: Translate, o: number | 'last'): string {
  return t(`agents.schedule.ordinal.${o === 'last' ? 'last' : o}`)
}

/**
 * 时刻文案：**中英一律 12 小时制 + AM/PM**（`9:30 AM`），与上游组件一致。
 *
 * 🔴 有意不跟 locale 走（dogfood 反馈，owner 用中文 UI 但明确要 AM/PM）：
 *  • 曾按 locale 分叉成 en→12h / zh→24h `09:30`，owner 要求改回 AM/PM。
 *  • 也**不能**用 `Intl` 的 hour12 —— zh-CN 的 dayPeriod 会渲染成「上午/下午」，
 *    而 owner 要的就是 AM/PM 这两个字。故这里手工拼，不经 Intl。
 * AM/PM 不走 i18n key：它是时间**格式记号**（同冒号分隔符），在 V1 两个 locale 下取值相同。
 */
export function timeLabel(hour: number, minute: number): string {
  return `${hour12(hour)}:${String(minute).padStart(2, '0')} ${meridiem(hour)}`
}

/** 小时下拉的选项文案：`9 AM` / `12 PM`（同 timeLabel，中英一致）。 */
export function hourOptionLabel(hour: number): string {
  return `${hour12(hour)} ${meridiem(hour)}`
}

function hour12(hour: number): number {
  return hour % 12 === 0 ? 12 : hour % 12
}

function meridiem(hour: number): 'AM' | 'PM' {
  return hour < 12 ? 'AM' : 'PM'
}

/** 星期名列表 → 本地化连接（en "Tuesday and Thursday" · zh「周二和周四」）。 */
export function joinWeekdays(locale: string, names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** 频率短语（「每 2 周」/ "Every 2 weeks"）。 */
function freqPhrase(t: Translate, rule: ScheduleRule): string {
  const one = rule.interval === 1
  const key = `${NS}.freq.${rule.freq}${one ? '1' : 'N'}`
  return t(key, { count: rule.interval })
}

/** 目标短语（周几 / 几号 / 第 N 个周几）；daily 无目标。 */
function targetPhrase(t: Translate, locale: string, rule: ScheduleRule): string | null {
  if (rule.freq === 'daily') return null
  if (rule.freq === 'weekly') {
    const names = [...rule.weekdays].sort((a, b) => a - b).map((w) => weekdayName(t, w))
    return t(`${NS}.onWeekdays`, { days: joinWeekdays(locale, names) })
  }
  if (rule.monthMode === 'date') {
    return t(`${NS}.onDay`, { day: rule.monthDay })
  }
  return t(`${NS}.onNth`, {
    ordinal: ordinalName(t, rule.ordinal),
    weekday: weekdayName(t, rule.weekday)
  })
}

/** 完整句子文本（无障碍朗读 / aria-live 用）。 */
export function sentenceText(t: Translate, locale: string, rule: ScheduleRule): string {
  return [
    freqPhrase(t, rule),
    targetPhrase(t, locale, rule),
    t(`${NS}.atTime`, { time: timeLabel(rule.hour, rule.minute) })
  ]
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 句子 → token 列表（词级 morph 的动画单元）。 */
export function sentenceTokens(t: Translate, locale: string, rule: ScheduleRule): SentenceToken[] {
  const words = sentenceText(t, locale, rule).split(/\s+/).filter(Boolean)
  const seen: Record<string, number> = {}
  return words.map((word) => {
    seen[word] = (seen[word] ?? 0) + 1
    return { word, key: `${word}·${seen[word]}` }
  })
}
