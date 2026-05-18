// Sprint 5 §2.2 — Toast store.
//
// Top-right slide-in notifications for write-op outcomes (createDraft /
// resync / llm:run / notion:updateFlag). DESIGN.md §5 component catalog
// asks for shadcn `<Toast>` (3s auto-dismiss + progress bar); we own the
// queue + dismissal in zustand so any component (EmailToolbar /
// BatchActionBar / AIChatPanel) can fire one without prop drilling.
//
// Invariants:
//   - At most `MAX_VISIBLE` toasts on screen at once. Beyond that, the
//     oldest gets demoted (dropped) to keep the corner from filling the
//     viewport.
//   - Auto-dismiss is timer-driven; pause/resume on hover lands in
//     Sprint 6 polish. For V1 we hard-dismiss at TTL.
//   - `id` is monotonic int. Renderer keys on it.

import { create } from 'zustand'

export type ToastVariant = 'success' | 'error' | 'info'

export interface ToastInput {
  variant?: ToastVariant
  /** Headline string — usually `t('toolbar.draft.ok')` etc. */
  title: string
  /** Optional secondary line. Error codes / hints go here. */
  detail?: string
  /** Auto-dismiss in ms. Default 3000. 0 = sticky (user must dismiss). */
  ttlMs?: number
  /** Sprint 5 §2.2 long-task progress: 0..1 fraction. When supplied, the
   *  toast renders a progress bar; TTL is implicitly 0 (sticky) until the
   *  caller pushes a terminal `success` / `error` toast or removes this
   *  one via `dismiss(id)`. */
  progress?: number
}

export interface Toast extends ToastInput {
  id: number
  pushedAt: number
}

interface ToastStore {
  items: Toast[]
  push(input: ToastInput): number
  /** Update progress on an in-flight long-task toast (BatchActionBar). */
  setProgress(id: number, progress: number): void
  dismiss(id: number): void
  clear(): void
}

/** Cap on simultaneously-visible toasts — beyond this the oldest gets
 *  dropped to keep the corner from filling the viewport. */
export const MAX_VISIBLE = 4
const DEFAULT_TTL_MS = 3000

let _nextId = 1

export const useToastStore = create<ToastStore>((set, get) => ({
  items: [],
  push(input) {
    const id = _nextId++
    const toast: Toast = {
      id,
      pushedAt: Date.now(),
      variant: input.variant ?? 'info',
      title: input.title,
      detail: input.detail,
      ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
      progress: input.progress
    }
    set((s) => {
      const next = [...s.items, toast]
      // Demote oldest if over cap.
      while (next.length > MAX_VISIBLE) next.shift()
      return { items: next }
    })
    // Schedule auto-dismiss only when TTL > 0 AND no progress (sticky).
    const ttl = toast.ttlMs ?? DEFAULT_TTL_MS
    if (ttl > 0 && toast.progress === undefined) {
      setTimeout(() => {
        // Re-check that the toast still exists — it may have been dismissed
        // or replaced by an update with progress (which makes it sticky).
        const cur = get().items.find((t) => t.id === id)
        if (cur && cur.progress === undefined) get().dismiss(id)
      }, ttl)
    }
    return id
  },
  setProgress(id, progress) {
    set((s) => ({
      items: s.items.map((t) => (t.id === id ? { ...t, progress: clamp01(progress) } : t))
    }))
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
  },
  clear() {
    set({ items: [] })
  }
}))

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

// Convenience helpers — direct store calls leak the imperative shape into
// components; these read better at the call site.
export function toastSuccess(title: string, detail?: string): number {
  return useToastStore.getState().push({ variant: 'success', title, detail })
}
export function toastError(title: string, detail?: string): number {
  return useToastStore.getState().push({ variant: 'error', title, detail, ttlMs: 5000 })
}
export function toastInfo(title: string, detail?: string): number {
  return useToastStore.getState().push({ variant: 'info', title, detail })
}

/** Test escape — reset the monotonic id + clear queue between cases. */
export function __resetToastStore(): void {
  _nextId = 1
  useToastStore.setState({ items: [] })
}
