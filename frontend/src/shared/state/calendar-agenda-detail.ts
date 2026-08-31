// task 08-27 P4d —— 日历详情抽屉的「投影条目」槽位（matter / agent 两源）。
//
// mail 源的选中态仍是 CalendarLayout 的 `active`（一个 CalendarEventOccurrence，j/k
// 巡航与删除撤销 reopen 都吃它）。matter / agent 在日历上是**投影**，没有 occurrence
// 可言 —— 要塞进同一个槽位就得给它们造一个假的 occurrence 形状（uid 空、attendees 空、
// source 撒谎），那份假数据会顺着 useCalendarEvent / RSVP / 删除链一路往下漏。
// 所以分开存，谁在前由 EventDetailDrawer 决定（投影优先，见那边的注释）。
//
// 写侧只有 useAgendaEntryClick；读侧只有 EventDetailDrawer。
//
// 🔴 本文件不 import registry / router / hooks（同 calendar-view store 的既有纪律）。

import { create } from 'zustand'

import type { AgendaEntry } from '@shared/api/types'

interface CalendarAgendaDetailState {
  /** null = 没有投影条目被选中（抽屉要么关着，要么在渲染 mail 形态）。 */
  entry: AgendaEntry | null
  open(entry: AgendaEntry): void
  close(): void
}

export const useAgendaDetail = create<CalendarAgendaDetailState>((set) => ({
  entry: null,
  open: (entry) => set({ entry }),
  close: () => set({ entry: null })
}))
