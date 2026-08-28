// 「今日」域二级栏 ↔ 主区的分区手递手（task 08-27-l4-tab-workspace P1）。
//
// 写侧: DomainPanel 的 TodayNavPanel（当天五节跳转行）。
// 读侧: TodayExceptionSurface —— 滚动/高亮到最接近的现有分组（P1 过渡映射在读侧，
// P4 重做五节主区后主区与这里一一对应）。
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
