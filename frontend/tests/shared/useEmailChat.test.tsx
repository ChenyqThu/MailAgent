// @vitest-environment happy-dom
//
// Sprint 4 §2.1 — useEmailChat hook contract.
//
// The hook is the single React adapter on top of `mailApi.chat`. Tests
// mock useMailApi so we can drive a controlled stream + assert:
//   - load sessions on emailId switch
//   - chunk events grow the streaming assistant content in place
//   - done events flip to complete + refresh from SSoT
//   - error events surface in the `error` slot
//   - emailId switch fires chat.abort(prevSessionId)
//   - unmount fires chat.abort(currentSessionId)
//   - tool_call events trigger a refetch (so role=tool rows materialize)
//
// We do NOT test the Electron IPC bridge here — that's covered by the
// dispatcher tests. The hook only sees the mailApi.chat surface.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useEmailChat } from '../../src/shared/hooks/useEmailChat'
import type {
  ChatMessage,
  ChatSession,
  ChatStartResult,
  ChatStreamEnvelope
} from '../../src/shared/api/types'

// IMPORTANT: useEmailChat's `useEffect`s have `mailApi` in their dep arrays,
// so the mock MUST return the same object reference on every call — a
// fresh `{...}` literal per render triggers an effect → setState → render
// → fresh literal loop that vitest's worker reports as
// `Worker terminated due to reaching memory limit: JS heap out of memory`.
// `vi.hoisted` builds the stable singleton once and reuses it.
const {
  stableMailApi,
  mockChatStart,
  mockChatAbort,
  mockChatListMessages,
  mockChatListSessions,
  streamHandlers
} = vi.hoisted(() => {
  const handlers: Array<(env: ChatStreamEnvelope) => void> = []
  const mockChatStart = vi.fn<(o: unknown) => Promise<ChatStartResult>>()
  const mockChatAbort = vi.fn()
  const mockChatListMessages = vi.fn<(id: number) => Promise<ChatMessage[]>>()
  const mockChatListSessions = vi.fn<(id: number) => Promise<ChatSession[]>>()
  const stableMailApi = {
    email: {
      list: vi.fn(),
      listEnriched: vi.fn(),
      listMailboxes: vi.fn(),
      listByThread: vi.fn(),
      get: vi.fn(),
      body: vi.fn(),
      aiFields: vi.fn(),
      search: vi.fn(),
      resync: vi.fn()
    },
    attachment: { list: vi.fn(), localPath: vi.fn() },
    ai: { translate: vi.fn(), abortTranslate: vi.fn() },
    chat: {
      start: mockChatStart,
      abort: mockChatAbort,
      listMessages: mockChatListMessages,
      listSessions: mockChatListSessions,
      onStream: (handler: (env: ChatStreamEnvelope) => void): (() => void) => {
        handlers.push(handler)
        return () => {
          const i = handlers.indexOf(handler)
          if (i >= 0) handlers.splice(i, 1)
        }
      }
    },
    // Sprint 9 §2.3 — useEmailChat fires AIDraftStart/Stream/Ready envelopes
    // via the island bridge. The mock keeps them as plain spies so tests
    // can assert call count + payload shape if they care.
    island: {
      status: vi.fn(),
      testConnection: vi.fn(),
      setEnabled: vi.fn(),
      appearance: vi.fn(),
      aiDraftStart: vi.fn(),
      aiDraftStream: vi.fn(),
      aiDraftReady: vi.fn(),
      onEvent: vi.fn(() => () => undefined)
    }
  }
  return {
    stableMailApi,
    mockChatStart,
    mockChatAbort,
    mockChatListMessages,
    mockChatListSessions,
    streamHandlers: handlers
  }
})

function emitStream(env: ChatStreamEnvelope): void {
  for (const h of streamHandlers) h(env)
}

vi.mock('../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

function fakeMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 1,
    role: 'user',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

function fakeSession(over: Partial<ChatSession>): ChatSession {
  return {
    id: 1,
    email_id: 101,
    backend_kind: 'custom-api',
    backend_model: null,
    backend_agent_page_id: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  streamHandlers.length = 0
  mockChatListSessions.mockResolvedValue([])
  mockChatListMessages.mockResolvedValue([])
  // Sprint 7 review (opus HIGH) — defensive localStorage cleanup.
  // `useEmailChat`'s lazy initializer reads `mailagent.chat.quotaCooldownUntil`
  // at mount. Sprint 7 added more localStorage-touching tests (keyboard-help,
  // command-palette, sidebar.* keys). If a prior worker left a future-dated
  // cooldown ts in localStorage, fresh `useEmailChat()` mounts would start
  // in cooldown state and the stream-event tests at line ~300 would observe
  // stale `tokens_output: null` instead of the patched-from-done value.
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  } catch {
    /* happy-dom file-backed localStorage may throw; ignore */
  }
})

afterEach(() => {
  cleanup()
})

describe('useEmailChat — initial load', () => {
  test('emailId=null yields empty messages, no API calls', () => {
    const { result } = renderHook(() => useEmailChat(null))
    expect(result.current.messages).toEqual([])
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.isStreaming).toBe(false)
    expect(mockChatListSessions).not.toHaveBeenCalled()
  })

  test('emailId set with no sessions → empty messages, null activeSessionId', async () => {
    mockChatListSessions.mockResolvedValue([])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalledWith(101))
    expect(result.current.messages).toEqual([])
    expect(result.current.activeSessionId).toBeNull()
  })

  test('emailId set with sessions → loads messages of the latest', async () => {
    mockChatListSessions.mockResolvedValue([
      fakeSession({ id: 7, updated_at: 1_700_000_200_000 }),
      fakeSession({ id: 6, updated_at: 1_700_000_100_000 })
    ])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 7, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 7, role: 'assistant', content: 'hello' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.messages.length).toBe(2))
    expect(result.current.activeSessionId).toBe(7)
    expect(mockChatListMessages).toHaveBeenCalledWith(7)
  })

  test('still-streaming assistant on load is reported as the streaming target', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 7, role: 'user' }),
      fakeMessage({
        id: 101,
        session_id: 7,
        role: 'assistant',
        status: 'streaming',
        content: 'so far'
      })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))
    expect(result.current.isStreaming).toBe(true)
  })

  test('listSessions throws → error state populated', async () => {
    mockChatListSessions.mockRejectedValue(new Error('db locked'))
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.code).toBe('E_LOAD')
    expect(result.current.error?.message).toBe('db locked')
  })
})

describe('useEmailChat — send + stream', () => {
  test('send() calls chat.start with full opts and resets error', async () => {
    mockChatListSessions.mockResolvedValue([])
    mockChatStart.mockResolvedValue({
      sessionId: 1,
      userMessageId: 100,
      assistantMessageId: 101
    })
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalled())

    await act(async () => {
      await result.current.send({
        message: 'hi',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6'
      })
    })
    expect(mockChatStart).toHaveBeenCalledWith({
      emailId: 101,
      message: 'hi',
      backendKind: 'custom-api',
      backendModel: 'claude-sonnet-4-6',
      backendAgentPageId: null
    })
    expect(result.current.activeSessionId).toBe(1)
    expect(result.current.streamingMessageId).toBe(101)
  })

  test('chunk event grows assistant content in place', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.messages.length).toBe(2))

    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'chunk', delta: 'Hello ' }
      })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'chunk', delta: 'world' }
      })
    })

    const assistant = result.current.messages.find((m) => m.id === 101)!
    expect(assistant.content).toBe('Hello world')
    expect(assistant.status).toBe('streaming')
  })

  test('done event flips status to complete + clears streamingMessageId + refetches', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'so far',
        status: 'streaming'
      })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))

    // After done, refresh returns the canonical complete message.
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'so far and final',
        status: 'complete',
        tokens_input: 5,
        tokens_output: 4,
        cost_usd: 0.0002,
        model: 'claude'
      })
    ])

    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'done', finalContent: 'so far and final', model: 'claude' }
      })
    })

    await waitFor(() => expect(result.current.streamingMessageId).toBeNull())
    const assistant = result.current.messages.find((m) => m.id === 101)!
    expect(assistant.status).toBe('complete')
    expect(assistant.content).toBe('so far and final')
    expect(assistant.tokens_output).toBe(4)
  })

  test('error event surfaces in error slot + clears streamingMessageId', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'partial',
        status: 'streaming'
      })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))

    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'E_QUOTA', message: 'quota exceeded' }
      })
    })

    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.error?.code).toBe('E_QUOTA')
    expect(result.current.error?.message).toBe('quota exceeded')
    const assistant = result.current.messages.find((m) => m.id === 101)!
    expect(assistant.status).toBe('error')
    expect(assistant.error_message).toBe('quota exceeded')
  })

  test('tool_call event triggers a refresh (role=tool row materializes)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.messages.length).toBe(2))

    // After tool_call, the refetch returns 3 rows.
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user' }),
      fakeMessage({ id: 99, session_id: 1, role: 'tool', content: '{"name":"x"}' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', status: 'streaming' })
    ])
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'tool_call', name: 'x', args: {}, status: 'ok' }
      })
    })
    await waitFor(() => expect(result.current.messages.length).toBe(3))
  })

  test('event for a different session is ignored', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))

    act(() => {
      emitStream({
        sessionId: 99,
        messageId: 9999,
        event: { type: 'chunk', delta: 'leak' }
      })
    })
    const assistant = result.current.messages.find((m) => m.id === 101)!
    expect(assistant.content).toBe('')
  })

  test('event for unknown messageId schedules a refresh (recovers state)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))

    // Initial render: messages=[]. A streaming chunk arrives for a
    // message we don't yet know about. The hook should refetch rather
    // than silently drop the event.
    mockChatListMessages.mockClear()
    mockChatListMessages.mockResolvedValue([
      fakeMessage({
        id: 50,
        session_id: 1,
        role: 'assistant',
        content: 'recovered',
        status: 'streaming'
      })
    ])
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 50,
        event: { type: 'chunk', delta: 'recovered' }
      })
    })
    await waitFor(() => expect(mockChatListMessages).toHaveBeenCalled())
    await waitFor(() => expect(result.current.messages.length).toBe(1))
  })
})

describe('useEmailChat — abort + lifecycle', () => {
  test('emailId switch fires chat.abort with the prior session', async () => {
    mockChatListSessions.mockResolvedValueOnce([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValueOnce([
      fakeMessage({ id: 101, session_id: 7, role: 'assistant', content: 'a', status: 'streaming' })
    ])
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useEmailChat(id), {
      initialProps: { id: 101 }
    })
    await waitFor(() => expect(result.current.activeSessionId).toBe(7))

    mockChatListSessions.mockResolvedValueOnce([fakeSession({ id: 8, email_id: 202 })])
    mockChatListMessages.mockResolvedValueOnce([])
    rerender({ id: 202 })

    await waitFor(() => expect(mockChatAbort).toHaveBeenCalledWith(7))
  })

  test('unmount fires chat.abort on the active session', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([])
    const { unmount, result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(7))
    unmount()
    expect(mockChatAbort).toHaveBeenCalledWith(7)
  })

  test('abortCurrent() fires chat.abort on the active session', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(7))
    act(() => result.current.abortCurrent())
    expect(mockChatAbort).toHaveBeenCalledWith(7)
  })

  test('abortCurrent() clears streamingMessageId + refreshes (codex M carry-forward)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 7, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 7,
        role: 'assistant',
        content: 'partial',
        status: 'streaming'
      })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))

    // The SSoT refresh after the abort should pull the row in its
    // canonical post-abort shape — streaming flipped to 'aborted'.
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 7, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 7,
        role: 'assistant',
        content: 'partial',
        status: 'aborted'
      })
    ])

    act(() => result.current.abortCurrent())

    // Sync drop of streamingMessageId so the UI exits its "Streaming…" state
    // immediately rather than after the next chat:stream event lands.
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)

    await waitFor(() => {
      const assistant = result.current.messages.find((m) => m.id === 101)!
      expect(assistant.status).toBe('aborted')
    })
  })

  test('send() resolved after email switch aborts the stranded session (codex High carry-forward)', async () => {
    // chat.start hangs so we can switch email mid-promise.
    mockChatListSessions.mockResolvedValue([])
    mockChatListMessages.mockResolvedValue([])
    let resolveStart: ((v: ChatStartResult) => void) | null = null
    mockChatStart.mockImplementation(
      () =>
        new Promise<ChatStartResult>((res) => {
          resolveStart = res
        })
    )

    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useEmailChat(id), {
      initialProps: { id: 101 }
    })
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalledWith(101))

    // Fire send() — promise stays pending.
    let sendPromise: Promise<ChatStartResult> | null = null
    act(() => {
      sendPromise = result.current.send({ message: 'hi', backendKind: 'custom-api' })
    })
    await waitFor(() => expect(resolveStart).not.toBeNull())

    // Switch email before the pending start() resolves.
    rerender({ id: 202 })
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalledWith(202))

    // Now resolve start() — the hook should detect the stale generation
    // and abort instead of mutating state for email 101.
    resolveStart!({ sessionId: 999, userMessageId: 1000, assistantMessageId: 1001 })
    await sendPromise

    expect(mockChatAbort).toHaveBeenCalledWith(999)
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.activeSessionId).toBeNull()
  })

  test('clearError() resets the error slot', async () => {
    mockChatListSessions.mockRejectedValue(new Error('db locked'))
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })

  test('E_QUOTA error engages a 5-min cooldown (state machine #4)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))
    expect(result.current.quotaCooldownUntil).toBeNull()

    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'E_QUOTA', message: 'quota exhausted' }
      })
    })

    expect(result.current.quotaCooldownUntil).not.toBeNull()
    // Cooldown lifts ~5 minutes from now; just confirm it's far in the future.
    if (result.current.quotaCooldownUntil !== null) {
      expect(result.current.quotaCooldownUntil - Date.now()).toBeGreaterThan(4 * 60 * 1000)
    }
  })

  test('retryLast is null when no error / no failed input (state machine #3)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))
    expect(result.current.retryLast).toBeNull()
  })

  test('retryLast resurfaces after a retriable error and re-fires the last input', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    mockChatStart.mockResolvedValue({
      sessionId: 1,
      userMessageId: 100,
      assistantMessageId: 101
    })
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))

    // Fire a send + emit a network error to surface retryLast.
    await act(async () => {
      await result.current.send({
        message: 'hi',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6'
      })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'E_NETWORK', message: 'network down' }
      })
    })
    expect(result.current.retryLast).not.toBeNull()

    // Calling retryLast re-fires chat.start with the captured input.
    mockChatStart.mockClear()
    await act(async () => {
      await result.current.retryLast?.()
    })
    expect(mockChatStart).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'hi',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6'
      })
    )
  })

  test('non-retriable error (E_NO_LLM_KEY) keeps retryLast null', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    mockChatStart.mockResolvedValue({
      sessionId: 1,
      userMessageId: 100,
      assistantMessageId: 101
    })
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))

    await act(async () => {
      await result.current.send({ message: 'hi', backendKind: 'custom-api' })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'E_NO_LLM_KEY', message: 'no key' }
      })
    })
    expect(result.current.error?.code).toBe('E_NO_LLM_KEY')
    // Config errors don't get a Retry CTA (blind retry won't fix a missing key).
    expect(result.current.retryLast).toBeNull()
  })

  test('send() rejects when emailId is null', async () => {
    const { result } = renderHook(() => useEmailChat(null))
    await expect(result.current.send({ message: 'hi', backendKind: 'custom-api' })).rejects.toThrow(
      /no active email/
    )
    expect(mockChatStart).not.toHaveBeenCalled()
  })

  // Sprint 6 Day 1 (opus LOW carry-forward) — broadened RETRIABLE_ERROR_CODES.
  // E_NOTION_AGENT_FAIL + raw Anthropic mid-stream types should now surface
  // a Retry CTA so the user can re-fire instead of being stuck.
  test('E_NOTION_AGENT_FAIL is retriable (Sprint 6 Day 1)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    mockChatStart.mockResolvedValue({
      sessionId: 1,
      userMessageId: 100,
      assistantMessageId: 101
    })
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))

    await act(async () => {
      await result.current.send({ message: 'hi', backendKind: 'notion-agent' })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'E_NOTION_AGENT_FAIL', message: 'notion-agent exited 1' }
      })
    })
    expect(result.current.error?.code).toBe('E_NOTION_AGENT_FAIL')
    expect(result.current.retryLast).not.toBeNull()
  })

  test('Anthropic raw mid-stream overloaded_error is retriable (Sprint 6 Day 1)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    mockChatStart.mockResolvedValue({
      sessionId: 1,
      userMessageId: 100,
      assistantMessageId: 101
    })
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))

    await act(async () => {
      await result.current.send({ message: 'hi', backendKind: 'custom-api' })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'overloaded_error', message: 'Claude is overloaded' }
      })
    })
    expect(result.current.retryLast).not.toBeNull()
  })

  // Sprint 6 Day 1 (opus LOW carry-forward) — quotaCooldownUntil now
  // persists to localStorage so a reload inside the 5-min window still
  // throttles. The lazy useState initializer reads the persisted value on
  // mount; the setter mirrors via useEffect.
  //
  // happy-dom 20.x ships a file-backed localStorage that throws unless the
  // `--localstorage-file` flag was provided; we don't want to plumb that
  // into vitest just for one test, so each case installs a per-test
  // in-memory stub via vi.stubGlobal + tears it down with restoreAllMocks
  // (covered by the existing afterEach).
  function withStubbedStorage(seed: Record<string, string> = {}): Record<string, string> {
    const memory: Record<string, string> = { ...seed }
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in memory ? memory[k] : null),
      setItem: (k: string, v: string) => {
        memory[k] = v
      },
      removeItem: (k: string) => {
        delete memory[k]
      },
      clear: () => {
        for (const k of Object.keys(memory)) delete memory[k]
      },
      key: (i: number) => Object.keys(memory)[i] ?? null,
      get length() {
        return Object.keys(memory).length
      }
    })
    return memory
  }

  test('quotaCooldownUntil hydrates from localStorage on mount', async () => {
    const future = Date.now() + 240_000
    withStubbedStorage({ 'mailagent.chat.quotaCooldownUntil': String(future) })
    mockChatListSessions.mockResolvedValue([])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalled())
    expect(result.current.quotaCooldownUntil).toBe(future)
    vi.unstubAllGlobals()
  })

  test('quotaCooldownUntil ignores expired localStorage entry', async () => {
    const memory = withStubbedStorage({
      'mailagent.chat.quotaCooldownUntil': String(Date.now() - 5000)
    })
    mockChatListSessions.mockResolvedValue([])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalled())
    expect(result.current.quotaCooldownUntil).toBeNull()
    // Expired entry was GC'd on read.
    expect(memory['mailagent.chat.quotaCooldownUntil']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  test('E_QUOTA error persists cooldown to localStorage', async () => {
    const memory = withStubbedStorage()
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'error', code: 'E_QUOTA', message: 'quota exhausted' }
      })
    })
    await waitFor(() =>
      expect(memory['mailagent.chat.quotaCooldownUntil']).toBeDefined()
    )
    expect(parseInt(memory['mailagent.chat.quotaCooldownUntil']!, 10)).toBe(
      result.current.quotaCooldownUntil!
    )
    vi.unstubAllGlobals()
  })
})

describe('useEmailChat — Sprint 10 reviewer L1/L2/L3 island envelope contracts', () => {
  // We need to drive the Date.now()-based 500ms throttle gate without freezing
  // React's setTimeout-based scheduling (which waitFor + the hook's useEffect
  // bookkeeping depend on). vitest's `toFake: ['Date']` keeps `setTimeout` /
  // `queueMicrotask` real while making `vi.setSystemTime(...)` shift Date.now()
  // freely.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-18T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('L1 throttle — 3 chunks within 500ms emit aiDraftStream once', async () => {
    mockChatListSessions.mockResolvedValue([])
    mockChatStart.mockResolvedValue({
      sessionId: 5,
      userMessageId: 100,
      assistantMessageId: 101
    })
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 5, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 5, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalled())

    await act(async () => {
      await result.current.send({
        message: 'compose',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6',
        senderName: 'John Smith',
        subject: 'Q1 plan'
      })
    })

    // L3 — AIDraftStart fired with the plumbed-through sender/subject.
    expect(stableMailApi.island.aiDraftStart).toHaveBeenCalledTimes(1)
    expect(stableMailApi.island.aiDraftStart).toHaveBeenCalledWith({
      emailId: 101,
      senderName: 'John Smith',
      subject: 'Q1 plan',
      prompt: 'compose'
    })

    // First chunk → emits (last-fire was 0 ms, gate `now - last >= 500`
    // is true on the first event).
    act(() => {
      emitStream({ sessionId: 5, messageId: 101, event: { type: 'chunk', delta: 'aaa' } })
    })
    // Within the 500ms window — second chunk should NOT emit.
    vi.setSystemTime(new Date('2026-05-18T00:00:00.100Z'))
    act(() => {
      emitStream({ sessionId: 5, messageId: 101, event: { type: 'chunk', delta: 'bbb' } })
    })
    // Still within 500ms — third chunk also throttled.
    vi.setSystemTime(new Date('2026-05-18T00:00:00.300Z'))
    act(() => {
      emitStream({ sessionId: 5, messageId: 101, event: { type: 'chunk', delta: 'ccc' } })
    })

    expect(stableMailApi.island.aiDraftStream).toHaveBeenCalledTimes(1)
    expect(stableMailApi.island.aiDraftStream).toHaveBeenCalledWith({
      emailId: 101,
      streamedChars: 3 // "aaa".length — first emit captures content at that moment
    })

    // Advance past the 500ms gate — next chunk fires again.
    vi.setSystemTime(new Date('2026-05-18T00:00:00.700Z'))
    act(() => {
      emitStream({ sessionId: 5, messageId: 101, event: { type: 'chunk', delta: 'ddd' } })
    })
    expect(stableMailApi.island.aiDraftStream).toHaveBeenCalledTimes(2)
    expect(stableMailApi.island.aiDraftStream).toHaveBeenLastCalledWith({
      emailId: 101,
      streamedChars: 12 // "aaa"+"bbb"+"ccc"+"ddd"
    })
  })

  test('L1 trailing flush — done event emits final aiDraftStream + aiDraftReady', async () => {
    mockChatListSessions.mockResolvedValue([])
    mockChatStart.mockResolvedValue({
      sessionId: 5,
      userMessageId: 100,
      assistantMessageId: 101
    })
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 5, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 5, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalled())
    await act(async () => {
      await result.current.send({
        message: 'hi',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6',
        senderName: 'Alice',
        subject: 'Demo'
      })
    })

    // Emit a single chunk that lands on the gate (count becomes 1).
    act(() => {
      emitStream({ sessionId: 5, messageId: 101, event: { type: 'chunk', delta: 'aaa' } })
    })
    expect(stableMailApi.island.aiDraftStream).toHaveBeenCalledTimes(1)

    // Emit done — should emit the trailing AIDraftStream + then AIDraftReady,
    // using sender/subject from the session-meta map (L3).
    act(() => {
      emitStream({
        sessionId: 5,
        messageId: 101,
        event: { type: 'done', finalContent: 'aaa final', model: 'claude-sonnet-4-6' }
      })
    })

    // Trailing flush — 2nd stream emit captures final char count.
    expect(stableMailApi.island.aiDraftStream).toHaveBeenCalledTimes(2)
    expect(stableMailApi.island.aiDraftStream).toHaveBeenLastCalledWith({
      emailId: 101,
      streamedChars: 3 // streamedCharsRef stayed at "aaa".length
    })
    expect(stableMailApi.island.aiDraftReady).toHaveBeenCalledTimes(1)
    expect(stableMailApi.island.aiDraftReady).toHaveBeenCalledWith({
      emailId: 101,
      senderName: 'Alice',
      subject: 'Demo',
      preview: 'aaa final'
    })
  })

  test('L2 — session-meta map binds emailId at send() so chunk envelopes never leak', async () => {
    // Defensive contract: aiDraftStream's emailId comes from the session
    // metadata map keyed by the chunk's sessionId, NOT from emailIdRef.
    // Even if a future refactor flipped emailIdRef under us, the envelope
    // payload would still target the email the session originated on.
    mockChatListSessions.mockResolvedValue([])
    mockChatStart.mockResolvedValue({
      sessionId: 5,
      userMessageId: 100,
      assistantMessageId: 101
    })
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 5, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 5, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(mockChatListSessions).toHaveBeenCalled())

    await act(async () => {
      await result.current.send({
        message: 'compose',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6',
        senderName: 'Author A',
        subject: 'Email 101'
      })
    })
    act(() => {
      emitStream({ sessionId: 5, messageId: 101, event: { type: 'chunk', delta: 'xxx' } })
    })
    expect(stableMailApi.island.aiDraftStream).toHaveBeenCalledTimes(1)
    // emailId on the wire equals the email at send() time (101), not whatever
    // the hook's current `emailId` prop happens to be.
    expect(stableMailApi.island.aiDraftStream.mock.calls[0][0].emailId).toBe(101)
  })
})
