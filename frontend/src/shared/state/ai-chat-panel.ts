// Sprint 10 user-acceptance follow-up — AI Chat panel visibility state.
//
// Before: AIChatPanel rendered unconditionally as the inbox's fourth column,
// forcing the user into a 4-column layout at 1280px (240 + 340 + flex + 360
// → detail pane squeezed under 320px after gutters).
//
// After: panel is closed by default. Users open it via ⌘L (existing keymap),
// the toolbar's "AI Assistant" icon, or the sidebar AI Agents entries. Same
// pattern as keyboard-help.ts / command-palette.ts — zustand store with
// module-level helpers for non-React callers.

import { create } from 'zustand'

interface AIChatPanelStore {
  visible: boolean
  setVisible(next: boolean): void
  toggle(): void
}

export const useAIChatPanel = create<AIChatPanelStore>((set, get) => ({
  visible: false,
  setVisible(next) {
    set({ visible: next })
  },
  toggle() {
    set({ visible: !get().visible })
  }
}))

export function showAIChatPanel(): void {
  useAIChatPanel.getState().setVisible(true)
}

export function hideAIChatPanel(): void {
  useAIChatPanel.getState().setVisible(false)
}

export function toggleAIChatPanel(): void {
  useAIChatPanel.getState().toggle()
}
