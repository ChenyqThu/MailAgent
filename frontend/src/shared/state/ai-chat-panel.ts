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
  // Sprint 14 PR A — session history sidebar. Default collapsed so the
  // 360 px panel stays roomy for the message list; user toggles via the
  // history button in the tab bar (AIChatPanel.tsx). Persisted in
  // localStorage by useAIChatSidebarPersist() so a reload restores the
  // last open/closed state.
  sidebarOpen: boolean
  setSidebarOpen(next: boolean): void
  toggleSidebar(): void
}

const SIDEBAR_STORAGE_KEY = 'mailagent.chat.sidebarOpen'

function readPersistedSidebar(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writePersistedSidebar(open: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (open) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, '1')
    } else {
      localStorage.removeItem(SIDEBAR_STORAGE_KEY)
    }
  } catch {
    // localStorage unavailable — in-memory state still works for the session.
  }
}

export const useAIChatPanel = create<AIChatPanelStore>((set, get) => ({
  visible: false,
  setVisible(next) {
    set({ visible: next })
  },
  toggle() {
    set({ visible: !get().visible })
  },
  sidebarOpen: readPersistedSidebar(),
  setSidebarOpen(next) {
    set({ sidebarOpen: next })
    writePersistedSidebar(next)
  },
  toggleSidebar() {
    const next = !get().sidebarOpen
    set({ sidebarOpen: next })
    writePersistedSidebar(next)
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
