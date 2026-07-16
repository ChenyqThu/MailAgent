// @vitest-environment happy-dom
//
// harness-chat lane A B1/B2 renderer glue (task 07-15) — useBackgroundChatRun's state machine:
//   1. TRUTH PROBE: /api/ai/run/active hit → backgroundActive true; the OWN attached stream
//      (localRunning) masks it (an own run must never render the background placeholder).
//   2. SETTLE TRANSITION: a WITNESSED background run going active→gone fires onSettled exactly once
//      (the caller reloads + re-seeds); an own run completing never triggers it.
//   3. BROADCAST GLUE ('chat:turn-persisted'): any session → allSessions invalidated +
//      onSessionsTouched; the ACTIVE session additionally marks itself read.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { stableMailApi, mockMarkRead, turnPersistedHandlers } = vi.hoisted(() => {
  const mockMarkRead = vi.fn(async () => {})
  const turnPersistedHandlers: Array<
    (p: { sessionId: number; status: 'finished' | 'paused' }) => void
  > = []
  const stableMailApi = {
    chat: {
      markSessionRead: mockMarkRead,
      onTurnPersisted: (h: (p: { sessionId: number; status: 'finished' | 'paused' }) => void) => {
        turnPersistedHandlers.push(h)
        return () => {
          const i = turnPersistedHandlers.indexOf(h)
          if (i >= 0) turnPersistedHandlers.splice(i, 1)
        }
      }
    }
  }
  return { stableMailApi, mockMarkRead, turnPersistedHandlers }
})

vi.mock('../../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

import { useBackgroundChatRun } from '../../../src/shared/assistant/runtime/useBackgroundChatRun'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  turnPersistedHandlers.length = 0
})

/** Stub fetch: /api/ai/run/active answers per the mutable `state` map (miss → 404 shape). */
function stubRunActiveFetch(state: { active: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ai/run/active')) {
        return state.active
          ? new Response(JSON.stringify({ active: true, runId: 'r1', ageMs: 100 }), { status: 200 })
          : new Response(JSON.stringify({ active: false }), { status: 404 })
      }
      return new Response('{}', { status: 200 })
    })
  )
}

function wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useBackgroundChatRun', () => {
  test('probe hit (no own stream) → backgroundActive; broadcast-driven re-probe settles → onSettled once + markRead', async () => {
    const state = { active: true }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    const onSessionsTouched = vi.fn()
    const { result } = renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 5,
          enabled: true,
          refreshNonce: 0,
          localRunning: false,
          onSettled,
          onSessionsTouched
        }),
      { wrapper }
    )
    await waitFor(() => expect(result.current.backgroundActive).toBe(true))
    expect(onSettled).not.toHaveBeenCalled()

    // The detached run persists → broadcast for THIS session; the run is now gone server-side.
    state.active = false
    turnPersistedHandlers.forEach((h) => h({ sessionId: 5, status: 'finished' }))
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(result.current.backgroundActive).toBe(false)
    // the watched session marks itself read (own view must not self-badge)
    expect(mockMarkRead).toHaveBeenCalledWith(5)
    expect(onSessionsTouched).toHaveBeenCalled()
  })

  test('own attached stream (localRunning) masks the placeholder AND never witnesses a settle', async () => {
    const state = { active: true }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    const { result, rerender } = renderHook(
      ({ localRunning }: { localRunning: boolean }) =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 6,
          enabled: true,
          refreshNonce: 0,
          localRunning,
          onSettled
        }),
      { wrapper, initialProps: { localRunning: true } }
    )
    // the probe reports active (our own run registered) but the OWN stream masks it
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    )
    expect(result.current.backgroundActive).toBe(false)

    // own turn completes: stream idle + run gone — NO settle (the own runtime already has the turn)
    state.active = false
    rerender({ localRunning: false })
    turnPersistedHandlers.forEach((h) => h({ sessionId: 6, status: 'finished' }))
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(6))
    expect(onSettled).not.toHaveBeenCalled()
  })

  test('broadcast for ANOTHER session → lists refreshed, no markRead for it, no settle', async () => {
    const state = { active: false }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    const onSessionsTouched = vi.fn()
    renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 7,
          enabled: true,
          refreshNonce: 0,
          localRunning: false,
          onSettled,
          onSessionsTouched
        }),
      { wrapper }
    )
    await waitFor(() => expect(turnPersistedHandlers.length).toBe(1))
    turnPersistedHandlers.forEach((h) => h({ sessionId: 999, status: 'paused' }))
    await waitFor(() => expect(onSessionsTouched).toHaveBeenCalled())
    expect(mockMarkRead).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  test('disabled → no probe, no subscription', async () => {
    const state = { active: true }
    stubRunActiveFetch(state)
    renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 8,
          enabled: false,
          refreshNonce: 0,
          localRunning: false,
          onSettled: vi.fn()
        }),
      { wrapper }
    )
    await new Promise((r) => setTimeout(r, 50))
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect(turnPersistedHandlers).toHaveLength(0)
  })
})
