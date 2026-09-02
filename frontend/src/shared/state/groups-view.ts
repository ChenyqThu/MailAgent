// L4 群聊 — 群聊域的跨栏视图状态（09-02 对话域拆分前叫 `sessions-segment`，那时它还多
// 一维「AI｜群聊」分段；群聊升一级域后分段没有了，剩下的两件都是群聊自己的状态）。
//
// 模块级 zustand store（keyboard-help / ai-chat-panel 同款房规）：当前群聊会话不落在组件
// state 里 —— HMR / 路由 remount / 窄屏列表-详情切换都不该把用户已选的群踢回默认值。
// 不持久化（重启回未选中是合理默认）。

import { create } from 'zustand'

interface GroupsViewStore {
  /** 当前选中的群聊会话 id（null = 未选中/空态）。跨 remount 保留。 */
  activeGroupSessionId: number | null
  setActiveGroupSessionId(id: number | null): void
  /** 群详情面的开合，**按群记忆**（缺键 = 关）：右栏是常驻面不是模态，切回某个群应该还是
   *  离开时那副样子；一个全局 boolean 会让「在 A 群开着」跟着切到 B 群。 */
  detailsOpenBySession: Record<number, boolean>
  setDetailsOpen(sessionId: number, open: boolean): void
}

export const useGroupsView = create<GroupsViewStore>((set) => ({
  activeGroupSessionId: null,
  setActiveGroupSessionId: (id) => set({ activeGroupSessionId: id }),
  detailsOpenBySession: {},
  setDetailsOpen: (sessionId, open) =>
    set((s) => ({ detailsOpenBySession: { ...s.detailsOpenBySession, [sessionId]: open } }))
}))
