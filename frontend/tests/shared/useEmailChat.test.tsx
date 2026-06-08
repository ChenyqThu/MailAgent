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
  mockChatEditMessage,
  mockChatListMessages,
  mockChatListSessions,
  streamHandlers
} = vi.hoisted(() => {
  const handlers: Array<(env: ChatStreamEnvelope) => void> = []
  const mockChatStart = vi.fn<(o: unknown) => Promise<ChatStartResult>>()
  const mockChatAbort = vi.fn()
  const mockChatEditMessage = vi.fn<(o: unknown) => Promise<ChatStartResult>>()
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
      editMessage: mockChatEditMessage,
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
    mockChatEditMessage,
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
    thinking: null,
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
      backendAgentPageId: null,
      // Sprint 19 — useEmailChat 透传 activeSessionId (首次 send + 空 sessions
      // list → null) 让 dispatcher 落到正确 session row.
      sessionId: null
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

  // task 06-08-chat Bug 1 — after the 3c cutover `finalizeMessage` is an
  // async PATCH; the harness forwards `done` synchronously via the in-process
  // emitter, so the done-handler's refresh (a GET) can read the assistant row
  // while it's STILL `streaming`. The fix passes syncStreaming=false on the
  // done path, so even a racing refresh that returns a streaming row must NOT
  // re-set streamingMessageId — otherwise the panel stays stuck in "Streaming…"
  // until the user clicks abort.
  test('done event keeps streamingMessageId null even if the racing refresh still returns a streaming row', async () => {
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

    // The finalize PATCH hasn't landed yet — the post-done refresh still sees
    // the row in `streaming` state (the exact race the cutover introduced).
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'so far and final',
        status: 'streaming'
      })
    ])

    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'done', finalContent: 'so far and final', model: 'claude' }
      })
    })

    // Local done handling cleared streamingMessageId synchronously.
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)

    // Let the racing refresh (GET) resolve; it must NOT resurrect the
    // streaming target despite the row still reading `streaming`.
    await waitFor(() => expect(mockChatListMessages).toHaveBeenCalledTimes(2))
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)
    // The done event's finalContent still applied to the bubble (so the user
    // sees the completed answer, marked complete by the local reducer).
    const assistant = result.current.messages.find((m) => m.id === 101)!
    expect(assistant.content).toBe('so far and final')
  })

  // task 06-08-chat Bug 1 (codex MEDIUM finding) — the real harness order is
  // forward(done) → await finalizeMessage(); usage/token/cost/model are ONLY
  // persisted by that finalize. A racing post-done refresh (GET) that lands in
  // the gap returns the row still `streaming`, tokens=null, stale content. The
  // terminal-id merge must keep the local complete bubble (with the reducer's
  // finalContent + usage) instead of overwriting it with that stale row.
  test('done event: a racing refresh with a stale streaming row does not overwrite local complete state / token+cost', async () => {
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

    // The post-done refresh races the finalize PATCH: the row is still
    // streaming, token/cost not yet written, and content is the pre-final
    // partial. Using this verbatim would roll the bubble back to streaming and
    // wipe the usage the done/usage reducers set locally.
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'so far', // stale partial — finalContent not persisted yet
        status: 'streaming', // finalize hasn't flipped it to complete yet
        tokens_input: null,
        tokens_output: null,
        cost_usd: null,
        model: null
      })
    ])

    // Drive a usage event (token/cost/model land via the local reducer first,
    // mirroring custom-api emitting usage just before done) then done.
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: {
          type: 'usage',
          inputTokens: 5,
          outputTokens: 4,
          costUsd: 0.0002,
          model: 'claude'
        }
      })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'done', finalContent: 'so far and final', model: 'claude' }
      })
    })

    // Let the racing refresh (GET) resolve.
    await waitFor(() => expect(mockChatListMessages).toHaveBeenCalledTimes(2))

    const assistant = result.current.messages.find((m) => m.id === 101)!
    // Local terminal state survives the stale row: complete, finalContent kept,
    // and the finalize-only fields (token/cost/model) NOT clobbered back to null.
    expect(assistant.status).toBe('complete')
    expect(assistant.content).toBe('so far and final')
    expect(assistant.tokens_input).toBe(5)
    expect(assistant.tokens_output).toBe(4)
    expect(assistant.cost_usd).toBe(0.0002)
    expect(assistant.model).toBe('claude')
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)
  })

  // task 06-08-chat Bug 1 (codex HIGH finding) — done's OWN refresh passes
  // syncStreaming=false, but other refresh callsites (tool_call mid-stream,
  // idx=-1 recovery, send, abort) pass syncStreaming=true. A refresh(true)
  // issued BEFORE done but resolving AFTER it would re-derive
  // streamingMessageId from the not-yet-finalized streaming row and resurrect
  // the spinner. The terminal-id guard must make the streaming re-derive skip
  // ids we already finished, even on a syncStreaming=true refresh.
  test('a late refresh(true) (e.g. tool_call) resolving after done does not resurrect the spinner', async () => {
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

    // Make the NEXT listMessages call hang so we can land it AFTER done. This
    // is the tool_call branch's refresh(true) (notion-agent multi-turn) that
    // was inflight when the turn finished.
    let resolveLate: ((rows: ChatMessage[]) => void) | null = null
    mockChatListMessages.mockImplementationOnce(
      () =>
        new Promise<ChatMessage[]>((res) => {
          resolveLate = res
        })
    )

    // Fire tool_call → schedules refresh(envelope.sessionId) [syncStreaming
    // defaults to true]. Its listMessages promise is the pending one above.
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'tool_call', name: 'x', args: {}, status: 'ok' }
      })
    })
    await waitFor(() => expect(resolveLate).not.toBeNull())

    // done lands first (synchronous emitter). done's own refresh(false) reads
    // the default mock; we don't care about its rows here — only that the
    // tool_call refresh (still pending) can't undo the terminal state.
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'done', finalContent: 'so far and final', model: 'claude' }
      })
    })
    expect(result.current.streamingMessageId).toBeNull()

    // NOW resolve the late tool_call refresh with a row still reading
    // `streaming` (finalize hasn't landed). The HIGH bug was that this
    // re-derived streamingMessageId=101 and brought the spinner back.
    act(() => {
      resolveLate!([
        fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
        fakeMessage({
          id: 101,
          session_id: 1,
          role: 'assistant',
          content: 'so far',
          status: 'streaming'
        })
      ])
    })

    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0))
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)
  })

  // task 06-08-chat Bug 1 (codex P0 NIT, promoted to a fix) — navigation-level
  // race. Unlike the message-level terminal guard (done/finalize race on a
  // single row), this is a SESSION-level race: a refresh(true) still in flight
  // for the session the user is LEAVING (issued by send / chunk idx=-1 recovery
  // / tool_call / done) resolves AFTER a navigation switch and would otherwise
  // setMessages(old session rows) + setStreamingMessageId(old streaming) on top
  // of the freshly-loaded NEW session. The navGenerationRef guard makes such a
  // late refresh discard ALL its setState. Reverting the guard turns this red.
  test('selectSession: a late refresh(true) for the previous session does not pollute the switched-to session', async () => {
    // Email 101 has two sessions: A (active, id=1) and B (id=2). A loads with a
    // streaming assistant so a refresh(true) re-derive would target it.
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 }), fakeSession({ id: 2 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'A-user' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'A-streaming',
        status: 'streaming'
      })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))

    // Fire a tool_call on session A → schedules refresh(1) [syncStreaming
    // defaults to true], the exact "in-flight refresh for the session we're
    // about to leave" vector. Make its listMessages hang so we can land it
    // AFTER the navigation switch below.
    let resolveLateA: ((rows: ChatMessage[]) => void) | null = null
    mockChatListMessages.mockImplementationOnce(
      () =>
        new Promise<ChatMessage[]>((res) => {
          resolveLateA = res
        })
    )
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'tool_call', name: 'x', args: {}, status: 'ok' }
      })
    })
    await waitFor(() => expect(resolveLateA).not.toBeNull())

    // selectSession(2) → bumps the navigation generation, aborts A, and runs
    // its own refresh(2) which resolves with B's (complete, no-streaming) rows.
    mockChatListMessages.mockResolvedValueOnce([
      fakeMessage({ id: 200, session_id: 2, role: 'user', content: 'B-user' }),
      fakeMessage({
        id: 201,
        session_id: 2,
        role: 'assistant',
        content: 'B-answer',
        status: 'complete'
      })
    ])
    await act(async () => {
      await result.current.selectSession(2)
    })
    expect(result.current.activeSessionId).toBe(2)
    expect(result.current.messages.map((m) => m.id)).toEqual([200, 201])
    expect(result.current.streamingMessageId).toBeNull()

    // NOW resolve the late refresh(1) for the LEFT-BEHIND session A, returning
    // A's still-streaming rows. Without the generation guard this would
    // setMessages(A's rows) + re-derive streamingMessageId=101, clobbering B.
    //
    // codex MEDIUM — flush the refresh promise's continuation before asserting.
    // `refresh` awaits `listMessages` then runs its gen check + (here) the
    // discard. Resolving inside `await act(async () => { …; await Promise.resolve() })`
    // forces that microtask continuation to run so the assertions observe the
    // guard's decision, not a not-yet-resumed promise (a plain act() leaves a
    // false-green window where the late setState simply hasn't fired yet).
    await act(async () => {
      resolveLateA!([
        fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'A-user' }),
        fakeMessage({
          id: 101,
          session_id: 1,
          role: 'assistant',
          content: 'A-streaming',
          status: 'streaming'
        })
      ])
      // Two turns: one for the listMessages.then continuation (the await in
      // refresh resumes), one for any setState-batched render it might schedule.
      await Promise.resolve()
      await Promise.resolve()
    })

    // B's state is intact: A's late refresh was discarded by the gen guard.
    expect(result.current.activeSessionId).toBe(2)
    expect(result.current.messages.map((m) => m.id)).toEqual([200, 201])
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)
  })

  // task 06-08-chat Bug 1 (codex REQUEST CHANGES — HIGH) — the email-switch
  // navigation vector. Unlike selectSession (a synchronous event handler that
  // bumps the generation inline), an email switch is driven by a prop change,
  // so the bump rides a useLayoutEffect. The race the layout effect closes:
  // email A has a refresh(true) in flight (issued by tool_call / send / chunk
  // recovery) when the user switches to email B; if the gen isn't bumped before
  // A's refresh resolves, the guard passes it through and A's (streaming) rows
  // overwrite B.
  //
  // GUARD: this test goes red if the email-switch bump is removed entirely
  // (verified — without it A's rows [100,101] clobber B's [200,201]).
  //
  // ⚠️ TEST-HARNESS LIMITATION (why layout-vs-passive isn't the discriminator
  // HERE): under RTL + React 19, `rerender` flushes BOTH the layout effect and
  // the passive load effect synchronously before returning, with any pending
  // microtask (the awaited stale-refresh continuation) running only afterwards
  // (probed order: layout → passive → after-rerender-sync → microtask). So in
  // the test, a passive-effect bump would ALSO beat the late continuation and
  // this test would stay green either way. The layout effect matters in
  // PRODUCTION, where passive effects are deferred to a scheduler macrotask:
  // there the stale refresh's microtask resolves BEFORE a passive bump (→
  // pollution) but AFTER a synchronous layout bump (→ discarded). The fix is
  // therefore useLayoutEffect; this test locks the "must bump on email switch"
  // contract, while the production-timing distinction is argued in the hook's
  // useLayoutEffect comment.
  test('email switch: a late refresh for the previous email does not pollute the switched-to email', async () => {
    // Email A=101 loads with session id=1 carrying a streaming assistant, so a
    // refresh(true) re-derive would target it.
    mockChatListSessions.mockResolvedValueOnce([fakeSession({ id: 1, email_id: 101 })])
    mockChatListMessages.mockResolvedValueOnce([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'A-user' }),
      fakeMessage({
        id: 101,
        session_id: 1,
        role: 'assistant',
        content: 'A-streaming',
        status: 'streaming'
      })
    ])
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useEmailChat(id), {
      initialProps: { id: 101 }
    })
    await waitFor(() => expect(result.current.activeSessionId).toBe(1))
    await waitFor(() => expect(result.current.streamingMessageId).toBe(101))

    // Fire a tool_call on session A → schedules refresh(1) [syncStreaming
    // defaults to true]. Make its listMessages hang so we can land it AFTER the
    // email switch — the exact "in-flight refresh for the email we're leaving".
    let resolveLateA: ((rows: ChatMessage[]) => void) | null = null
    mockChatListMessages.mockImplementationOnce(
      () =>
        new Promise<ChatMessage[]>((res) => {
          resolveLateA = res
        })
    )
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: { type: 'tool_call', name: 'x', args: {}, status: 'ok' }
      })
    })
    await waitFor(() => expect(resolveLateA).not.toBeNull())

    // Switch to email B=202: session id=2 with a complete (no-streaming) reply.
    // The useLayoutEffect bumps the navGeneration synchronously at commit; the
    // passive load effect then runs refresh(2) which captures the bumped gen.
    mockChatListSessions.mockResolvedValueOnce([fakeSession({ id: 2, email_id: 202 })])
    mockChatListMessages.mockResolvedValueOnce([
      fakeMessage({ id: 200, session_id: 2, role: 'user', content: 'B-user' }),
      fakeMessage({
        id: 201,
        session_id: 2,
        role: 'assistant',
        content: 'B-answer',
        status: 'complete'
      })
    ])
    rerender({ id: 202 })
    await waitFor(() => expect(result.current.activeSessionId).toBe(2))
    expect(result.current.messages.map((m) => m.id)).toEqual([200, 201])
    expect(result.current.streamingMessageId).toBeNull()

    // NOW resolve the late refresh(1) for the LEFT-BEHIND email A, returning A's
    // still-streaming rows. Without the layout-effect bump this would
    // setMessages(A's rows) + re-derive streamingMessageId=101, clobbering B.
    // Flush the promise continuation (see the selectSession test above) so the
    // assertions observe the guard's discard, not an unresumed promise.
    await act(async () => {
      resolveLateA!([
        fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'A-user' }),
        fakeMessage({
          id: 101,
          session_id: 1,
          role: 'assistant',
          content: 'A-streaming',
          status: 'streaming'
        })
      ])
      await Promise.resolve()
      await Promise.resolve()
    })

    // B's state is intact: A's late refresh was discarded by the gen guard the
    // useLayoutEffect bumped before A's refresh resolved.
    expect(result.current.activeSessionId).toBe(2)
    expect(result.current.messages.map((m) => m.id)).toEqual([200, 201])
    expect(result.current.streamingMessageId).toBeNull()
    expect(result.current.isStreaming).toBe(false)
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

  // task 06-08-chat 需求 5 — thinking deltas append to assistant.thinking (kept
  // separate from `content`; rendered in the collapsible block above the answer).
  // Placed at the tail of this block so it doesn't interleave with the
  // done-refresh timing-sensitive tests above.
  test('thinking event grows assistant.thinking in place (not content)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 1 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 1, role: 'user', content: 'hi' }),
      fakeMessage({ id: 101, session_id: 1, role: 'assistant', content: '', status: 'streaming' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.messages.length).toBe(2))

    act(() => {
      emitStream({ sessionId: 1, messageId: 101, event: { type: 'thinking', delta: 'Let me ' } })
    })
    act(() => {
      emitStream({ sessionId: 1, messageId: 101, event: { type: 'thinking', delta: 'reason.' } })
    })
    // Answer chunk arrives after thinking — must NOT bleed into thinking.
    act(() => {
      emitStream({ sessionId: 1, messageId: 101, event: { type: 'chunk', delta: 'Answer.' } })
    })

    const assistant = result.current.messages.find((m) => m.id === 101)!
    expect(assistant.thinking).toBe('Let me reason.')
    expect(assistant.content).toBe('Answer.')
    expect(assistant.status).toBe('streaming')
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

  test('E_NOTION_AGENT_RATE_LIMIT (trust-rule) engages the cooldown, not a Retry', async () => {
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
    expect(result.current.quotaCooldownUntil).toBeNull()

    await act(async () => {
      await result.current.send({ message: 'hi', backendKind: 'notion-agent' })
    })
    act(() => {
      emitStream({
        sessionId: 1,
        messageId: 101,
        event: {
          type: 'error',
          code: 'E_NOTION_AGENT_RATE_LIMIT',
          message: 'rate-limited by trust-rule'
        }
      })
    })

    // Same cooldown substrate as E_QUOTA: send gets disabled via a ~5-min
    // window, NOT a Retry button (an immediate retry deepens Notion's ban).
    expect(result.current.error?.code).toBe('E_NOTION_AGENT_RATE_LIMIT')
    expect(result.current.quotaCooldownUntil).not.toBeNull()
    if (result.current.quotaCooldownUntil !== null) {
      expect(result.current.quotaCooldownUntil - Date.now()).toBeGreaterThan(4 * 60 * 1000)
    }
    expect(result.current.retryLast).toBeNull()
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
    await waitFor(() => expect(memory['mailagent.chat.quotaCooldownUntil']).toBeDefined())
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

// Sprint 14 PR B — editMessage hook action.
describe('useEmailChat — editMessage (Sprint 14 PR B)', () => {
  test('throws when no active session', async () => {
    const { result } = renderHook(() => useEmailChat(null))
    await expect(
      result.current.editMessage({
        messageId: 1,
        newContent: 'x',
        backendKind: 'custom-api',
        backendModel: 'claude'
      })
    ).rejects.toThrow(/no active session/)
    expect(mockChatEditMessage).not.toHaveBeenCalled()
  })

  test('forwards opts with the active session id and bumps streaming target', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 100, session_id: 7, role: 'user', content: 'old' }),
      fakeMessage({ id: 101, session_id: 7, role: 'assistant', content: 'reply' })
    ])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(7))

    // editMessage backend returns the new ids the dispatcher freshly
    // allocated after truncating the user row.
    mockChatEditMessage.mockResolvedValue({
      sessionId: 7,
      userMessageId: 200,
      assistantMessageId: 201
    })
    // refresh() after edit pulls the canonical post-truncate row set.
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 200, session_id: 7, role: 'user', content: 'edited' }),
      fakeMessage({
        id: 201,
        session_id: 7,
        role: 'assistant',
        content: '',
        status: 'streaming'
      })
    ])

    await act(async () => {
      await result.current.editMessage({
        messageId: 100,
        newContent: 'edited',
        backendKind: 'custom-api',
        backendModel: 'claude'
      })
    })

    expect(mockChatEditMessage).toHaveBeenCalledWith({
      sessionId: 7,
      editingMessageId: 100,
      newContent: 'edited',
      backendKind: 'custom-api',
      backendModel: 'claude',
      backendAgentPageId: null
    })
    await waitFor(() => expect(result.current.streamingMessageId).toBe(201))
    expect(result.current.messages.map((m) => m.id)).toEqual([200, 201])
  })

  test('clears prior error before dispatching the edit (matches send() contract)', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([fakeMessage({ id: 100, session_id: 7, role: 'user' })])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(7))

    // Simulate a prior error landed on the panel — editMessage should
    // wipe it on dispatch so the user doesn't see "old error" + "edit
    // just queued" side by side.
    act(() => {
      emitStream({
        sessionId: 7,
        messageId: 100,
        event: { type: 'error', code: 'E_NETWORK', message: 'transient' }
      })
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())

    mockChatEditMessage.mockResolvedValue({
      sessionId: 7,
      userMessageId: 200,
      assistantMessageId: 201
    })
    mockChatListMessages.mockResolvedValue([
      fakeMessage({ id: 200, session_id: 7, role: 'user' }),
      fakeMessage({ id: 201, session_id: 7, role: 'assistant', status: 'streaming' })
    ])

    await act(async () => {
      await result.current.editMessage({
        messageId: 100,
        newContent: 'try again',
        backendKind: 'custom-api',
        backendModel: 'claude'
      })
    })
    expect(result.current.error).toBeNull()
  })

  test('propagates dispatch failures so the caller (UserBubble) keeps editor open', async () => {
    mockChatListSessions.mockResolvedValue([fakeSession({ id: 7 })])
    mockChatListMessages.mockResolvedValue([fakeMessage({ id: 100, session_id: 7, role: 'user' })])
    const { result } = renderHook(() => useEmailChat(101))
    await waitFor(() => expect(result.current.activeSessionId).toBe(7))

    const err = new Error('cannot edit assistant') as Error & { code?: string }
    err.code = 'E_INVALID_ARG'
    mockChatEditMessage.mockRejectedValueOnce(err)

    await act(async () => {
      await expect(
        result.current.editMessage({
          messageId: 100,
          newContent: 'x',
          backendKind: 'custom-api',
          backendModel: 'claude'
        })
      ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    })
  })
})
