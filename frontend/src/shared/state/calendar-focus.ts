// 阶段 2.2 (UX-P0①) — 「在日历中查看」跨面定位手递手 store。
//
// 写侧: MeetingInviteCard (邮件详情) 在 navigate 到 /admin/calendar 前写入
// pending target (事件日期 + uid)。
// 读侧: CalendarLayout 消费 (consume 取走即清空) —— currentDate / active 都是
// Layout 内部 useState, 路由 search 只带 view, 邮件面无法直接设置; 由 Layout
// mount/route 进入时 consume → setCurrentDate(dateIso) + 在窗口 occurrences 里
// 按 icalUid/recurrenceId 匹配 setActive。读侧接线属 Layout 领地 (2.7/主 session
// 收敛), 未接线前本 store 只使「在日历中查看」达到"切到日历面"深度。
import { create } from 'zustand'

export interface CalendarFocusTarget {
  /** 目标 occurrence 起始时间 ISO — Layout 用它定位 currentDate. */
  dateIso: string
  icalUid: string
  recurrenceId: string | null
}

interface CalendarFocusState {
  pending: CalendarFocusTarget | null
  request(target: CalendarFocusTarget): void
  /** 取走并清空 (单次消费, 防返回日历面时重复定位). */
  consume(): CalendarFocusTarget | null
}

export const useCalendarFocus = create<CalendarFocusState>((set, get) => ({
  pending: null,
  request: (target) => set({ pending: target }),
  consume: () => {
    const p = get().pending
    if (p) set({ pending: null })
    return p
  }
}))
