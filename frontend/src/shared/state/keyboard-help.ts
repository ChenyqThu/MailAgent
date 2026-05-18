// Sprint 7 D2 — open/close state for the keyboard shortcut help modal (`?`).
//
// Zustand-backed so any component can fire `openKeyboardHelp()` regardless
// of its position in the tree (sidebar bottom item, status-bar pill,
// command palette entry, etc). The modal itself is mounted once at the
// App root next to ToastContainer.

import { create } from 'zustand'

interface KeyboardHelpStore {
  open: boolean
  setOpen(next: boolean): void
}

export const useKeyboardHelp = create<KeyboardHelpStore>((set) => ({
  open: false,
  setOpen(next) {
    set({ open: next })
  }
}))

/** Module-level helper for non-React callers (Sidebar handler closure,
 *  global `?` shortcut binding in App.tsx). Calling it before the store
 *  is hydrated is safe — zustand initializes synchronously on first
 *  import of this module. */
export function openKeyboardHelp(): void {
  useKeyboardHelp.getState().setOpen(true)
}

export function closeKeyboardHelp(): void {
  useKeyboardHelp.getState().setOpen(false)
}
