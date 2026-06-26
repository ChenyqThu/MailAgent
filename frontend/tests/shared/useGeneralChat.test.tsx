// @vitest-environment happy-dom
//
// redesign Phase 2 — useGeneralChat.adoptSession contract (the ai-sdk eager-session adopt the MailAgent
// view's onEnsureSession relies on). Mirrors the useEmailChat.adoptSession test for the GENERAL anchor.
// useMailApi is mocked as a stable singleton (the hook's effects have mailApi in their deps, so a fresh
// literal per render would loop). We assert the pure state fold: active + messagesSessionId + sessions,
// no IPC (the gateway persists the first turn itself).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useGeneralChat } from '../../src/shared/hooks/useGeneralChat'
import type { ChatMessage, ChatSession, ChatStreamEnvelope } from '../../src/shared/api/types'

const { stableMailApi, mockListGeneralSessions, mockNewSession, mockStart } = vi.hoisted(() => {
  const handlers: Array<(env: ChatStreamEnvelope) => void> = []
  const mockListGeneralSessions = vi.fn<() => Promise<ChatSession[]>>()
  const mockListMessages = vi.fn<(id: number) => Promise<ChatMessage[]>>(async () => [])
  const mockNewSession = vi.fn()
  const mockStart = vi.fn()
  const stableMailApi = {
    chat: {
      listGeneralSessions: mockListGeneralSessions,
      listMessages: mockListMessages,
      newSession: mockNewSession,
      start: mockStart,
      abort: vi.fn(),
      deleteSession: vi.fn(),
      editMessage: vi.fn(),
      confirmTool: vi.fn(),
      onStream: (h: (env: ChatStreamEnvelope) => void): (() => void) => {
        handlers.push(h)
        return () => {
          const i = handlers.indexOf(h)
          if (i >= 0) handlers.splice(i, 1)
        }
      }
    }
  }
  return { stableMailApi, mockListGeneralSessions, mockNewSession, mockStart }
})

vi.mock('../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

function fakeSession(over: Partial<ChatSession>): ChatSession {
  return {
    id: 1,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: 'claude-sonnet-4-6',
    backend_agent_page_id: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useGeneralChat — adoptSession (ai-sdk eager general session)', () => {
  test('folds an out-of-band ai-sdk general session into state: active + messagesSessionId + sessions, no IPC', async () => {
    mockListGeneralSessions.mockResolvedValue([]) // a fresh account, no prior general sessions
    const { result } = renderHook(() => useGeneralChat())
    await waitFor(() => expect(mockListGeneralSessions).toHaveBeenCalled())
    expect(result.current.activeSessionId).toBeNull()

    const created = fakeSession({ id: 4242, backend_kind: 'ai-sdk' })
    act(() => {
      result.current.adoptSession(created)
    })

    expect(result.current.activeSessionId).toBe(4242)
    // 0-row session → messagesSessionId = id makes the AI SDK reload gate read "ready".
    expect(result.current.messagesSessionId).toBe(4242)
    expect(result.current.messages).toEqual([])
    expect(result.current.sessions.map((s) => s.id)).toContain(4242)
    // adoptSession runs NO IPC — the gateway persists the first turn itself.
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockNewSession).not.toHaveBeenCalled()
  })

  test('adopting a session already in the list does not duplicate it', async () => {
    const existing = fakeSession({ id: 9, backend_kind: 'ai-sdk' })
    mockListGeneralSessions.mockResolvedValue([existing])
    const { result } = renderHook(() => useGeneralChat())
    await waitFor(() => expect(result.current.sessions.length).toBe(1))

    act(() => {
      result.current.adoptSession(existing)
    })
    expect(result.current.sessions.filter((s) => s.id === 9)).toHaveLength(1)
  })
})
