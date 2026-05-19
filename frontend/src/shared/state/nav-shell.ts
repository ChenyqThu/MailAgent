// Sprint 11 V1.4 — nav shell collapsed-state store.
//
// DESIGN.md §2.11 contract:
//   - 240px (expanded) ↔ 56px (collapsed)
//   - persists to localStorage["mailagent.nav.collapsed"]
//   - cross-window sync via the `storage` event so a pop-out compose /
//     detail window stays in lockstep with the main inbox window
//
// Mirrors the broadcast convention used by appearance.ts (theme/accent).
// The module-level `storage` listener installs once per renderer process
// at import time; SSR-gated by typeof window check. No leak in practice:
// the listener lives as long as the renderer process.

import { create } from 'zustand'

const KEY = 'mailagent.nav.collapsed'

function readPersisted(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

function writePersisted(next: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, String(next))
  } catch {
    /* Safari private mode / iframe sandbox / quota — DOM API boundary;
     * silently skipped, state remains in the zustand store. */
  }
}

interface NavShellStore {
  collapsed: boolean
  toggle: () => void
  setCollapsed: (next: boolean) => void
}

export const useNavCollapsed = create<NavShellStore>((set, get) => ({
  collapsed: readPersisted(),
  toggle: () => {
    const next = !get().collapsed
    writePersisted(next)
    set({ collapsed: next })
  },
  setCollapsed: (next) => {
    writePersisted(next)
    set({ collapsed: next })
  }
}))

// Cross-window sync. When another renderer window flips the same
// localStorage key, the `storage` event fires here so this store updates
// without a re-read. The event fires only when ANOTHER window writes —
// the originating window already updated via `setCollapsed` / `toggle`.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const next = e.newValue === 'true'
    if (useNavCollapsed.getState().collapsed !== next) {
      useNavCollapsed.setState({ collapsed: next })
    }
  })
}
