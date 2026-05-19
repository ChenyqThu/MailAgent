// Sprint 10 user-acceptance follow-up — shared filter state for the
// EmailList. Sprint 2 kept it as local component state, but the sidebar
// "已标旗" / "Failed" virtual entries now need to drive the filter, so the
// state moved out into a zustand store the Sidebar can mutate.
//
// Sprint 11 V1.4 — added a parallel `view` axis (orthogonal to the chip
// `filter`). DESIGN.md §2.11 makes the four MAILBOXES rows
// (收件箱/发件箱/已标旗/所有邮件) the SIDEBAR-driven view selector;
// `filter` stays as the per-list chip filter (unread/flagged/failed) shown
// in the list header. Composition rule used by EmailList:
//   final query = applyView(view) AND applyChipFilter(filter)
// Changing the view via `setView` resets the chip filter to 'all' as a UX
// safety so the user doesn't end up with a stale chip after switching
// mailboxes.

import { create } from 'zustand'

export type EmailFilter = 'all' | 'unread' | 'flagged' | 'failed'
export type EmailView = 'inbox' | 'outbox' | 'flagged' | 'all'

interface EmailFilterStore {
  filter: EmailFilter
  view: EmailView
  setFilter(next: EmailFilter): void
  setView(next: EmailView): void
  /** Convenience used by Sidebar entries that toggle a specific filter on
   *  click — second click on the same chip falls back to `'all'`. */
  toggle(next: EmailFilter): void
}

export const useEmailFilter = create<EmailFilterStore>((set, get) => ({
  filter: 'all',
  view: 'inbox',
  setFilter(next) {
    set({ filter: next })
  },
  setView(next) {
    // Reset chip filter on view change so the user sees the full list of
    // the newly-selected view — no stale "unread only" carry-over.
    set({ view: next, filter: 'all' })
  },
  toggle(next) {
    set({ filter: get().filter === next ? 'all' : next })
  }
}))
