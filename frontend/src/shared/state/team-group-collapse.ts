// task 09-02 misc08 — collapsed-state for the Team page member groups
// (Built-in / Custom). Persisted to localStorage so the layout survives
// reloads + pop-out windows. Modeled on `group-collapse.ts` (EmailList date
// groups); no cross-window storage sync here (PRD 拍板不做).

import { create } from 'zustand'

const KEY = 'mailagent.team.groupsCollapsed'

export type TeamGroupKey = 'builtin' | 'custom'

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
  isCollapsed(key: TeamGroupKey): boolean
  toggle(key: TeamGroupKey): void
  setCollapsed(key: TeamGroupKey, next: boolean): void
}

export const useTeamGroupCollapse = create<Store>((set, get) => ({
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
