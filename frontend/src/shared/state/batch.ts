// Sprint 5 batch selection store, extended in Sprint 12 with a `mode`
// toggle (off / on) and `enter` / `exit` helpers — the floating
// BatchActionBar gates its visibility on this mode rather than on
// `selectedIds.length > 0` (so the bar persists while the user clears
// the selection but keeps batching).
//
// `selectedIds` is exposed as `ReadonlyArray<number>` for stable
// referential equality across renders; mutations always go through the
// action methods. The Set lives at module scope so a stale React snapshot
// can never expose a mutable reference.

import { create } from 'zustand'

export type BatchMode = 'off' | 'on'

interface BatchStore {
  mode: BatchMode
  selectedIds: ReadonlyArray<number>
  enter(): void
  exit(): void
  setMode(next: BatchMode): void
  toggle(id: number): void
  toggleMany(ids: ReadonlyArray<number>): void
  isSelected(id: number): boolean
  clear(): void
  selectAll(ids: ReadonlyArray<number>): void
}

const inner = new Set<number>()
const snapshot = (): number[] => Array.from(inner.values()).sort((a, b) => a - b)

function syncBodyAttr(mode: BatchMode): void {
  if (typeof document === 'undefined') return
  if (mode === 'on') document.body.dataset.batchMode = 'true'
  else delete document.body.dataset.batchMode
}

export const useBatch = create<BatchStore>((set) => ({
  mode: 'off',
  selectedIds: [],
  enter() {
    syncBodyAttr('on')
    set({ mode: 'on' })
  },
  exit() {
    inner.clear()
    syncBodyAttr('off')
    set({ mode: 'off', selectedIds: [] })
  },
  setMode(next) {
    if (next === 'off') inner.clear()
    syncBodyAttr(next)
    set({ mode: next, selectedIds: next === 'off' ? [] : snapshot() })
  },
  toggle(id) {
    if (inner.has(id)) inner.delete(id)
    else inner.add(id)
    set({ selectedIds: snapshot() })
  },
  toggleMany(ids) {
    for (const id of ids) {
      if (inner.has(id)) inner.delete(id)
      else inner.add(id)
    }
    set({ selectedIds: snapshot() })
  },
  isSelected(id) {
    return inner.has(id)
  },
  clear() {
    if (inner.size === 0) return
    inner.clear()
    set({ selectedIds: [] })
  },
  selectAll(ids) {
    inner.clear()
    for (const id of ids) inner.add(id)
    set({ selectedIds: snapshot() })
  }
}))
