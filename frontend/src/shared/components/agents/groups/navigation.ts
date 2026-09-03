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

/** T3 — 跳到某个群里的某个**话题**（通知 link 型 `thread` 的落地单源）。
 *
 *  比 `navigateToGroupSession` 多一段：先点名话题再点名群。两件都点名是必需的 —— 话题面挂在
 *  群视图里，只点名话题会落到「群没选中、右栏无处可挂」；只点名群则打开的是主时间线，
 *  用户还得自己找回那条话题卡（通知说的「谁在话题里回了你」当场落空）。
 *
 *  与 `navigateToGroupSession` 同样只引 router 的类型，实例由调用方传进来；同样两处调用
 *  （面板内点击 + 系统通知点击）共用这一份。 */
export function navigateToGroupThread(
  navigate: ReturnType<typeof useNavigate>,
  groupId: number,
  threadId: number
): void {
  const state = useGroupsView.getState()
  state.setActiveThread(groupId, threadId)
  state.setActiveGroupSessionId(groupId)
  void navigate({ to: '/groups' })
}
