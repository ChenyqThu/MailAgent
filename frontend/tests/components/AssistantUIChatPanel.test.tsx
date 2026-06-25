// @vitest-environment happy-dom
//
// chat-panel P4 Phase 01 — assistant-ui shell render/interaction coverage.
//
// Exercises the exact composition AssistantUIChatPanel renders for its message
// region — MailAgentRuntimeProvider (legacy ExternalStore adapter) + Assistant
// Thread — driven by a controlled legacy-chat stub. This is the genuinely-new,
// risky path: legacyMessageMapper → ThreadMessageLike → assistant-ui primitives
// → MarkdownText / ReasoningTrace / ToolTraceCard, plus the ConfirmToolDialog
// fallback slot, the Stop↔Send composer swap, and the onNew/onCancel routing.
// The surrounding panel chrome (header / BackendSelector / ContextChips /
// history popover) is reused, already-tested legacy components, so it is not
// re-asserted here.
//
// Streamdown (TranslatedBody) is mocked to a plain <div> — markdown internals
// are covered by its own tests; here we only assert the text reaches the bubble.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { ChatMessage, ChatToolCall } from '@shared/api/types'
import type { LiveToolCall } from '@shared/hooks/useEmailChat'
import i18n from '@shared/i18n'

// Mock the markdown renderer so the test doesn't pull shiki/streamdown — we only
// care that the text content lands in the assistant bubble.
vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import { MailAgentRuntimeProvider } from '@shared/assistant/runtime/MailAgentRuntimeProvider'
import type { LegacyRuntimeChat } from '@shared/assistant/runtime/useLegacyExternalStoreRuntime'
import { AssistantThread } from '@shared/assistant/components/thread'

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

function fakeToolCall(over: Partial<ChatToolCall>): ChatToolCall {
  return {
    id: 900,
    message_id: 2,
    tool_use_id: 'tu-1',
    tool_name: 'email_search',
    input_json: '{"query":"redis"}',
    user_edited_input_json: null,
    output_json: '{"hits":3}',
    status: 'ok',
    duration_ms: 420,
    confirmation_tier: 'silent',
    confirmed_at: null,
    content_offset: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

interface StubOver {
  messages?: ChatMessage[]
  isStreaming?: boolean
  streamingMessageId?: number | null
  liveToolCalls?: Map<number, LiveToolCall[]>
}

function makeChat(
  over: StubOver = {}
): LegacyRuntimeChat & { abortCurrent: ReturnType<typeof vi.fn> } {
  return {
    messages: over.messages ?? [],
    isStreaming: over.isStreaming ?? false,
    streamingMessageId: over.streamingMessageId ?? null,
    liveToolCalls: over.liveToolCalls ?? new Map(),
    abortCurrent: vi.fn()
  }
}

describe('AssistantUIChatPanel shell — content rendering', () => {
  test('user + assistant text render in their bubbles', async () => {
    const chat = makeChat({
      messages: [
        fakeMessage({ id: 1, role: 'user', content: '帮我总结这封邮件' }),
        fakeMessage({ id: 2, role: 'assistant', content: '这封邮件要你本周五前确认续约。' })
      ]
    })
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <AssistantThread emptyState={<div>empty</div>} />
      </MailAgentRuntimeProvider>
    )
    await waitFor(() => expect(screen.getByText('帮我总结这封邮件')).toBeTruthy())
    expect(screen.getByText('这封邮件要你本周五前确认续约。')).toBeTruthy()
  })

  test('thinking renders as a collapsible reasoning block', async () => {
    const chat = makeChat({
      messages: [
        fakeMessage({ id: 2, role: 'assistant', content: '答案。', thinking: '先读正文…' })
      ]
    })
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <AssistantThread emptyState={<div>empty</div>} />
      </MailAgentRuntimeProvider>
    )
    // The collapsible head uses the legacy thinking label key.
    await waitFor(() => expect(screen.getByText(i18n.t('chat.thinking.label'))).toBeTruthy())
  })

  test('settled tool step renders a ToolTraceCard (tool name visible)', async () => {
    const chat = makeChat({
      messages: [fakeMessage({ id: 2, role: 'assistant', content: '找到 3 封。' })]
    })
    const toolCallsByMessage = new Map<number, ChatToolCall[]>([[2, [fakeToolCall({})]]])
    render(
      <MailAgentRuntimeProvider
        chat={chat}
        toolCallsByMessage={toolCallsByMessage}
        onSend={vi.fn()}
      >
        <AssistantThread emptyState={<div>empty</div>} />
      </MailAgentRuntimeProvider>
    )
    await waitFor(() => expect(screen.getByText('email_search')).toBeTruthy())
  })

  test('readOnly thread renders prior messages but suppresses the composer (notion-agent path)', async () => {
    // Phase 06a — a retired notion-agent session opened from history is read-only: its prior
    // messages render via the legacy adapter, but AssistantThread readOnly drops the composer so
    // there is no way to start a new turn on the retired agent.
    const chat = makeChat({
      messages: [
        fakeMessage({ id: 1, role: 'user', content: '旧 notion-agent 提问' }),
        fakeMessage({ id: 2, role: 'assistant', content: '旧 agent 回答' })
      ]
    })
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <AssistantThread emptyState={<div>empty</div>} readOnly />
      </MailAgentRuntimeProvider>
    )
    await waitFor(() => expect(screen.getByText('旧 notion-agent 提问')).toBeTruthy())
    expect(screen.getByText('旧 agent 回答')).toBeTruthy()
    // The composer input is gone (the default-mode tests below prove it is present without readOnly).
    expect(screen.queryByLabelText(i18n.t('chat.composer.placeholder'))).toBeNull()
  })
})

describe('AssistantUIChatPanel shell — interaction', () => {
  test('streaming → composer shows Stop; clicking it calls abortCurrent', async () => {
    const chat = makeChat({
      messages: [fakeMessage({ id: 2, role: 'assistant', content: '正在…', status: 'streaming' })],
      isStreaming: true,
      streamingMessageId: 2
    })
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <AssistantThread emptyState={<div>empty</div>} />
      </MailAgentRuntimeProvider>
    )
    const stop = await screen.findByLabelText(
      i18n.t('chat.composer.cancel', { defaultValue: 'Stop' })
    )
    fireEvent.click(stop)
    await waitFor(() => expect(chat.abortCurrent).toHaveBeenCalledTimes(1))
  })

  test('not streaming → composer shows Send; submitting routes to onSend', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const chat = makeChat({ messages: [] })
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={onSend}>
        <AssistantThread emptyState={<div>empty</div>} />
      </MailAgentRuntimeProvider>
    )
    const input = await screen.findByLabelText(i18n.t('chat.composer.placeholder'))
    fireEvent.change(input, { target: { value: '你好 MailAgent' } })
    const send = screen.getByLabelText(i18n.t('chat.composer.send', { defaultValue: 'Send' }))
    fireEvent.click(send)
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好 MailAgent'))
  })

  test('pending confirmation slot renders the legacy ConfirmToolDialog (not lost)', async () => {
    const chat = makeChat({
      messages: [fakeMessage({ id: 2, role: 'assistant', content: '', status: 'streaming' })],
      isStreaming: true,
      streamingMessageId: 2
    })
    const pendingSlot = (
      <div data-testid="confirm">
        <button type="button">
          {i18n.t('chat.confirmTool.confirm', { defaultValue: 'Confirm' })}
        </button>
        <span>email_flag</span>
      </div>
    )
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <AssistantThread pendingSlot={pendingSlot} emptyState={<div>empty</div>} />
      </MailAgentRuntimeProvider>
    )
    await waitFor(() => expect(screen.getByTestId('confirm')).toBeTruthy())
    expect(screen.getByText('email_flag')).toBeTruthy()
  })
})
