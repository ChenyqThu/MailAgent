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
// ⌘, / ⌘O 的**目标**来自 nav registry（与侧栏、⌘K jump 同一条 entry），**组合键**仍来自
// keymap.ts（registry 只引用它的 binding id）—— 两者都不在本文件写死。
import { navEntry, navigateToNavEntry, navShortcutSpec } from '@shared/navigation/registry'
import { toggleChatModal } from '@shared/state/ai-chat-panel'
import { useCommandPalette } from '@shared/state/command-palette'
import { openKeyboardHelp } from '@shared/state/keyboard-help'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { openNewCompose } from '@shared/state/compose-new'

// 模块级常量：entry 是静态数据，没必要每次 render 再查一次。
const settingsEntry = navEntry('settings')
const generalAgentEntry = navEntry('sessions')

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
    navigateToNavEntry(navigate, settingsEntry)
  }, [navigate])

  // assistant-modal: ⌘J 开关 chat dock（⌘L 的旧侧边面板 toggle 随 legacy 面板退役）。
  // 与上面 ⌘K 同理 —— 只开不关会逼用户改用 Esc / 点 FAB 才能收回，第二次 ⌘J 应该收回。
  // ⌘ 组合键自动跳过 editable-target gating（useShortcut），所以在 chat 输入框里打字时
  // 按 ⌘J 一样能收起 dock。
  const toggleModal = useCallback(() => {
    toggleChatModal()
  }, [])

  // ⌘O — MailAgent 通用 agent 视图 (/sessions)。legacy Cmd+O centered dialog 已随
  // legacy runtime 退役。
  const toggleGeneral = useCallback(() => {
    navigateToNavEntry(navigate, generalAgentEntry)
  }, [navigate])

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
  useShortcut(navShortcutSpec(settingsEntry), goSettings)
  useShortcut('cmd+j', toggleModal)
  useShortcut(navShortcutSpec(generalAgentEntry), toggleGeneral)
  // ⌘N — 写新邮件 (居中模态, ComposeNewModal 挂 RootLayout)。global scope: 任意
  // 页面可开, 与全局侧边栏「写邮件」按钮一致。editable context 默认 short-circuit,
  // chat / 主题输入框打字不误触。
  useShortcut('cmd+n', () => openNewCompose())
  useShortcut('alt+b', toggleNav)
  useShortcut('alt+g', toggleLocale)

  return null
}
