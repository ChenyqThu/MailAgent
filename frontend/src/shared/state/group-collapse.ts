// Sprint 12 — collapsed-state for the EmailList date groups
// (Today / Yesterday / This week / Last week / Older). Persisted to
// localStorage so the layout survives reloads + pop-out windows.

import { create } from 'zustand'

const KEY = 'mailagent.emailList.groupsCollapsed'

// 'flat' = 非日期排序（发件人/主题/重要性）下的唯一非置顶桶。日期分桶在这些排序下
// 无意义（按发件人排完还按「今天/昨天」切段 = 把排序结果切碎），故整段平铺、**不出
// 分组标题**，也就不参与折叠持久化 —— 它在这个 union 里只是为了让桶表保持穷举。
export type GroupKey = 'pinned' | 'flat' | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'older'

function readPersisted(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>
    return {}
  } catch {
    return {}
  }
}

function writePersisted(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* quota / private mode — state stays in memory. */
  }
}

interface Store {
  collapsed: Record<string, boolean>
  isCollapsed(key: GroupKey): boolean
  toggle(key: GroupKey): void
  setCollapsed(key: GroupKey, next: boolean): void
}

export const useGroupCollapse = create<Store>((set, get) => ({
  collapsed: readPersisted(),
  isCollapsed(key) {
    return get().collapsed[key] === true
  },
  toggle(key) {
    const next = { ...get().collapsed, [key]: !get().collapsed[key] }
    writePersisted(next)
    set({ collapsed: next })
  },
  setCollapsed(key, next) {
    const cur = get().collapsed
    if ((cur[key] ?? false) === next) return
    const merged = { ...cur, [key]: next }
    writePersisted(merged)
    set({ collapsed: merged })
  }
}))

// Cross-window sync — mirror the nav-shell pattern.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    try {
      const next = e.newValue ? (JSON.parse(e.newValue) as Record<string, boolean>) : {}
      useGroupCollapse.setState({ collapsed: next })
    } catch {
      /* ignore corrupt storage write */
    }
  })
}
