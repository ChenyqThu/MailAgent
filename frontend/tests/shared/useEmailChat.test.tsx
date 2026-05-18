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
      fakeMessage({ id: 101, session_id: 7, role: 'assistant', status: 'streaming', content: 'so far' })
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
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: 'so far', status: 'streaming' })
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
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: 'partial', status: 'streaming' })
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
      fakeMessage({ id: 50, session_id: 1, role: 'assistant', content: 'recovered', status: 'streaming' })
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

  test('send() rejects when emailId is null', async () => {
    const { result } = renderHook(() => useEmailChat(null))
    await expect(
      result.current.send({ message: 'hi', backendKind: 'custom-api' })
    ).rejects.toThrow(/no active email/)
    expect(mockChatStart).not.toHaveBeenCalled()
  })
})
