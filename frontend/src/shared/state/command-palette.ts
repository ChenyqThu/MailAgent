// Sprint 7 D3 — open/close state for the ⌘K command palette.
//
// Same pattern as `keyboard-help.ts` — zustand store with a module-level
// helper for non-React callers. The palette component is mounted once at
// the App root.

import { create } from 'zustand'

interface CommandPaletteStore {
  open: boolean
  setOpen(next: boolean): void
  toggle(): void
}

export const useCommandPalette = create<CommandPaletteStore>((set, get) => ({
  open: false,
  setOpen(next) {
    set({ open: next })
  },
  toggle() {
    set({ open: !get().open })
  }
}))

export function openCommandPalette(): void {
  useCommandPalette.getState().setOpen(true)
}

export function closeCommandPalette(): void {
  useCommandPalette.getState().setOpen(false)
}
