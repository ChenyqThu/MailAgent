// Sprint 7 D2 — registers the GLOBAL-scope keyboard bindings from
// `@shared/keymap` SSoT. Per-component handlers (J/K row nav, ⌘↩ send,
// ⌥B switch backend) stay where they are — those need access to local
// state. This component owns only the cross-cutting bindings that have
// no natural home:
//
//   - `?`     → open the help modal
//   - `⌘K`    → open the command palette
//   - `⌘,`    → navigate to /settings
//
// Mounted once at the App root next to ToastContainer.

import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useShortcut } from '@shared/hooks/useShortcut'
import { useCommandPalette } from '@shared/state/command-palette'
import { openKeyboardHelp } from '@shared/state/keyboard-help'

export function GlobalShortcuts(): null {
  const navigate = useNavigate()

  const openHelp = useCallback(() => {
    openKeyboardHelp()
  }, [])

  // Sprint 9 D4.2 (Sprint 7 review LOW #1) — ⌘K now toggles the palette
  // instead of just opening it, so a second ⌘K dismisses without forcing
  // Esc. The `toggle()` method existed on the zustand store since Sprint 7
  // but was unreachable (dead code) until now.
  const togglePalette = useCallback(() => {
    useCommandPalette.getState().toggle()
  }, [])

  const goSettings = useCallback(() => {
    void navigate({ to: '/settings' })
  }, [navigate])

  // `?` requires shift on US/UK keyboards; the parser already keys on the
  // resolved char (which is '?' after shift), so spec='?' matches without
  // having to write 'shift+/'.
  useShortcut('?', openHelp)
  useShortcut('cmd+k', togglePalette)
  useShortcut('cmd+,', goSettings)

  return null
}
