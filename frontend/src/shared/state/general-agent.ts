// P3 (task 06-18-custom-ai-harness-agent Phase 3) — General Agent dialog state.
//
// The General Agent is the Cmd+O surface: a context-free Custom AI conversation
// (anchor_type='general') that is NOT tied to any single email. It lives in its
// own centered dialog (GeneralAgentDialog), mounted once at the app root next to
// CommandPalette — deliberately separate from the per-email AIChatPanel store
// (ai-chat-panel.ts) so a general session NEVER bleeds into an email's sidebar.
//
// Same shape as command-palette.ts / keyboard-help.ts: a tiny zustand store +
// module-level helpers for non-React callers (GlobalShortcuts, CommandPalette).

import { create } from 'zustand'

interface GeneralAgentStore {
  /** Whether the General Agent dialog is open. */
  open: boolean
  /** One-shot: a specific general session the dialog should restore on open
   *  (e.g. clicked from the history list). null = "open on the latest / a fresh
   *  conversation". Consumed by GeneralAgentDialog via consumePendingSession. */
  pendingSessionId: number | null
  setOpen(next: boolean): void
  toggle(): void
  /** Open the dialog pinned to a specific general session id. */
  openWithSession(sessionId: number): void
  /** Clear the one-shot pendingSessionId after the dialog applied it. */
  consumePendingSession(): void
}

export const useGeneralAgent = create<GeneralAgentStore>((set, get) => ({
  open: false,
  pendingSessionId: null,
  setOpen(next) {
    set({ open: next })
  },
  toggle() {
    set({ open: !get().open })
  },
  openWithSession(sessionId) {
    set({ open: true, pendingSessionId: sessionId })
  },
  consumePendingSession() {
    set({ pendingSessionId: null })
  }
}))

/** Open the General Agent dialog (Cmd+O / command palette / sidebar). */
export function openGeneralAgent(): void {
  useGeneralAgent.getState().setOpen(true)
}

/** Close the General Agent dialog. */
export function closeGeneralAgent(): void {
  useGeneralAgent.getState().setOpen(false)
}

/** Toggle the General Agent dialog (Cmd+O is a toggle, like ⌘K). */
export function toggleGeneralAgent(): void {
  useGeneralAgent.getState().toggle()
}

/** Open the dialog on a specific general session (history-list click). */
export function openGeneralAgentSession(sessionId: number): void {
  useGeneralAgent.getState().openWithSession(sessionId)
}
