// 团队页的「直接打开某个成员的配置」直达通道（通讯录 agent 面 v2）。
//
// 逐字镜像 `components/contacts/navigation.ts` / `components/matters/navigation.ts` 的
// store-intent 形状：调用方先在 store 里点名目标 agent id，再 `navigate('/agents')`，
// `TeamWorkspace` 消费即清（effect 里选中该成员并落设置档 + clear）。
//
// 🔴 有意**不**走 `?open=` 搜索参数：`/agents` 路由的 `validateSearch` 是多 session 共用的
// 文件，加一个键要动那份 schema 与它下面所有 `navigate({to:'/agents'})` 调用点；而本仓对
// 「跨页打开某个东西」这件事早有 store-intent 先例（两处），跟随先例的 diff 更小。
//
// 目标 agent 不在（老库没播种那行）时消费方什么都不做 —— 只清 intent，页面照常停在
// 团队页，不跳进一个指向不存在配置的空白页。

import { create } from 'zustand'

interface AgentsNavigationState {
  /** 待打开配置页的 agent 行 id；null = 没有待办意图。 */
  targetAgentId: string | null
  openConfig(agentId: string): void
  clear(): void
}

export const useAgentsNavigation = create<AgentsNavigationState>((set) => ({
  targetAgentId: null,
  openConfig: (targetAgentId) => set({ targetAgentId }),
  clear: () => set({ targetAgentId: null })
}))
