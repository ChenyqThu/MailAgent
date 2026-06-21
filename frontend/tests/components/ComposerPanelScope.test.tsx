// @vitest-environment happy-dom

// Part 1 (task 06-18-custom-ai-harness cleanup) — Composer `panelScope`
// shortcut gating.
//
// Bug: the Cmd+O General Agent dialog reuses <Composer>, but ⌘↩ only fired when
// focus sat under the email-mode `aria-label="ai-chat-panel"` root, so sending
// from the dialog required clicking the button. The fix scopes each Composer to
// its own panel (`panelScope` prop + module-level `activePanelScope()`):
//   - ⌘↩ submits in BOTH the chat panel and the general dialog,
//   - when both panels are mounted, only the composer whose panel holds focus
//     submits (the shared bus is LIFO + re-registers per render, so a naive
//     "inside any panel" check could route the keystroke to the wrong composer),
//   - ⌘O inside the general dialog is consumed so it doesn't cascade to the
//     global ⌘O (which toggles the dialog) and close the dialog mid-typing.

import type { ComponentProps } from 'react'
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, renderHook } from '@testing-library/react'

import { Composer } from '@shared/components/chat/Composer'
import { useShortcut, __resetShortcutBus } from '@shared/hooks/useShortcut'

function baseProps(): ComponentProps<typeof Composer> {
  return {
    value: 'hello',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    isStreaming: false,
    canSend: true,
    backendName: 'sonnet'
  }
}

function press(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })
  )
}

beforeEach(() => __resetShortcutBus())
afterEach(() => {
  __resetShortcutBus()
  cleanup()
})

describe('Composer — panelScope shortcut gating', () => {
  test('⌘↩ sends when focus is inside the general dialog', () => {
    const onSend = vi.fn()
    const { container } = render(
      <div data-general-agent-panel>
        <Composer {...baseProps()} onSend={onSend} panelScope="general" />
      </div>
    )
    container.querySelector('textarea')!.focus()
    press('Enter')
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  test('⌘↩ sends when focus is inside the email-mode chat panel', () => {
    const onSend = vi.fn()
    const { container } = render(
      <div aria-label="ai-chat-panel">
        <Composer {...baseProps()} onSend={onSend} panelScope="chat" />
      </div>
    )
    container.querySelector('textarea')!.focus()
    press('Enter')
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  test('⌘↩ does NOT send when focus is outside any panel', () => {
    const onSend = vi.fn()
    render(<Composer {...baseProps()} onSend={onSend} panelScope="general" />)
    press('Enter')
    expect(onSend).not.toHaveBeenCalled()
  })

  test('two composers mounted — focus in general only submits general (no cross-submit)', () => {
    const chatSend = vi.fn()
    const generalSend = vi.fn()
    const { container } = render(
      <>
        <div aria-label="ai-chat-panel">
          <Composer {...baseProps()} onSend={chatSend} panelScope="chat" />
        </div>
        <div data-general-agent-panel>
          <Composer {...baseProps()} onSend={generalSend} panelScope="general" />
        </div>
      </>
    )
    // textareas[0] = chat, textareas[1] = general
    container.querySelectorAll('textarea')[1]!.focus()
    press('Enter')
    expect(generalSend).toHaveBeenCalledWith('hello')
    expect(chatSend).not.toHaveBeenCalled()
  })

  test('⌘O inside the general dialog is consumed (does not reach the global ⌘O)', () => {
    const globalO = vi.fn()
    // Global handler registered FIRST → fires LAST in the LIFO bus, so it only
    // runs if the Composer did not consume the keystroke.
    renderHook(() => useShortcut('cmd+o', globalO))
    const { container } = render(
      <div data-general-agent-panel>
        <Composer {...baseProps()} panelScope="general" />
      </div>
    )
    container.querySelector('textarea')!.focus()
    press('o')
    expect(globalO).not.toHaveBeenCalled()
  })
})
