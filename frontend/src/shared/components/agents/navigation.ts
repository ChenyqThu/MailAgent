// 团队页的「直接打开某个成员」直达通道：两种目标 —— 打开它的**配置**（通讯录 agent 面 v2
// 的「去配置」）或打开它**记录档里的某一条**（09-02 起 agent 执行终态通知的落点）。
//
// 逐字镜像 `components/contacts/navigation.ts` / `components/matters/navigation.ts` 的
// store-intent 形状：调用方先在 store 里点名目标 agent id（记录直达再多点名一个 session
// id），再 `navigate('/agents')`，`TeamWorkspace` 消费即清（effect 里选中该成员并落对应
// 档 + clear）。
//
// 🔴 有意**不**走 `?open=` 搜索参数：`/agents` 路由的 `validateSearch` 是多 session 共用的
// 文件，加一个键要动那份 schema 与它下面所有 `navigate({to:'/agents'})` 调用点；而本仓对
// 「跨页打开某个东西」这件事早有 store-intent 先例（两处），跟随先例的 diff 更小。
//
// 目标 agent 不在（老库没播种那行）时消费方什么都不做 —— 只清 intent，页面照常停在
// 团队页，不跳进一个指向不存在配置的空白页。

import type { useNavigate } from '@tanstack/react-router'
import { create } from 'zustand'

interface AgentsNavigationState {
  /** 待打开的 agent 行 id；null = 没有待办意图。 */
  targetAgentId: string | null
  /** 待选中的那条记录的会话 id；null = 只打开配置档（原有的「去配置」直达）。 */
  targetRecordSessionId: number | null
  openConfig(agentId: string): void
  openRecord(agentId: string, sessionId: number): void
  clear(): void
}

export const useAgentsNavigation = create<AgentsNavigationState>((set) => ({
  targetAgentId: null,
  targetRecordSessionId: null,
  // 显式清 record id：两种 intent 共用同一个 targetAgentId，上一次的记录目标留着会让
  // 「去配置」落到记录档。
  openConfig: (targetAgentId) => set({ targetAgentId, targetRecordSessionId: null }),
  openRecord: (targetAgentId, targetRecordSessionId) =>
    set({ targetAgentId, targetRecordSessionId }),
  clear: () => set({ targetAgentId: null, targetRecordSessionId: null })
}))

/** 记录直达的三段动作（点名成员 + 点名记录 + 进 `/agents`）的单源；体例同
 *  `groups/navigation.ts::navigateToGroupSession`：只引 router 的类型，实例由调用方传入。 */
export function navigateToTeamRecord(
  navigate: ReturnType<typeof useNavigate>,
  agentId: string,
  sessionId: number
): void {
  useAgentsNavigation.getState().openRecord(agentId, sessionId)
  void navigate({ to: '/agents' })
}
