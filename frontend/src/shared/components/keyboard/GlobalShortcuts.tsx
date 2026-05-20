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
import i18n from '@shared/i18n'

import { useShortcut } from '@shared/hooks/useShortcut'
import { toggleAIChatPanel } from '@shared/state/ai-chat-panel'
import { useCommandPalette } from '@shared/state/command-palette'
import { openKeyboardHelp } from '@shared/state/keyboard-help'
import { useNavCollapsed } from '@shared/state/nav-shell'

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
    // Sprint 18 PR C — `/settings` now requires a `tab` search param
    // (validateSearch in router-instance.tsx). ⌘, lands the user on the
    // first tab; deep-linking to a specific tab is handled by SettingsRail.
    void navigate({ to: '/settings', search: { tab: 'general' } })
  }, [navigate])

  // Sprint 10 user-acceptance — ⌘L toggles the AI Chat panel (was always
  // mounted before, see ai-chat-panel.ts module doc).
  const toggleAIPanel = useCallback(() => {
    toggleAIChatPanel()
  }, [])

  // Sprint 11 V1.4 — nav-shell collapse + locale toggle.
  const toggleNav = useCallback(() => {
    useNavCollapsed.getState().toggle()
  }, [])
  const toggleLocale = useCallback(() => {
    const cur = (i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN') as 'zh-CN' | 'en-US'
    const next: 'zh-CN' | 'en-US' = cur === 'zh-CN' ? 'en-US' : 'zh-CN'
    void i18n.changeLanguage(next)
  }, [])

  // `?` requires shift on US/UK keyboards; the parser already keys on the
  // resolved char (which is '?' after shift), so spec='?' matches without
  // having to write 'shift+/'.
  useShortcut('?', openHelp)
  useShortcut('cmd+k', togglePalette)
  useShortcut('cmd+,', goSettings)
  useShortcut('cmd+l', toggleAIPanel)
  useShortcut('alt+b', toggleNav)
  useShortcut('alt+g', toggleLocale)

  return null
}
