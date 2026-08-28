// 阶段1·1.7 (F25/F26) — 周标签单源. 之前 5 处散落且语言混杂:
// WEEK_CHAR(CalendarToolbar) / weekDays(AgendaView) / MM_DOW(DayView MiniMonth)
// / DOW_EN(WeekView+MonthView) / DOW_EN_FULL(DayView 表头).
//
// 英文 3 字母大写标签是网格表头的设计语言 (mockup 视觉规范, 不随 locale),
// 保留常量; 中文周几是用户向文案, 走 t() (calendar.weekday.*).

import type { TFunction } from 'i18next'

/** Month 网格表头 — 周一首, 3 字母英文设计标签 (不随 locale). */
export const DOW_EN = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

/** 日/周时间轴表头 (TimelineView) — Date.getDay() 索引 (周日=0), 3 字母英文设计标签. */
export const DOW_EN_FULL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const LONG_FALLBACK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** Date.getDay() 索引 (周日=0) → 本地化周几全称 ('周日' / 'Sun'). */
export function weekdayLong(t: TFunction, day: number): string {
  return t(`calendar.weekday.long.${DAY_KEYS[day]}`, LONG_FALLBACK[day])
}
