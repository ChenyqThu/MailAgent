// @vitest-environment happy-dom
//
// S3 W2 (D6) — read-only transcript of persisted legacy sessions.
//
// The legacy runtime (custom-api engine + MessageList render path) is deleted;
// history rows with backend_kind 'custom-api' / 'notion-agent' must still OPEN
// read-only through the unified assistant-ui path. These tests pin the D6
// contract with fixture rows:
//   - a legacy row WITHOUT ui_message_json degrades to plain text (content
//     fallback in chatMessageToUIMessage) — visible, no crash;
//   - thinking degrades to a collapsible reasoning block;
//   - a row WITH ui_message_json renders its canonical parts;
//   - the thread is read-only: no composer.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import type { ChatMessage } from '@shared/api/types'
import i18n from '@shared/i18n'

// Mock the markdown renderer so the test doesn't pull shiki/streamdown — we only
// care that the text content lands in the bubble.
vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import { ReadOnlyTranscript } from '@shared/assistant/ReadOnlyTranscript'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  // assistant-ui Viewport relies on observers happy-dom lacks; stub them.
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!('IntersectionObserver' in globalThis)) {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return []
      }
    }
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
})

afterEach(() => {
  cleanup()
})

function fakeMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 10,
    role: 'assistant',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

describe('ReadOnlyTranscript (D6) — legacy rows without ui_message_json', () => {
  test('user + assistant plain-text fallback renders; composer suppressed', async () => {
    const messages = [
      fakeMessage({ id: 1, role: 'user', content: '旧 custom-api 提问' }),
      fakeMessage({ id: 2, role: 'assistant', content: '旧引擎的回答文本。' })
    ]
    render(<ReadOnlyTranscript messages={messages} sessionKey={10} />)
    await waitFor(() => expect(screen.getByText('旧 custom-api 提问')).toBeTruthy())
    expect(screen.getByText('旧引擎的回答文本。')).toBeTruthy()
    // Read-only: the composer input never mounts.
    expect(screen.queryByLabelText(i18n.t('chat.composer.placeholder'))).toBeNull()
  })

  test('legacy thinking degrades to the collapsible reasoning block', async () => {
    const messages = [
      fakeMessage({ id: 2, role: 'assistant', content: '答案。', thinking: '先读正文…' })
    ]
    render(<ReadOnlyTranscript messages={messages} sessionKey={11} />)
    await waitFor(() => expect(screen.getByText(i18n.t('chat.thinking.label'))).toBeTruthy())
  })

  test('a retired notion-agent transcript opens read-only (no crash, text visible)', async () => {
    const messages = [
      fakeMessage({ id: 1, role: 'user', content: '旧 notion-agent 提问' }),
      fakeMessage({ id: 2, role: 'assistant', content: '旧 agent 回答' })
    ]
    render(<ReadOnlyTranscript messages={messages} sessionKey={12} />)
    await waitFor(() => expect(screen.getByText('旧 notion-agent 提问')).toBeTruthy())
    expect(screen.getByText('旧 agent 回答')).toBeTruthy()
  })

  test('empty transcript mounts without crashing and stays read-only', () => {
    // Callers gate on messages.length themselves (ChatsTab / the panel show their
    // own empty hint); this pins that an empty mount is safe + composer-free.
    render(<ReadOnlyTranscript messages={[]} sessionKey={13} />)
    expect(screen.queryByLabelText(i18n.t('chat.composer.placeholder'))).toBeNull()
  })
})

describe('ReadOnlyTranscript (D6) — canonical ui_message_json rows', () => {
  test('parses + renders the canonical UIMessage parts', async () => {
    const canonical = JSON.stringify({
      id: 'x',
      role: 'assistant',
      parts: [{ type: 'text', text: '来自 ui_message_json 的正文' }]
    })
    const messages = [
      fakeMessage({ id: 3, role: 'assistant', ui_message_json: canonical, content: '(legacy col)' })
    ]
    render(<ReadOnlyTranscript messages={messages} sessionKey={14} />)
    await waitFor(() => expect(screen.getByText('来自 ui_message_json 的正文')).toBeTruthy())
  })

  test('a MALFORMED ui_message_json blob falls back to content (no crash)', async () => {
    const messages = [
      fakeMessage({ id: 4, role: 'assistant', ui_message_json: '{corrupt', content: '回退正文' })
    ]
    render(<ReadOnlyTranscript messages={messages} sessionKey={15} />)
    await waitFor(() => expect(screen.getByText('回退正文')).toBeTruthy())
  })
})
