// @vitest-environment happy-dom
//
// Sprint 7 D2 — KeyboardHelpModal renders the SHORTCUTS SSoT as a grouped
// list and respects open/close state from the zustand store.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { I18nextProvider } from 'react-i18next'

import i18n from '../../src/shared/i18n'
import { KeyboardHelpModal } from '../../src/shared/components/keyboard/KeyboardHelpModal'
import { closeKeyboardHelp, openKeyboardHelp } from '../../src/shared/state/keyboard-help'

function renderModal(): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <KeyboardHelpModal />
    </I18nextProvider>
  )
}

describe('KeyboardHelpModal', () => {
  beforeEach(() => {
    closeKeyboardHelp()
  })
  afterEach(() => {
    cleanup()
    closeKeyboardHelp()
  })

  test('returns null when store is closed', () => {
    renderModal()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('renders dialog with grouped sections + headliner bindings when open', () => {
    openKeyboardHelp()
    renderModal()
    const dialogs = screen.getAllByRole('dialog')
    expect(dialogs.length).toBeGreaterThanOrEqual(1)
    // The dialog renders the kbd display strings — confirm a few headliners
    // are visible (use queryAll to tolerate any portal residue).
    expect(screen.getAllByText('⌘K').length).toBeGreaterThan(0)
    expect(screen.getAllByText('⌘,').length).toBeGreaterThan(0)
    expect(screen.getAllByText('?').length).toBeGreaterThan(0)
    expect(screen.getAllByText('J').length).toBeGreaterThan(0)
    expect(screen.getAllByText('K').length).toBeGreaterThan(0)
  })

  test('marks unwired bindings with the "soon" pill', () => {
    openKeyboardHelp()
    renderModal()
    // The pill copy comes from i18n; `shortcutHelp.soon` resolves to "soon"
    // in en-US or "即将上线" in zh-CN. We accept either.
    const pills = screen.queryAllByText(/^(soon|即将上线)$/)
    expect(pills.length).toBeGreaterThan(0)
  })

  // 08-27 标签工作区 P2 — 四条标签绑定必须出现在帮助面板里。面板按 keymap 目录
  // 渲染，所以这里真正锁的是「新绑定进了 SSoT 而不是只写在 GlobalShortcuts 里」。
  test('renders the tab-workspace bindings', () => {
    openKeyboardHelp()
    renderModal()
    for (const display of ['⌘W', '⇧⌘T', '⌃⇥ / ⌃⇧⇥', '⌘1-9']) {
      expect(screen.getAllByText(display).length, display).toBeGreaterThan(0)
    }
  })

  // 09-02 对话域拆分 —— 两个域各一条全局直达键。同上：面板按 keymap 目录渲染，这里锁的
  // 是「⌘G 进了 SHORTCUTS 而不是只写在 GlobalShortcuts 里」（只写接线的话按得动、但用户
  // 在帮助面板里永远发现不了它）。
  test('renders the AI Chat / Groups navigation bindings', () => {
    openKeyboardHelp()
    renderModal()
    for (const display of ['⌘O', '⌘G']) {
      expect(screen.getAllByText(display).length, display).toBeGreaterThan(0)
    }
  })
})
