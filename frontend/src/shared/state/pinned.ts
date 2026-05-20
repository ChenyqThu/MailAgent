// v8 (Sprint 12.6) — pin persistence moved from localStorage to SQLite
// (email_metadata.is_pinned). The zustand store now mirrors the server
// snapshot that `usePinnedSync` (hooks/usePinnedSync.ts) drives in via
// the `email:listPinnedIds` IPC, and `togglePinOptimistic` is used by
// EmailRow for instant feedback while the IPC write is in flight.
//
// localStorage is no longer the source of truth — if you toggle a pin
// on machine A, machine B's renderer picks it up on the next 10s
// listPinnedIds refetch (or the next mutation invalidation). pm2
// mail-sync never touches is_pinned, so there is no race.

import { create } from 'zustand'

interface Store {
  pinned: ReadonlyArray<number>
  isPinned(id: number): boolean
  /** Optimistic local flip — used by EmailRow before the IPC write
   *  resolves. Server reconciliation happens via `setPinned` after the
   *  ['pinnedIds'] query invalidates. */
  togglePinOptimistic(id: number): void
  /** Replace the entire pinned set — only `usePinnedSync` should call
   *  this (after a fresh `email:listPinnedIds` response). */
  setPinned(ids: ReadonlyArray<number>): void
}

const inner = new Set<number>()
const snapshot = (): number[] => Array.from(inner.values()).sort((a, b) => a - b)

export const usePinned = create<Store>((set) => ({
  pinned: [],
  isPinned(id) {
    return inner.has(id)
  },
  togglePinOptimistic(id) {
    if (inner.has(id)) inner.delete(id)
    else inner.add(id)
    set({ pinned: snapshot() })
  },
  setPinned(ids) {
    inner.clear()
    for (const v of ids) inner.add(v)
    set({ pinned: snapshot() })
  }
}))
