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
// Session selection within the dialog is intra-dialog (useGeneralChat.selectSession),
// so this store only owns open/close — no cross-surface session deep-link.

import { create } from 'zustand'

interface GeneralAgentStore {
  /** Whether the General Agent dialog is open. */
  open: boolean
  setOpen(next: boolean): void
  toggle(): void
}

export const useGeneralAgent = create<GeneralAgentStore>((set, get) => ({
  open: false,
  setOpen(next) {
    set({ open: next })
  },
  toggle() {
    set({ open: !get().open })
  }
}))

/** Open the General Agent dialog (Cmd+O / command palette). */
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
