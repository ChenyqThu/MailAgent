// 标签工作区的命令层（task 08-27-l4-tab-workspace P2 · Lane K）。
//
// `tab-workspace.ts` 只管状态（有哪些标签、谁激活、每个标签记着什么），**不出 toast、
// 不认识 i18n**。「结果 → 提示」那段的单源是 bridge 的 `announceTabResult`（点行 /
// 深链 / 键盘三条入口共用一份判据与词表）；这里只做「按键 → store 动作」的翻译。

import { announceTabResult } from '@shared/state/tab-workspace-bridge'
import {
  MAIN_SLOT,
  selectActiveTab,
  useTabWorkspace,
  type ActiveSlot
} from '@shared/state/tab-workspace'

// ⌘T / 标签条「+」——「新标签页」搜索单例。实现在 bridge（toast 判据 + i18n 标题快照
// 都在那边单源），这里 re-export 保住键盘命令层的入口面。
export { openSearchTab } from '@shared/state/tab-workspace-bridge'

/** ⌃⇥ / ⌘1-9 的循环序：主标签在最前，其后是对象标签的**数组序**（标签条上看到的顺序，
 *  不是 LRU 序 —— 位置直达要的是「屏幕上第几个」）。 */
function slotOrder(): ActiveSlot[] {
  return [MAIN_SLOT, ...useTabWorkspace.getState().tabs.map((t) => t.id)]
}

function activateSlot(slot: ActiveSlot): void {
  const store = useTabWorkspace.getState()
  if (slot === MAIN_SLOT) store.activateMain()
  else store.activateTab(slot)
}

/** ⌘W。关掉当前对象标签；主标签激活时**什么也不做**（主标签不可关）。
 *  返回是否真的关掉了一个 —— 调用方无论真假都要消费掉按键（见 GlobalShortcuts）。 */
export function closeActiveTab(): boolean {
  const active = selectActiveTab(useTabWorkspace.getState())
  if (active === null) return false
  useTabWorkspace.getState().closeTab(active.id)
  return true
}

/** ⌃⇥（`+1`）/ ⌃⇧⇥（`-1`）。到头回卷。只有主标签一个槽位时是 no-op。 */
export function cycleTab(direction: 1 | -1): boolean {
  const order = slotOrder()
  if (order.length < 2) return false
  const current = useTabWorkspace.getState().active
  const idx = order.indexOf(current)
  // 激活槽不在序列里（理论上不会发生）时按「停在主标签」处理，往后一步就是首个对象标签。
  const base = idx < 0 ? 0 : idx
  activateSlot(order[(base + direction + order.length) % order.length])
  return true
}

/** ⌘1-9。`position` 是 1 起的位置：1 = 主标签，2-9 = 对象标签的第 1-8 个。
 *  位置上没有标签（开得不够多）→ 不动，返回 false。 */
export function jumpToSlot(position: number): boolean {
  const order = slotOrder()
  const slot = order[position - 1]
  if (slot === undefined) return false
  activateSlot(slot)
  return true
}

/** ⌘⇧T。栈空静默忽略（按了没东西可恢复不该弹提示，`announceTabResult` 对 null 早退）；
 *  开不成的两种结局按共用判据出声。 */
export function reopenClosedTab(): boolean {
  const result = useTabWorkspace.getState().reopenLastClosed()
  announceTabResult(result)
  return result !== null && result.outcome !== 'rejected'
}
