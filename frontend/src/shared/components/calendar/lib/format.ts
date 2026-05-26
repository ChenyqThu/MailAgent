// F32 — Calendar 模块跨 view 共享的纯 format helpers.
// 老代码 DayView/WeekView/MonthView/AgendaView/EventBlock/EventDetailDrawer/
// EventFormModal 各自重复定义 pad / ymd / shortTime / isSameDay /
// isTodayLocal 5 个 helpers (~17 处), 抽到这里所有 view 共用.
//
// 不放 hooks/useCalendarEvents.ts 里, 那是 react-query hook 文件, format
// helpers 是纯函数无 hook 依赖, 单独文件更清晰且单测友好.

/** 数字补零到 2 位 (e.g. 5 → "05"). 时分秒格式化用. */
export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → "YYYY-MM-DD" 本地时区. mini-month / 日历 group key 通用. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** ISO datetime string → "HH:MM" 本地时区. 事件时间块 + agenda time 共用. */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 两个 Date 是否同一天 (本地时区, 不比时间). */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  )
}

/** d 是否就是 "今天" (本地时区). */
export function isTodayLocal(d: Date): boolean {
  return isSameDay(d, new Date())
}
