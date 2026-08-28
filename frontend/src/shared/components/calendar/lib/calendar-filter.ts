// Phase 4·#1 — calendar 多选 client-side filter (纯函数, 抽离 hooks import 链
// 以便 node 环境单测; useCalendarEvents.ts import react-query/useMailApi 不适合
// 纯函数测试直接 import). occurrence.calendar_name 后端已填.

import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'
import type { CalendarMemberExclusions } from '@shared/state/calendar-view'

import { agendaMemberId } from './sourceTree'

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

/** 三源聚合数据的成员级过滤 (dogfood 轮 2: 二级栏分组日历树的勾选判据)。
 *
 *  排除集语义: `excluded[source]` 里的成员 id 不显示, 空集 = 该组全选。没有成员
 *  身份的条目 (agendaMemberId 返回 null) 恒显示 —— 它只受组级开关管。
 *
 *  邮箱组的成员 id = calendar 名, 所以「按日历筛选」下拉与树上邮箱组的勾选是
 *  **同一份状态** (CalendarLayout 把下拉的选中集换算成这里的排除集)。 */
export function filterAgendaByMembers(
  entries: AgendaEntry[],
  excluded?: CalendarMemberExclusions
): AgendaEntry[] {
  if (!excluded) return entries
  if (!excluded.mail.size && !excluded.matter.size && !excluded.agent.size) return entries
  return entries.filter((e) => {
    const id = agendaMemberId(e)
    return id === null || !excluded[e.source].has(id)
  })
}
