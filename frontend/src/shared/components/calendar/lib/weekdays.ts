// 阶段1·1.7 (F25/F26) — 周标签单源. 之前 5 处散落且语言混杂:
// WEEK_CHAR(CalendarToolbar) / weekDays(AgendaView) / MM_DOW(DayView MiniMonth)
// / DOW_EN(WeekView+MonthView) / DOW_EN_FULL(DayView 表头).
//
// 英文 3 字母大写标签是网格表头的设计语言 (mockup 视觉规范, 不随 locale),
// 保留常量; 中文周几是用户向文案, 走 t() (calendar.weekday.*).

import type { TFunction } from 'i18next'

/** Week/Month 网格表头 — 周一首, 3 字母英文设计标签 (不随 locale). */
export const DOW_EN = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

/** Day 视图表头 — Date.getDay() 索引 (周日=0), 3 字母英文设计标签. */
export const DOW_EN_FULL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const LONG_FALLBACK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
// mini-month 列头 (周一首)
const MIN_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const MIN_FALLBACK = ['一', '二', '三', '四', '五', '六', '日'] as const

/** Date.getDay() 索引 (周日=0) → 本地化周几全称 ('周日' / 'Sun'). */
export function weekdayLong(t: TFunction, day: number): string {
  return t(`calendar.weekday.long.${DAY_KEYS[day]}`, LONG_FALLBACK[day])
}

/** 周一首列索引 (0=周一) → 本地化单字周几 ('一' / 'M') — mini-month 列头. */
export function weekdayMin(t: TFunction, idx: number): string {
  return t(`calendar.weekday.min.${MIN_KEYS[idx]}`, MIN_FALLBACK[idx])
}
