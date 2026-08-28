// Active email selection. Drives the EmailDetail pane and the J/K keyboard
// navigation hook. Sibling to state/mailbox.ts on purpose:
//   - mailbox.active is the user's *folder pick* (TanStack Query cache key);
//   - active-email.activeInternalId is the user's *row pick* within that
//     folder.
// Coupling them would force the query cache to bust on every email click;
// keeping them split lets the list stay warm.
//
// task 08-27 P2 Lane W —— 降为「激活邮件标签 targetId 的投影」：
//   - `setActive` 保留签名作为**唯一桥**（15+ 调用点不散改），内部转发标签 store：
//     默认 openTab（点行 / 深链 / 跨域跳转），`mode:'replace'` 走 replaceActiveTab
//     （J/K · 归档/删除后续选 · 冷启动选第一条 —— 连按 J 不能开一排标签）；
//   - 标签 store 侧的激活变化（标签条点击 / 关标签后继承 / 重启恢复）经下方订阅
//     反向投影回来，并带 navTarget 语义（目标可能不在当前列表，豁免 active-reset
//     抢选中 + 让列表滚动定位）；
//   - `setActive(null)`（窄屏返回 / 删空列表）是**视图局部**的取消选中：标签不动，
//     只清本地投影 —— 关标签的语义归标签条 / ⌘W。
//   - 持久化随标签 store 走（老的 mailagent.activeEmail localStorage 键退役）。
//   - 🔴 popout 窗不渲染标签条（tab-workspace 头注释），在 popout 下 setActive 退回
//     纯本地状态，绝不写标签 store（会覆盖主窗的持久化标签集）。

import { create } from 'zustand'

import { usePopoutMode } from './popout-mode'
import { selectActiveTargetId, useTabWorkspace } from './tab-workspace'
import { openObjectTab, replaceObjectTab } from './tab-workspace-bridge'

interface ActiveEmailStore {
  activeInternalId: number | null
  // Currently-displayed list order (date-desc, post-filter). Published by
  // EmailList so cross-pane consumers (EmailToolbar prev/next via EmailDetail)
  // can navigate with the same pickNext/pickPrev semantics as J/K, without
  // re-deriving the list. Not persisted — rebuilt on every list render.
  orderedIds: ReadonlyArray<number>
  // 显式"导航目标"id —— 搜索跳转(CommandPalette)打开一封当前列表里没有的邮件时
  // 设它。EmailList 的 active-reset 会豁免这个 id(否则它发现 activeId 不在当前
  // (可能陈旧/未分页到的)列表里, 立刻把 active 重置成列表第一封, 抢掉跳转目标)。
  // 目标真正出现在列表里后清空, 之后手动切邮箱恢复正常 reset。普通选择(行点击/
  // J-K/reset)调 setActive(id) 不带 navTarget → 清空它(普通选择优先于旧跳转目标)。
  navTargetId: number | null
  setActive(
    id: number | null,
    opts?: { navTarget?: boolean; mode?: 'open' | 'replace'; title?: string }
  ): void
  clearNavTarget(): void
  setOrderedIds(ids: ReadonlyArray<number>): void
}

// 冷启动初值 = 恢复的标签集里激活的那封（tab-workspace 在模块 init 时已 hydrate）。
// navTarget 同步给同一个 id：恢复的邮件可能不在当前列表（别的文件夹 / 未分页到），
// 不豁免的话 useEmailListRows 的 active-reset 会当场把恢复的标签 replace 成列表第一封。
function restoredActive(): number | null {
  return selectActiveTargetId(useTabWorkspace.getState(), 'email')
}

export const useActiveEmail = create<ActiveEmailStore>((set, get) => {
  const initial = restoredActive()
  return {
    activeInternalId: initial,
    orderedIds: [],
    navTargetId: initial,
    setOrderedIds(ids) {
      set({ orderedIds: ids })
    },
    setActive(id, opts) {
      // 先落本地再转发：转发引起的标签 store 提交会触发下方订阅，此刻投影值已相等
      // → 订阅不再覆写（保住本次调用自己的 navTarget 语义）。
      const prev = { activeInternalId: get().activeInternalId, navTargetId: get().navTargetId }
      set({ activeInternalId: id, navTargetId: opts?.navTarget && id !== null ? id : null })
      if (id === null || usePopoutMode.getState().isPopout) return
      const accepted =
        opts?.mode === 'replace'
          ? replaceObjectTab('email', id, opts?.title)
          : openObjectTab('email', id, opts?.title)
      // 标签满且全 locked 被拒（toast「标签已满」已出）→ 回滚本地投影（check 波3 续改）。
      // 不回滚 = 详情区显示新邮件、标签条还高亮旧标签，且点那个高亮标签 activateTab
      // 因 active === id 早退，必须点别的标签才能恢复。
      if (!accepted) set(prev)
    },
    clearNavTarget() {
      set({ navTargetId: null })
    }
  }
})

// 标签 store → 投影（响应式反向同步）。只对「激活邮件目标**变化**」动作 —— setActive(null)
// 的视图局部取消选中不会被无关的标签提交（updateTab 之类）翻回来。
useTabWorkspace.subscribe((state, prev) => {
  if (usePopoutMode.getState().isPopout) return
  const projected = selectActiveTargetId(state, 'email')
  if (projected === selectActiveTargetId(prev, 'email')) return
  const cur = useActiveEmail.getState().activeInternalId
  if (projected === null) {
    // 激活位切去主标签 / 事项标签：邮件详情投影清空。
    if (cur !== null) useActiveEmail.setState({ activeInternalId: null, navTargetId: null })
    return
  }
  if (projected !== cur) {
    // 标签条激活 / 关标签后继承 —— navTarget 语义：目标可能不在当前列表。
    useActiveEmail.setState({ activeInternalId: projected, navTargetId: projected })
  }
})

// ---- pure navigation helpers (J/K + click-to-select) -----------------------
//
// `pickNext` / `pickPrev` are pure on (ids, current) so they're trivially
// testable without touching React state. The keyboard hook composes them
// with the zustand setter; the EmailList row click path also composes them
// with shift-extend selection later (Sprint 5 batch).

/**
 * Next id after `current` in `ids` (date-desc list order — first id is most
 * recent). Behaviour:
 *   - empty list → null
 *   - current not in list → first id (treat as "no prior selection")
 *   - current at tail → tail (no wrap; matches DESIGN.md §9.5 J/K semantics)
 */
export function pickNext(ids: ReadonlyArray<number>, current: number | null): number | null {
  if (ids.length === 0) return null
  if (current === null) return ids[0]
  const idx = ids.indexOf(current)
  if (idx === -1) return ids[0]
  if (idx + 1 >= ids.length) return ids[idx]
  return ids[idx + 1]
}

/** Mirror of pickNext for K. Head stops at head (no wrap). */
export function pickPrev(ids: ReadonlyArray<number>, current: number | null): number | null {
  if (ids.length === 0) return null
  if (current === null) return ids[0]
  const idx = ids.indexOf(current)
  if (idx === -1) return ids[0]
  if (idx === 0) return ids[0]
  return ids[idx - 1]
}
