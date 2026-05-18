// Sprint 10 user-acceptance follow-up — shared filter state for the
// EmailList. Sprint 2 kept it as local component state, but the sidebar
// "已标旗" / "Failed" virtual entries now need to drive the filter, so the
// state moved out into a zustand store the Sidebar can mutate.

import { create } from 'zustand'

export type EmailFilter = 'all' | 'unread' | 'flagged' | 'failed'

interface EmailFilterStore {
  filter: EmailFilter
  setFilter(next: EmailFilter): void
  /** Convenience used by Sidebar entries that toggle a specific filter on
   *  click — second click on the same chip falls back to `'all'`. */
  toggle(next: EmailFilter): void
}

export const useEmailFilter = create<EmailFilterStore>((set, get) => ({
  filter: 'all',
  setFilter(next) {
    set({ filter: next })
  },
  toggle(next) {
    set({ filter: get().filter === next ? 'all' : next })
  }
}))
