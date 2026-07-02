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

import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import { MailAgentRuntimeProvider } from '@shared/assistant/runtime/MailAgentRuntimeProvider'
import type { LegacyRuntimeChat } from '@shared/assistant/runtime/useLegacyExternalStoreRuntime'
import { ThreadRunningBridge } from '@shared/assistant/runtime/ThreadRunningBridge'
import { makeSessionSettledHandler } from '@shared/assistant/runtime/threadRunningGuard'
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

// Part B (island live-refresh) — ThreadRunningBridge is the SENSOR of the panel's mid-stream guard:
// the onSessionUpdated handler skips the reload+remount when the ref reads true, because remounting
// a streaming thread aborts its in-flight POST → gateway onFinish isAborted → the turn is never
// persisted (lost). If the bridge under-reports (stuck false) the race regresses; if it over-reports
// (stuck true after unmount) island live-refresh dies permanently. Driven through the legacy
// provider, whose adapter feeds isRunning from chat.isStreaming — the same thread state the AI SDK
// runtime populates in production.
describe('ThreadRunningBridge — mid-stream guard sensor', () => {
  test('streaming thread → ref true; unmount resets to false (no stale guard)', async () => {
    const runningRef = { current: false }
    const chat = makeChat({
      messages: [
        fakeMessage({ id: 2, role: 'assistant', content: '流式中…', status: 'streaming' })
      ],
      isStreaming: true,
      streamingMessageId: 2
    })
    const { unmount } = render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <ThreadRunningBridge runningRef={runningRef} />
      </MailAgentRuntimeProvider>
    )
    await waitFor(() => expect(runningRef.current).toBe(true))
    unmount()
    expect(runningRef.current).toBe(false)
  })

  test('idle thread → ref stays false (guard never blocks a legit refresh)', async () => {
    const runningRef = { current: false }
    const chat = makeChat({
      messages: [fakeMessage({ id: 2, role: 'assistant', content: '完成。' })]
    })
    render(
      <MailAgentRuntimeProvider chat={chat} onSend={vi.fn()}>
        <ThreadRunningBridge runningRef={runningRef} />
      </MailAgentRuntimeProvider>
    )
    // settle a tick so any effect pass has run before asserting the negative.
    await waitFor(() => expect(runningRef.current).toBe(false))
  })
})

// Part B (island live-refresh, real-device regression) — the guard sensor driven through the REAL
// ai-sdk runtime pipeline (useAISDKRuntime → AISDKMessageConverter → external store → useThread),
// NOT the legacy adapter (the previous tests' blind spot: legacy ChatMessage rows can never carry
// an ai@6 `approval-requested` tool part, so the paused-state semantics were untested and the
// on-device failure slipped through). The chatHelpers stub replaces only the ai@6 useChat layer,
// whose paused-state semantics are known (stream closed → status 'ready'); everything above it —
// where the bug lived — is the production code.
//
// Device condition pinned: at an approval pause assistant-ui's thread.isRunning read TRUE (CDP
// probe: the settle IPC arrived, `aiSdkRunningRef.current === true`, no reload ran) even though the
// gateway had already closed the stream. We force isRunning=true via status:'streaming' and assert
// the settle handler REFRESHES anyway when (and only when) the last message is approval-paused.
describe('ThreadRunningBridge × real ai-sdk runtime — approval-paused vs mid-stream', () => {
  const USER_MSG = { id: 'u-g1', role: 'user', parts: [{ type: 'text', text: '帮我起草回复' }] }
  /** The REAL paused shape: the run ended with a write tool in ai@6 `approval-requested` state. */
  const PAUSED_ASSISTANT = {
    id: 'a-paused',
    role: 'assistant',
    parts: [
      { type: 'text', text: '我准备了草稿，需要你的批准。' },
      {
        type: 'tool-email_draft_reply',
        toolCallId: 'tc-g1',
        state: 'approval-requested',
        input: { internal_id: 5, body_markdown: 'draft' },
        approval: { id: 'ap-g1' }
      }
    ]
  }
  /** A genuinely mid-stream assistant message — text only, no approval gate. */
  const STREAMING_ASSISTANT = {
    id: 'a-live',
    role: 'assistant',
    parts: [{ type: 'text', text: '正在草拟…' }]
  }

  /** Minimal ai@6 useChat surface the runtime touches at render time (status/messages/error);
   *  the action callbacks exist but are never invoked by these render-only tests. */
  function stubChatHelpers(
    status: string,
    messages: unknown[]
  ): Parameters<typeof useAISDKRuntime>[0] {
    return {
      status,
      messages,
      error: undefined,
      setMessages: () => {},
      sendMessage: async () => {},
      regenerate: async () => {},
      stop: () => {},
      addToolResult: () => {},
      addToolOutput: () => {},
      addToolApprovalResponse: () => {}
    } as unknown as Parameters<typeof useAISDKRuntime>[0]
  }

  function AiSdkGuardHarness({
    status,
    messages,
    runningRef
  }: {
    status: string
    messages: unknown[]
    runningRef: { current: boolean }
  }): React.JSX.Element {
    const runtime = useAISDKRuntime(stubChatHelpers(status, messages))
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadRunningBridge runningRef={runningRef} />
      </AssistantRuntimeProvider>
    )
  }

  test('thread paused at approval-requested (isRunning TRUE) → settle reloads + bumps nonce', async () => {
    // start true so the assertion proves the bridge actively drove it false (not "never ran").
    const runningRef = { current: true }
    render(
      <AiSdkGuardHarness
        status="streaming"
        messages={[USER_MSG, PAUSED_ASSISTANT]}
        runningRef={runningRef}
      />
    )
    // the paused state neutralizes the over-reporting isRunning — the guard opens.
    await waitFor(() => expect(runningRef.current).toBe(false))

    const reload = vi.fn().mockResolvedValue(undefined)
    const onReloaded = vi.fn()
    const handler = makeSessionSettledHandler({
      runningRef,
      activeSessionId: 7,
      reload,
      onReloaded
    })
    handler({ sessionId: 7 })
    expect(reload).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onReloaded).toHaveBeenCalledTimes(1))
  })

  test('genuinely mid-stream (no approval gate) → settle stays blocked (turn not aborted)', async () => {
    const runningRef = { current: false }
    render(
      <AiSdkGuardHarness
        status="streaming"
        messages={[USER_MSG, STREAMING_ASSISTANT]}
        runningRef={runningRef}
      />
    )
    await waitFor(() => expect(runningRef.current).toBe(true))

    const reload = vi.fn().mockResolvedValue(undefined)
    const onReloaded = vi.fn()
    const handler = makeSessionSettledHandler({
      runningRef,
      activeSessionId: 7,
      reload,
      onReloaded
    })
    handler({ sessionId: 7 })
    expect(reload).not.toHaveBeenCalled()
    expect(onReloaded).not.toHaveBeenCalled()
  })

  test('settle for another session → ignored regardless of guard state', async () => {
    const runningRef = { current: false }
    const reload = vi.fn().mockResolvedValue(undefined)
    const onReloaded = vi.fn()
    const handler = makeSessionSettledHandler({
      runningRef,
      activeSessionId: 7,
      reload,
      onReloaded
    })
    handler({ sessionId: 8 })
    expect(reload).not.toHaveBeenCalled()
    expect(onReloaded).not.toHaveBeenCalled()
  })
})
