// Active email selection. Drives the EmailDetail pane (Sprint 2) and the
// J/K keyboard navigation hook. Sibling to state/mailbox.ts on purpose:
//   - mailbox.active is the user's *folder pick* (TanStack Query cache key);
//   - active-email.activeInternalId is the user's *row pick* within that
//     folder.
// Coupling them would force the query cache to bust on every email click;
// keeping them split lets the list stay warm.
//
// Persisted to localStorage. Mailbox switches do NOT auto-reset the active
// id — EmailList is the right place to reconcile (it knows whether the
// stored id still exists in the freshly-loaded list and can fall back to
// the first row). The store stays pure: id in, id out.

import { create } from 'zustand'

const STORAGE_KEY = 'mailagent.activeEmail'

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
  setActive(id: number | null, opts?: { navTarget?: boolean }): void
  clearNavTarget(): void
  setOrderedIds(ids: ReadonlyArray<number>): void
}

function read(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw === '') return null
    const n = Number.parseInt(raw, 10)
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

function write(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(id))
  } catch {
    /* privacy mode — drop the persist, in-memory state still works */
  }
}

export const useActiveEmail = create<ActiveEmailStore>((set) => ({
  activeInternalId: read(),
  orderedIds: [],
  navTargetId: null,
  setOrderedIds(ids) {
    set({ orderedIds: ids })
  },
  setActive(id, opts) {
    write(id)
    set({ activeInternalId: id, navTargetId: opts?.navTarget ? id : null })
  },
  clearNavTarget() {
    set({ navTargetId: null })
  }
}))

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
