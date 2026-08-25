// 导航门控的求值层（registry 是叶子，只写门控的**名字**，真值在这里算）。
//
// 三个门控的来源各不相同：matters / contacts 是后端 `/chat/config` 投影（react-query），
// calendar 是平台判定（Windows 日历整体出范围，2026-08-13 拍板，不看 backend）。把它们
// 收在一处，五通道就不用各自 import 三个 hook 再各写一遍 `? :`。

import { useMemo } from 'react'

import { useContactsEnabled } from '@shared/components/contacts/hooks'
import { useMattersEnabled } from '@shared/components/matters/hooks'
import { calendarUiEnabled, detectUiPlatform } from '@shared/lib/mailBackend'

import { NAV_ENTRIES, type NavEntry, type NavGate } from './registry'

export function useNavGates(): Record<NavGate, boolean> {
  const matters = useMattersEnabled()
  const { enabled: contacts } = useContactsEnabled()
  const calendar = calendarUiEnabled(detectUiPlatform())
  return useMemo(
    () => ({ always: true, never: false, matters, contacts, calendar }),
    [matters, contacts, calendar]
  )
}

/** 门控过滤后的入口全集 —— 侧栏 / ⌘K jump 各自再投影自己那一面。 */
export function useVisibleNavEntries(): readonly NavEntry[] {
  const gates = useNavGates()
  return useMemo(() => NAV_ENTRIES.filter((e) => gates[e.gate]), [gates])
}

/** 非组件上下文（deeplink handler 等 hooks 求不了值的地方）的门控求值。
 *
 *  calendar 是纯平台判定，这里能给出真值；matters / contacts 的真值在后端
 *  `/chat/config` 投影（react-query hook），非组件上下文取不到 —— 放行，由目标路由
 *  自己的空态兜底（`/contacts` 直达时 ContactsWorkspace 渲染 404 空态，见
 *  router-instance 的 contactsRoute 注释）。deeplink 加新 kind 时给 entry 标 gate
 *  即自动接上这道闸，不再在 handler 里手写平台判定（Step R check ② 的通用解）。 */
export function resolveStaticNavGate(gate: NavGate): boolean {
  switch (gate) {
    case 'always':
      return true
    case 'never':
      return false
    case 'calendar':
      return calendarUiEnabled(detectUiPlatform())
    case 'matters':
    case 'contacts':
      return true
  }
}
