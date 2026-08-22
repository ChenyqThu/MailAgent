// 报告详情的「打开某一份报告」直达通道（通知中心 M2 批 B5）。
//
// 逐字镜像 `components/agents/navigation.ts` / `components/contacts/navigation.ts` /
// `components/matters/navigation.ts` 的 store-intent 形状：调用方先在 store 里点名目标
// report id，再 `navigate({to:'/agents', search:{tab:'reports'}})`，`ReportsTab` 消费即清。
//
// 🔴 有意**不**走 `?report=` 搜索参数：`/agents` 的 `validateSearch` 是多 session 共用的
// 文件，加一个键要动那份 schema 与它下面所有 `navigate({to:'/agents'})` 的调用点；而本仓
// 对「跨页打开某个东西」早有三处 store-intent 先例，跟随先例的 diff 更小。
//
// 目标报告不在当前列表（分页没翻到 / 已被删）时消费方**只清 intent**：选中回落到列表第
// 一份（ReportsTab 既有的派生逻辑），不弹一个指向不存在报告的空详情。

import { create } from 'zustand'

interface ReportNavigationState {
  /** 待打开的报告 id；null = 没有待办意图。 */
  targetReportId: string | null
  open(reportId: string): void
  clear(): void
}

export const useReportNavigation = create<ReportNavigationState>((set) => ({
  targetReportId: null,
  open: (targetReportId) => set({ targetReportId }),
  clear: () => set({ targetReportId: null })
}))
