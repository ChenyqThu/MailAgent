// Sprint 14 PR E — chat popout-window detection.
//
// The renderer hosts two top-level shells: the main inbox (Sidebar +
// EmailList + Detail + AIChatPanel) under TanStack Router, and a
// dedicated popout chrome that renders the AI chat panel full-window
// for a single email. Both shells share the same React entry, but the
// renderer needs to know which one to mount before router init runs
// (the popout shell deliberately does NOT mount the router — it has no
// Sidebar / EmailList / settings nav to drive).
//
// The signal is the URL query `?popout=1&email=N`, set by the main
// process's `createPopoutWindow`. `bootPopoutModeFromQuery` is called
// from `renderer/main.tsx` BEFORE React.render so App.tsx's first
// render already sees the resolved mode (no flash of inbox UI).

import { create } from 'zustand'

interface PopoutModeStore {
  /** True when this renderer instance was launched in popout chrome. */
  isPopout: boolean
  /** internal_id of the email the popout was opened for. */
  emailId: number | null
  setPopout(emailId: number): void
}

export const usePopoutMode = create<PopoutModeStore>((set) => ({
  isPopout: false,
  emailId: null,
  setPopout(emailId) {
    set({ isPopout: true, emailId })
  }
}))

/**
 * Inspect `window.location.search` for `popout=1&email=N` and set the
 * store accordingly. Idempotent + safe to call before React.render.
 * Returns the resolved emailId (null when not a popout) so the caller
 * can decide whether to fire any other early-init side effects.
 */
export function bootPopoutModeFromQuery(): number | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.get('popout') !== '1') return null
  const emailIdStr = params.get('email')
  if (emailIdStr === null) return null
  const emailId = parseInt(emailIdStr, 10)
  if (!Number.isFinite(emailId) || emailId < 0) return null
  usePopoutMode.getState().setPopout(emailId)
  return emailId
}
