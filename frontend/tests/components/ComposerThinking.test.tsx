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
import { backendSupportsThinking } from '@shared/components/chat/backend_thinking'
import type { BackendChoice } from '@shared/components/chat/BackendSelector'
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

// task 06-08-chat 需求 5 (codex MEDIUM-1) — thinking is Claude-only. The
// AIChatPanel gates the Composer toggle's `thinkingDisabled` AND the per-turn
// send/edit `thinking` flag on this single predicate, so a toggle left ON after
// switching to a non-Claude model (gpt-5.5 via CRS, notion-agent) never sends
// thinking:true.
describe('backendSupportsThinking — model-family gating (codex MEDIUM-1)', () => {
  const choice = (over: Partial<BackendChoice>): BackendChoice => ({
    kind: 'custom-api',
    model: 'claude-sonnet-4-6',
    agentPageId: null,
    ...over
  })

  test('custom-api + claude-sonnet-4-6 → supported', () => {
    expect(backendSupportsThinking(choice({ model: 'claude-sonnet-4-6' }))).toBe(true)
  })

  test('custom-api + claude-opus-4-7 → supported', () => {
    expect(backendSupportsThinking(choice({ model: 'claude-opus-4-7' }))).toBe(true)
  })

  test('custom-api + gpt-5.5 (OpenAI protocol) → NOT supported', () => {
    expect(backendSupportsThinking(choice({ model: 'gpt-5.5' }))).toBe(false)
  })

  test('custom-api + null model → NOT supported', () => {
    expect(backendSupportsThinking(choice({ model: null }))).toBe(false)
  })

  test('notion-agent (model always null) → NOT supported', () => {
    expect(backendSupportsThinking({ kind: 'notion-agent', model: null, agentPageId: null })).toBe(
      false
    )
  })

  test('notion-agent even with a claude model set → NOT supported (kind gate)', () => {
    expect(
      backendSupportsThinking({
        kind: 'notion-agent',
        model: 'claude-sonnet-4-6',
        agentPageId: null
      })
    ).toBe(false)
  })
})
