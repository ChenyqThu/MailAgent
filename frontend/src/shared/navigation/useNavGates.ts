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
