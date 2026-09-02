// 群聊会话 deep-link 的落地单源（体例照 `components/agents/navigation.ts` 的 store-intent）。
//
// 「跳到某个群」是两段动作：点名群会话 → 进 `/groups` 路由。三处调用方（系统通知的
// router-instance、面板内点击的 NotificationPanel、实验室的一键建局）以前各抄一份，其中
// 一处根本没抄（面板里点群通知只标已读哪也不去）；09-02 群聊升一级域时也正因为落地收敛
// 在这里，那三处一行都不用动。
//
// 只引类型不引 router：本模块运行时不依赖 router 实例，`navigate` 由调用方传进来。

import type { useNavigate } from '@tanstack/react-router'

import { useGroupsView } from '@shared/state/groups-view'

export function navigateToGroupSession(
  navigate: ReturnType<typeof useNavigate>,
  sessionId: number
): void {
  useGroupsView.getState().setActiveGroupSessionId(sessionId)
  void navigate({ to: '/groups' })
}
