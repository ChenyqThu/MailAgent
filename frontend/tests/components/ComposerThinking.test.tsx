// @vitest-environment happy-dom
//
// task 06-08-chat 需求 5 — Composer extended-thinking toggle coverage.
// The thinking toggle button is the new user-facing control (renders only when
// onToggleThinking is provided; coral-active when on; disabled for non-custom-api).
// Render-level coverage of the button states + click callback (the ThinkingChip
// render in MessageList is a trivial `thinking.length > 0 && <ThinkingChip>`
// conditional; the thinking DATA path is covered by custom_api / harness /
// useEmailChat / chat_db suites).

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Composer } from '@shared/components/chat/Composer'
import i18n from '@shared/i18n'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
})

/** Minimal required Composer props — only the thinking toggle props vary per test. */
function baseProps(): React.ComponentProps<typeof Composer> {
  return {
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    isStreaming: false,
    canSend: true,
    backendName: 'sonnet-4-6'
  }
}

describe('Composer — thinking toggle (task 06-08-chat 需求 5)', () => {
  test('no onToggleThinking → no thinking button rendered', () => {
    render(<Composer {...baseProps()} />)
    expect(screen.queryByLabelText(i18n.t('chat.thinking.label'))).toBeNull()
  })

  test('onToggleThinking provided → button renders, off state (aria-pressed=false)', () => {
    render(<Composer {...baseProps()} thinkingEnabled={false} onToggleThinking={vi.fn()} />)
    const btn = screen.getByLabelText(i18n.t('chat.thinking.label'))
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.hasAttribute('disabled')).toBe(false)
  })

  test('thinkingEnabled=true → aria-pressed=true', () => {
    render(<Composer {...baseProps()} thinkingEnabled={true} onToggleThinking={vi.fn()} />)
    expect(screen.getByLabelText(i18n.t('chat.thinking.label')).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  test('click toggles via onToggleThinking', () => {
    const onToggle = vi.fn()
    render(<Composer {...baseProps()} thinkingEnabled={false} onToggleThinking={onToggle} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.thinking.label')))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('thinkingDisabled → button disabled + click is a no-op', () => {
    const onToggle = vi.fn()
    render(
      <Composer
        {...baseProps()}
        thinkingEnabled={false}
        onToggleThinking={onToggle}
        thinkingDisabled={true}
      />
    )
    const btn = screen.getByLabelText(i18n.t('chat.thinking.label'))
    expect(btn.hasAttribute('disabled')).toBe(true)
    fireEvent.click(btn)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
