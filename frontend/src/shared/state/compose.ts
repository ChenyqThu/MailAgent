// Compose panel visibility + target state.
//
// ComposePanel overlays the email detail column (reply / reply-all / forward).
// State lives in zustand (not EmailDetail local state) so an ESC handler /
// the toolbar split-button can open/close it without prop drilling, mirroring
// ai-chat-panel.ts. Only one composer is open at a time per window.

import { create } from 'zustand'

import type { ComposeMode } from '@shared/api/types'

interface ComposeStore {
  open: boolean
  /** The source email being replied to / forwarded. null when closed. */
  internalId: number | null
  mode: ComposeMode
  /** Open the composer for a given source email + mode. */
  openCompose(internalId: number, mode: ComposeMode): void
  /** Close the composer (discard / send success / ESC). */
  closeCompose(): void
}

export const useComposeStore = create<ComposeStore>((set) => ({
  open: false,
  internalId: null,
  mode: 'reply',
  openCompose(internalId, mode) {
    set({ open: true, internalId, mode })
  },
  closeCompose() {
    set({ open: false, internalId: null })
  }
}))

/** Module-level helper for non-React callers (keymap / toolbar). */
export function openCompose(internalId: number, mode: ComposeMode): void {
  useComposeStore.getState().openCompose(internalId, mode)
}

export function closeCompose(): void {
  useComposeStore.getState().closeCompose()
}
