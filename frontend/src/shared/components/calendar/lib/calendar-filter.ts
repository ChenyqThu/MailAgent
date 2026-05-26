// Phase 4·#1 — calendar 多选 client-side filter (纯函数, 抽离 hooks import 链
// 以便 node 环境单测; useCalendarEvents.ts import react-query/useMailApi 不适合
// 纯函数测试直接 import). occurrence.calendar_name 后端已填.

import type { CalendarEventOccurrence } from '@shared/api/types'

/** selectedCalendars 空 (= 未选 = 全选) 返回全部; 非空只保留 calendar_name ∈
 *  selectedCalendars 的 occurrence. 入参数组不可变 (返回新数组). */
export function filterOccurrencesByCalendars(
  occs: CalendarEventOccurrence[],
  selectedCalendars?: string[]
): CalendarEventOccurrence[] {
  if (!selectedCalendars || selectedCalendars.length === 0) return occs
  const set = new Set(selectedCalendars)
  return occs.filter((o) => set.has(o.calendar_name))
}
