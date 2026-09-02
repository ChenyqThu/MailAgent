// L4 群聊 — 对话域二级栏顶部分段（「AI」主 agent 会话 ｜「群聊」custom agents 群聊）。
//
// 模块级 zustand store（keyboard-help / ai-chat-panel 同款房规）：分段选择与当前群聊会话
// 都不落在组件 state 里 —— HMR / 路由 remount / 窄屏列表-详情切换都不该把用户已选的
// tab / 群聊踢回默认值。不持久化（重启回「AI」是合理默认）。

import { create } from 'zustand'

export type SessionsSegment = 'ai' | 'groups'

interface SessionsSegmentStore {
  segment: SessionsSegment
  setSegment(next: SessionsSegment): void
  /** 当前选中的群聊会话 id（null = 未选中/空态）。跨 remount 保留。 */
  activeGroupSessionId: number | null
  setActiveGroupSessionId(id: number | null): void
  /** 群详情面的开合，**按群记忆**（缺键 = 关）：右栏是常驻面不是模态，切回某个群应该还是
   *  离开时那副样子；一个全局 boolean 会让「在 A 群开着」跟着切到 B 群。 */
  detailsOpenBySession: Record<number, boolean>
  setDetailsOpen(sessionId: number, open: boolean): void
}

export const useSessionsSegment = create<SessionsSegmentStore>((set) => ({
  segment: 'ai',
  setSegment: (next) => set({ segment: next }),
  activeGroupSessionId: null,
  setActiveGroupSessionId: (id) => set({ activeGroupSessionId: id }),
  detailsOpenBySession: {},
  setDetailsOpen: (sessionId, open) =>
    set((s) => ({ detailsOpenBySession: { ...s.detailsOpenBySession, [sessionId]: open } }))
}))
