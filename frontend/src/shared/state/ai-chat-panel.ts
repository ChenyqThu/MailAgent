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

import type { ChatBackendKind } from '@shared/api/types'

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
  // Sidebar AI-Agents tabs → "open the panel ON this backend". The panel's
  // backend choice lives in AIChatPanel local state (seeded from
  // localStorage); a sidebar click can't reach into that useState, so it
  // parks the request here and AIChatPanel consumes it on the next render.
  // One-shot: cleared by consumeRequestedBackend() right after it's applied.
  requestedBackendKind: ChatBackendKind | null
  // Global "AI 会话历史" → click a row → jump to that email + load that exact
  // session. The page sets `pendingOpen` + flips the active email; AIChatPanel
  // consumes it once the matching email's sessions are in hand (see
  // consumePendingOpen). One-shot, same lifecycle as requestedBackendKind.
  pendingOpen: { emailId: number; sessionId: number } | null
  requestBackend(kind: ChatBackendKind): void
  consumeRequestedBackend(): void
  requestOpenSession(emailId: number, sessionId: number): void
  consumePendingOpen(): void
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
  },
  requestedBackendKind: null,
  pendingOpen: null,
  requestBackend(kind) {
    set({ requestedBackendKind: kind })
  },
  consumeRequestedBackend() {
    set({ requestedBackendKind: null })
  },
  requestOpenSession(emailId, sessionId) {
    set({ pendingOpen: { emailId, sessionId } })
  },
  consumePendingOpen() {
    set({ pendingOpen: null })
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

/** Open the AI panel and switch it to a specific backend. Used by the
 *  sidebar's "Notion Agent" / "Custom AI" entries so a click lands the user
 *  on the agent they picked instead of wherever the panel was last left. */
export function openAIChatPanelWithBackend(kind: ChatBackendKind): void {
  const s = useAIChatPanel.getState()
  s.requestBackend(kind)
  s.setVisible(true)
}

/** Open the AI panel pinned to a specific (email, session) pair. The caller
 *  is responsible for flipping the active email (active-email store) so the
 *  panel re-keys onto it; this only parks the target session + reveals the
 *  panel. AIChatPanel.selectSession's the row once that email's sessions load. */
export function openAIChatSession(emailId: number, sessionId: number): void {
  const s = useAIChatPanel.getState()
  s.requestOpenSession(emailId, sessionId)
  s.setVisible(true)
}
