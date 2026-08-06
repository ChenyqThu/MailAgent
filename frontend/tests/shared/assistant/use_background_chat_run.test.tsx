// @vitest-environment happy-dom
//
// harness-chat lane A B1/B2 renderer glue (task 07-15) — useBackgroundChatRun's state machine:
//   1. TRUTH PROBE: /api/ai/run/active hit → backgroundActive true; the OWN attached stream
//      (localRunning) masks it (an own run must never render the background placeholder).
//   2. SETTLE TRANSITION: a background run going away fires onSettled (the caller reloads +
//      re-seeds); an own run completing never triggers it.
//   3. BROADCAST GLUE ('chat:turn-persisted'): any session → allSessions invalidated +
//      onSessionsTouched; the ACTIVE session additionally marks itself read.
//
// codex r2 [C] — the settle door is runId-precise now (no time windows): each distinct run settles
// exactly once (broadcast ↔ poll double-observation deduped BY RUN ID), two legit consecutive runs
// both settle (the r1 1.5s window swallowed the second — the codex r2 P1), own-run masking uses the
// transport-recorded run ids (ownRuns.ts) instead of a 2s grace, and a payload without a runId is
// never silently dropped.
//
// codex r3 P1 — own-run masking is scoped to the RUNTIME INSTANCE that holds the attached stream
// (registerOwnRunOwner), NOT the renderer: a run recorded by an instance that has since unmounted
// (session switch) reads as background, is witnessed, and settles exactly once on switch-back. The
// r2 tests wrongly pinned "once started in this renderer, never settle" — corrected below.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

type TurnPersistedPayload = {
  sessionId: number
  status: 'finished' | 'paused'
  runId: string | null
}

const { stableMailApi, mockMarkRead, turnPersistedHandlers } = vi.hoisted(() => {
  const mockMarkRead = vi.fn(async () => {})
  const turnPersistedHandlers: Array<
    (p: { sessionId: number; status: 'finished' | 'paused'; runId: string | null }) => void
  > = []
  const stableMailApi = {
    chat: {
      markSessionRead: mockMarkRead,
      onTurnPersisted: (
        h: (p: { sessionId: number; status: 'finished' | 'paused'; runId: string | null }) => void
      ) => {
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
import {
  isOwnRun,
  recordOwnRun,
  registerOwnRunOwner,
  _resetOwnRunsForTest
} from '../../../src/shared/assistant/runtime/ownRuns'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  turnPersistedHandlers.length = 0
  _resetOwnRunsForTest()
})

function broadcast(p: TurnPersistedPayload): void {
  turnPersistedHandlers.forEach((h) => h(p))
}

/** Stub fetch: /api/ai/run/active answers per the mutable `state` map (miss → 404 shape). */
function stubRunActiveFetch(state: { active: boolean; runId?: string; ageMs?: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ai/run/active')) {
        return state.active
          ? new Response(
              JSON.stringify({
                active: true,
                runId: state.runId ?? 'r1',
                ageMs: state.ageMs === undefined ? 100 : state.ageMs
              }),
              { status: 200 }
            )
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
    const state = { active: true, runId: 'r-bg' }
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
    broadcast({ sessionId: 5, status: 'finished', runId: 'r-bg' })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    // P1-4 — the settle now fires straight off the broadcast (before the invalidated probe refetch
    // returns), so the placeholder clears a beat later: await the refetch instead of asserting
    // synchronously.
    await waitFor(() => expect(result.current.backgroundActive).toBe(false))
    // the watched session marks itself read (own view must not self-badge)
    expect(mockMarkRead).toHaveBeenCalledWith(5)
    expect(onSessionsTouched).toHaveBeenCalled()
    // codex r2 [C] — the witnessed poll transition observing the SAME run is a per-run dedup no-op.
    await new Promise((r) => setTimeout(r, 30))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  // codex r3 P1 (assertion corrected) — the own-run mask holds only while the OWNING RUNTIME
  // INSTANCE is mounted (live owner), not "forever once this renderer started it": after the
  // owning instance unmounts, the very same runId settles like any background run.
  test('own attached stream masks placeholder + settle while its runtime is mounted; releases after unmount', async () => {
    const owner = {} // runtime instance #1's token (useMailAgentAiSdkRuntime lazy-state identity)
    const releaseOwner = registerOwnRunOwner(owner)
    recordOwnRun(owner, 'r-own-6') // the transport recorded our own run's id (response header)
    const state = { active: true, runId: 'r-own-6' }
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

    // own turn completes: stream idle + run gone — NO settle while the owning runtime is still
    // mounted (that runtime already renders the turn; a reload-remount would be pure disruption)
    state.active = false
    rerender({ localRunning: false })
    broadcast({ sessionId: 6, status: 'finished', runId: 'r-own-6' })
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(6))
    expect(onSettled).not.toHaveBeenCalled()

    // …but once the owning runtime instance UNMOUNTS (session switch), the mask is gone: the same
    // run observed settling again (e.g. the persist broadcast landing at a remounted panel) fires.
    releaseOwner()
    broadcast({ sessionId: 6, status: 'finished', runId: 'r-own-6' })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
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
    broadcast({ sessionId: 999, status: 'paused', runId: 'r-elsewhere' })
    await waitFor(() => expect(onSessionsTouched).toHaveBeenCalled())
    expect(mockMarkRead).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  // P1-4 (codex r1) — the reload-loss window: a background run can persist + release BEFORE this
  // panel's first /run/active probe returns (switch-back right at run end). The broadcast itself is
  // the persisted truth: with no witnessed active hit ever forming, the same-session broadcast must
  // still settle — deduped PER RUN (codex r2 [C]): re-observing the SAME run is a no-op.
  test('broadcast BEFORE any active probe hit → settles exactly once (same-run re-observation deduped)', async () => {
    const state = { active: false } // the run already released — every probe misses
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 9,
          enabled: true,
          refreshNonce: 0,
          localRunning: false,
          onSettled
        }),
      { wrapper }
    )
    await waitFor(() => expect(turnPersistedHandlers.length).toBe(1))
    broadcast({ sessionId: 9, status: 'finished', runId: 'r-once' })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(mockMarkRead).toHaveBeenCalledWith(9)
    // A duplicate observation of the SAME run (double broadcast / the poll racing in) is deduped.
    broadcast({ sessionId: 9, status: 'finished', runId: 'r-once' })
    await new Promise((r) => setTimeout(r, 30))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  // codex r2 [C] (the new P1) — two DIFFERENT runs settling back-to-back (well inside what used to
  // be the 1.5s dedup window) must EACH fire a reload: the r1 time-window door swallowed the second
  // one forever (its broadcast was suppressed and, witness already cleared, the poll could not
  // recover it).
  test('two different runs settle back-to-back → each fires onSettled (no time-window swallow)', async () => {
    const state = { active: false }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 11,
          enabled: true,
          refreshNonce: 0,
          localRunning: false,
          onSettled
        }),
      { wrapper }
    )
    await waitFor(() => expect(turnPersistedHandlers.length).toBe(1))
    broadcast({ sessionId: 11, status: 'finished', runId: 'r-first' })
    broadcast({ sessionId: 11, status: 'finished', runId: 'r-second' }) // immediately after
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2))
  })

  // codex r2 [C] — the own-run grace race, now runId-precise: a persist broadcast landing right
  // after OUR OWN attached stream ended is masked by id (the runtime already renders that turn),
  // while a DIFFERENT run settling in that same moment (the case the r1 2s grace swallowed — e.g.
  // another surface resuming an old approval) still reloads. codex r3 P1 — the mask requires the
  // owning runtime instance to still be MOUNTED (live owner registered below).
  test('right after the OWN stream ended: own runId → no settle; a DIFFERENT run → settles', async () => {
    const owner = {} // this panel's runtime instance, mounted throughout the test
    registerOwnRunOwner(owner)
    recordOwnRun(owner, 'r-own-10')
    const state = { active: false }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    const { rerender } = renderHook(
      ({ localRunning }: { localRunning: boolean }) =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 10,
          enabled: true,
          refreshNonce: 0,
          localRunning,
          onSettled
        }),
      { wrapper, initialProps: { localRunning: true } }
    )
    await waitFor(() => expect(turnPersistedHandlers.length).toBe(1))
    // own stream completes (client side), THEN its persist broadcast lands — masked by id.
    rerender({ localRunning: false })
    broadcast({ sessionId: 10, status: 'finished', runId: 'r-own-10' })
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(10))
    expect(onSettled).not.toHaveBeenCalled()
    // …but ANOTHER run settling immediately after is NOT ours → reload (r1 grace lost this one).
    broadcast({ sessionId: 10, status: 'finished', runId: 'r-resume-elsewhere' })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
  })

  // codex r3 P1 — THE regression: a run started here, whose runtime instance then unmounted
  // (session switch) and remounted (switch back BEFORE the run finished), must read as a
  // BACKGROUND run for the fresh instance: witness forms, and the persist broadcast + the
  // witnessed active→gone transition settle it EXACTLY once (per-run dedup). The r2
  // renderer-permanent own set kept masking it → no witness, broadcast short-circuited,
  // onSettled never fired → permanently stale seed.
  test('own run whose runtime unmounted + remounted (switch away/back) → background + settles exactly once', async () => {
    // Runtime instance #1 (the original mount) started the run: live owner + recorded runId.
    const owner1 = {}
    const release1 = registerOwnRunOwner(owner1)
    recordOwnRun(owner1, 'r-detach')
    const state = { active: true, runId: 'r-detach' }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()

    // Session switch: the keyed provider unmounts instance #1 (its stream keeps draining
    // server-side) → ownership released. Switch back mounts instance #2 with a FRESH token.
    release1()
    const owner2 = {}
    const release2 = registerOwnRunOwner(owner2)

    const { result } = renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 13,
          enabled: true,
          refreshNonce: 0,
          localRunning: false,
          onSettled
        }),
      { wrapper }
    )
    // r3 repro steps 3-4 fixed: the probe hit is BACKGROUND now (not own) → placeholder + witness.
    await waitFor(() => expect(result.current.backgroundActive).toBe(true))
    expect(onSettled).not.toHaveBeenCalled()

    // The run completes server-side: persist broadcast lands + the run is gone. The broadcast
    // settles; the witnessed poll transition re-observing the SAME run is a per-run dedup no-op.
    state.active = false
    broadcast({ sessionId: 13, status: 'finished', runId: 'r-detach' })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.backgroundActive).toBe(false))
    await new Promise((r) => setTimeout(r, 30))
    expect(onSettled).toHaveBeenCalledTimes(1)
    release2()
  })

  // codex r3 P1 guard-rail — StrictMode replays effects (setup → cleanup → setup) on the SAME
  // component instance: its ref-held owner token re-registers, so ownership must survive the
  // replay (no mis-release of a mounted runtime's runs). Only a REAL unmount drops it.
  test('ownRuns: StrictMode-style re-register of the same token keeps ownership; real release drops it', () => {
    const owner = {}
    const cleanup1 = registerOwnRunOwner(owner)
    recordOwnRun(owner, 'r-strict')
    expect(isOwnRun('r-strict')).toBe(true)
    // StrictMode simulated unmount + immediate effect re-run with the SAME token
    cleanup1()
    const cleanup2 = registerOwnRunOwner(owner)
    expect(isOwnRun('r-strict')).toBe(true) // ownership resurrected — run mapping never dropped
    // real unmount → the run degrades to background for any later mount
    cleanup2()
    expect(isOwnRun('r-strict')).toBe(false)
  })

  // codex r2 [C] — a payload without a runId (unleased persist — headless agent run) can't be
  // attributed or deduped, so it must NEVER be silently dropped (masked only mid-own-stream).
  test('broadcast without a runId → always settles (never silently dropped)', async () => {
    const state = { active: false }
    stubRunActiveFetch(state)
    const onSettled = vi.fn()
    renderHook(
      () =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 12,
          enabled: true,
          refreshNonce: 0,
          localRunning: false,
          onSettled
        }),
      { wrapper }
    )
    await waitFor(() => expect(turnPersistedHandlers.length).toBe(1))
    broadcast({ sessionId: 12, status: 'finished', runId: null })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
  })

  // WP-14 — 运行条的秒表接续依赖这条：探针的 `ageMs`（「已经跑了多久」）在拿到响应的那一刻折算
  // 成本地 epoch 起点，切走再切回读数才不清零。ageMs 缺失/非法 → null（宁可不显示秒表，也不编数）。
  test('backgroundStartedAt = 收到响应时刻 − ageMs；非活跃 / ageMs 非法 → null', async () => {
    const state: { active: boolean; runId?: string; ageMs?: unknown } = {
      active: true,
      runId: 'r-age',
      ageMs: 42_000
    }
    stubRunActiveFetch(state)
    const before = Date.now()
    const { result, rerender } = renderHook(
      ({ localRunning }: { localRunning: boolean }) =>
        useBackgroundChatRun({
          gatewayBaseUrl: 'http://127.0.0.1:8300',
          sessionId: 14,
          enabled: true,
          refreshNonce: 0,
          localRunning,
          onSettled: vi.fn()
        }),
      { wrapper, initialProps: { localRunning: false } }
    )
    await waitFor(() => expect(result.current.backgroundActive).toBe(true))
    const startedAt = result.current.backgroundStartedAt
    expect(startedAt).not.toBeNull()
    // 起点落在「请求发出前 42s」到「现在 42s 前」之间 —— 换算用的是响应到达的墙钟。
    expect(startedAt as number).toBeGreaterThanOrEqual(before - 42_000)
    expect(startedAt as number).toBeLessThanOrEqual(Date.now() - 42_000)

    // 自己的附着流把 background 遮掉时，起点也必须跟着消失（否则运行条会给附着回合挂一个
    // 后台 run 的旧起点）。
    rerender({ localRunning: true })
    await waitFor(() => expect(result.current.backgroundActive).toBe(false))
    expect(result.current.backgroundStartedAt).toBeNull()
  })

  // 三种「拿不到可信起点」的形状各走一遍（三条判据 typeof / Number.isFinite / >= 0 一一对应）：
  // 无论哪种，运行条宁可不显示秒表，也不显示一个编出来的数；`active` 本身不受影响。
  test.each([
    ['缺失（JSON null）', null, 16],
    ['非数字', 'soon', 17],
    ['负数（时钟漂移 / 服务端算反）', -5_000, 18]
  ] as const)(
    'ageMs %s → backgroundStartedAt null（active 仍为真）',
    async (_label, ageMs, sid) => {
      stubRunActiveFetch({ active: true, runId: `r-noage-${sid}`, ageMs })
      const { result } = renderHook(
        () =>
          useBackgroundChatRun({
            gatewayBaseUrl: 'http://127.0.0.1:8300',
            sessionId: sid,
            enabled: true,
            refreshNonce: 0,
            localRunning: false,
            onSettled: vi.fn()
          }),
        { wrapper }
      )
      await waitFor(() => expect(result.current.backgroundActive).toBe(true))
      expect(result.current.backgroundStartedAt).toBeNull()
    }
  )

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
