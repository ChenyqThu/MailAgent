// 「今日」域二级栏 ↔ 主区的分区手递手（task 08-27-l4-tab-workspace P1）。
//
// 写侧: DomainPanel 的 TodayNavPanel（当天五节跳转行）。
// 读侧: TodaySurface —— 主区五节与这份词表**一一对应**（P4c 起；P1-P3 的
// `SECTION_TO_GROUP` 过渡映射已随之删除）。选中节同时是主标签面包屑的第二段。
//
// 五节词表 = 原型 Main.dc.html 的 todayNav 段（等你拍板 / 今天的会 / 待回邮件 /
// 临期事项 / 智能体产出）。

import { create } from 'zustand'

export const TODAY_SECTIONS = ['decide', 'meet', 'reply', 'due', 'out'] as const
export type TodaySectionId = (typeof TODAY_SECTIONS)[number]

/** 二级栏的组：前三节归「需要你」，后两节归「接下来」。 */
export const TODAY_SECTION_GROUPS: ReadonlyArray<{
  readonly labelKey: string
  readonly sections: readonly TodaySectionId[]
}> = [
  { labelKey: 'today.nav.groupNeedYou', sections: ['decide', 'meet', 'reply'] },
  { labelKey: 'today.nav.groupNext', sections: ['due', 'out'] }
]

interface TodaySectionState {
  section: TodaySectionId
  /** 每次点击自增 —— 让「再点同一节」也能触发读侧重新滚动。 */
  nonce: number
  setSection(next: TodaySectionId): void
}

export const useTodaySection = create<TodaySectionState>((set) => ({
  section: 'decide',
  nonce: 0,
  setSection: (next) => set((s) => ({ section: next, nonce: s.nonce + 1 }))
}))
