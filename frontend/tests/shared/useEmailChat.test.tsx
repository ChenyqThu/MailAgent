// @vitest-environment happy-dom
//
// S3 W2 — useEmailChat is the session READ facade now (the legacy drive surface
// — send / stream / confirmTool / quota / retry — was deleted with the legacy
// runtime; the AI SDK gateway owns live turns). These tests pin the surviving
// contract: per-(email, kind) scope loading + restore memory, selectSession /
// newSession / adoptSession / deleteSession navigation, and the E_LOAD error slot.
//
// useMailApi is mocked as a stable singleton (the hook's effects have mailApi in
// their deps, so a fresh literal per render would loop).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useEmailChat } from '../../src/shared/hooks/useEmailChat'
import type { ChatBackendKind, ChatMessage, ChatSession } from '../../src/shared/api/types'

const { stableMailApi, mockListSessions, mockListMessages, mockDeleteSession } = vi.hoisted(() => {
  const mockListSessions = vi.fn<(emailId: number) => Promise<ChatSession[]>>()
  const mockListMessages = vi.fn<(id: number) => Promise<ChatMessage[]>>(async () => [])
  const mockDeleteSession = vi.fn()
  const stableMailApi = {
    chat: {
      listSessions: mockListSessions,
      listMessages: mockListMessages,
      deleteSession: mockDeleteSession
    }
  }
  return { stableMailApi, mockListSessions, mockListMessages, mockDeleteSession }
})

vi.mock('../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

function fakeSession(over: Partial<ChatSession>): ChatSession {
  return {
    id: 1,
    email_id: 100,
    anchor_type: 'email',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: 'claude-sonnet-4-6',
    backend_agent_page_id: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

function fakeMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 1,
    role: 'assistant',
    content: 'hello',
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useEmailChat — scope load (email, kind)', () => {
  test('loads the latest session of the kind + its messages; messagesSessionId reflects the load', async () => {
    const s1 = fakeSession({ id: 11, backend_kind: 'ai-sdk' })
    const s2 = fakeSession({ id: 12, backend_kind: 'custom-api' })
    mockListSessions.mockResolvedValue([s1, s2])
    mockListMessages.mockResolvedValue([fakeMessage({ id: 5, session_id: 11 })])

    const { result } = renderHook(() => useEmailChat(100, 'ai-sdk'))
    await waitFor(() => expect(result.current.activeSessionId).toBe(11))
    expect(result.current.messagesSessionId).toBe(11)
    expect(result.current.messages.map((m) => m.id)).toEqual([5])
    // The public sessions list is the kind subset — the custom-api row is filtered out.
    expect(result.current.sessions.map((s) => s.id)).toEqual([11])
  })

  test('a kind-only switch re-filters the cached list (no second listSessions IPC)', async () => {
    const s1 = fakeSession({ id: 11, backend_kind: 'ai-sdk' })
    const s2 = fakeSession({ id: 12, backend_kind: 'custom-api' })
    mockListSessions.mockResolvedValue([s1, s2])
    mockListMessages.mockResolvedValue([])

    const { result, rerender } = renderHook(
      ({ kind }: { kind: ChatBackendKind }) => useEmailChat(100, kind),
      { initialProps: { kind: 'ai-sdk' as ChatBackendKind } }
    )
    await waitFor(() => expect(result.current.activeSessionId).toBe(11))
    expect(mockListSessions).toHaveBeenCalledTimes(1)

    rerender({ kind: 'custom-api' })
    // D6 — re-scoping to the legacy kind surfaces its sessions read-only.
    await waitFor(() => expect(result.current.activeSessionId).toBe(12))
    expect(result.current.sessions.map((s) => s.id)).toEqual([12])
    expect(mockListSessions).toHaveBeenCalledTimes(1)
  })

  test('emailId null → empty state, no IPC', async () => {
    const { result } = renderHook(() => useEmailChat(null, 'ai-sdk'))
    expect(result.current.messages).toEqual([])
    expect(result.current.activeSessionId).toBeNull()
    expect(mockListSessions).not.toHaveBeenCalled()
  })

  test('listSessions failure lands in the E_LOAD error slot; clearError dismisses', async () => {
    mockListSessions.mockRejectedValue(new Error('db locked'))
    const { result } = renderHook(() => useEmailChat(100, 'ai-sdk'))
    await waitFor(() => expect(result.current.error?.code).toBe('E_LOAD'))
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })
})

describe('useEmailChat — navigation actions', () => {
  test('selectSession loads the target session messages', async () => {
    const s1 = fakeSession({ id: 11 })
    const s2 = fakeSession({ id: 12 })
    mockListSessions.mockResolvedValue([s1, s2])
    mockListMessages.mockImplementation(async (id) => [
      fakeMessage({ id: id * 10, session_id: id })
    ])

    const { result } = renderHook(() => useEmailChat(100, 'ai-sdk'))
    await waitFor(() => expect(result.current.activeSessionId).toBe(11))

    await act(async () => {
      await result.current.selectSession(12)
    })
    expect(result.current.activeSessionId).toBe(12)
    expect(result.current.messagesSessionId).toBe(12)
    expect(result.current.messages.map((m) => m.id)).toEqual([120])
  })

  test('newSession clears the renderer state (blank thread; ai-sdk creates the row on first send)', async () => {
    mockListSessions.mockResolvedValue([fakeSession({ id: 11 })])
    mockListMessages.mockResolvedValue([fakeMessage({ id: 5 })])
    const { result } = renderHook(() => useEmailChat(100, 'ai-sdk'))
    await waitFor(() => expect(result.current.activeSessionId).toBe(11))

    act(() => result.current.newSession())
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(result.current.messagesSessionId).toBeNull()
  })

  test('adoptSession folds an out-of-band ai-sdk session in: active + messagesSessionId + sessions, no IPC', async () => {
    mockListSessions.mockResolvedValue([])
    const { result } = renderHook(() => useEmailChat(100, 'ai-sdk'))
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled())

    const created = fakeSession({ id: 4242 })
    act(() => result.current.adoptSession(created))
    expect(result.current.activeSessionId).toBe(4242)
    // 0-row session → messagesSessionId = id makes the AI SDK reload gate read "ready".
    expect(result.current.messagesSessionId).toBe(4242)
    expect(result.current.messages).toEqual([])
    expect(result.current.sessions.map((s) => s.id)).toContain(4242)
    expect(mockListMessages).not.toHaveBeenCalled()
  })

  test('deleteSession of the ACTIVE session resets to the blank state; a sidebar row delete does not', async () => {
    const s1 = fakeSession({ id: 11 })
    const s2 = fakeSession({ id: 12 })
    mockListSessions.mockResolvedValue([s1, s2])
    mockListMessages.mockResolvedValue([fakeMessage({ id: 5, session_id: 11 })])
    const { result } = renderHook(() => useEmailChat(100, 'ai-sdk'))
    await waitFor(() => expect(result.current.activeSessionId).toBe(11))

    // Non-active row: list shrinks, active conversation untouched.
    act(() => result.current.deleteSession(12))
    expect(mockDeleteSession).toHaveBeenCalledWith(12)
    expect(result.current.activeSessionId).toBe(11)
    expect(result.current.sessions.map((s) => s.id)).toEqual([11])

    // Active row: full reset.
    act(() => result.current.deleteSession(11))
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(result.current.sessions).toEqual([])
  })
})

describe('useEmailChat — per-scope restore memory', () => {
  test('switching back to a scope restores the session the user last had open there', async () => {
    const s1 = fakeSession({ id: 11 })
    const s2 = fakeSession({ id: 12 })
    mockListSessions.mockResolvedValue([s1, s2])
    mockListMessages.mockResolvedValue([])

    const { result, rerender } = renderHook(
      ({ emailId }: { emailId: number | null }) => useEmailChat(emailId, 'ai-sdk'),
      { initialProps: { emailId: 100 as number | null } }
    )
    await waitFor(() => expect(result.current.activeSessionId).toBe(11))
    await act(async () => {
      await result.current.selectSession(12)
    })
    expect(result.current.activeSessionId).toBe(12)

    // Leave for another email, then come back — the remembered session (12) is
    // restored instead of the default latest (11).
    mockListSessions.mockResolvedValue([fakeSession({ id: 99, email_id: 200 })])
    rerender({ emailId: 200 })
    await waitFor(() => expect(result.current.activeSessionId).toBe(99))

    mockListSessions.mockResolvedValue([s1, s2])
    rerender({ emailId: 100 })
    await waitFor(() => expect(result.current.activeSessionId).toBe(12))
  })
})
