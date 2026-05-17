// Batch selection state for Sprint 5 BatchActionBar (DESIGN.md §5.4).
// Sprint 1 ships the store + toggling primitives; the bar UI binds in
// Sprint 5 along with `AI 批量分类 / AI 批量起草 / 批量翻译` operations.
//
// `selectedIds` is exposed as `ReadonlyArray` for stable referential equality
// in React; mutations always go through the action methods. We keep the
// internal store as a Set for O(1) toggle/has, then snapshot to a sorted
// array on every mutation so list selectors can use `===` to skip re-renders.

import { create } from 'zustand'

interface BatchStore {
  selectedIds: ReadonlyArray<number>
  toggle(id: number): void
  toggleMany(ids: ReadonlyArray<number>): void
  isSelected(id: number): boolean
  clear(): void
  selectAll(ids: ReadonlyArray<number>): void
}

// The Set lives at module scope rather than on the store so a stale React
// snapshot can never expose a mutable reference. Every mutation rebuilds the
// `selectedIds` array.
const inner = new Set<number>()
const snapshot = (): number[] => Array.from(inner.values()).sort((a, b) => a - b)

export const useBatch = create<BatchStore>((set) => ({
  selectedIds: [],
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
    // Hit the live Set so keyboard repeat (J/K + Shift) never sees a stale
    // view between a mutation and React's next render.
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
