// @vitest-environment happy-dom
//
// harness-chat task 07-15 (codex r4 P2 follow-up, non-blocking) — component-level regression for
// the own-run ownership handoff across a REAL session-switch remount.
//
// use_background_chat_run.test.tsx already pins the ownRuns.ts contract at the module/unit level
// (manual registerOwnRunOwner/recordOwnRun calls simulating a switch away/back). This test instead
// drives the SAME lifecycle through the real component tree: a keyed AiSdkRuntimeProvider remount
// (exactly how AiChatPanel.tsx keys the provider by session — AiChatPanel.tsx:756-772) exercises
// useMailAgentAiSdkRuntime.ts's own owner-token registration (useState lazy-init + useEffect
// register/cleanup, :163-170) and the transport's response-header capture (:228-240) by actually
// sending a message through the REAL ThreadComposer — mock surface is limited to `fetch` and
// useMailApi (chat.markSessionRead / onTurnPersisted), everything else (runtime, transport, owner
// token wiring, composer form) is production code. A regression in the WIRING itself (not just the
// ownRuns.ts module) would be caught here even if the unit-level test still passed.
//
// Assertions:
//   1. While the sending instance is mounted, its run reads as OWN (isOwnRun true).
//   2. After a keyed remount (switch away/back), the SAME run reads as background for the fresh
//      instance, and a live useBackgroundChatRun watcher witnesses + settles it EXACTLY once off
//      the persisted-truth broadcast (mirrors the r3 P1 regression this whole subsystem exists to
//      prevent: a renderer-permanent own-run set used to mask it forever → permanently stale seed).

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ThreadComposer } from '@shared/assistant/components/composer'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import { useBackgroundChatRun } from '@shared/assistant/runtime/useBackgroundChatRun'
import { isOwnRun, _resetOwnRunsForTest } from '@shared/assistant/runtime/ownRuns'

const RUN_ID = 'r-own-remount-e2e'
const SESSION_ID = 42

type TurnPersistedPayload = {
  sessionId: number
  status: 'finished' | 'paused'
  runId: string | null
}

const { stableMailApi, mockMarkRead, turnPersistedHandlers } = vi.hoisted(() => {
  const mockMarkRead = vi.fn(async () => {})
  const turnPersistedHandlers: Array<(p: TurnPersistedPayload) => void> = []
  const stableMailApi = {
    chat: {
      markSessionRead: mockMarkRead,
      onTurnPersisted: (h: (p: TurnPersistedPayload) => void) => {
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

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

beforeAll(() => {
  // assistant-ui internals reference observers happy-dom lacks; stub them (mirrors
  // composer_send_gate.test.tsx / thread_running_guard.test.tsx).
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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  turnPersistedHandlers.length = 0
  _resetOwnRunsForTest()
})

function stubControls(): ChatComposerControls {
  return {
    thinkingSupported: false,
    thinkingEnabled: false,
    onToggleThinking: vi.fn(),
    model: 'claude-sonnet-4-6',
    availableModels: [],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn()
  }
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

function chatSendCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/ai/chat')).length
}

function runActiveProbeCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/ai/run/active')).length
}

/** Composite fetch stub: /api/ai/chat answers the AI SDK data-stream protocol carrying the
 *  gateway's leased-run header (exactly what useMailAgentAiSdkRuntime's wrapped transport fetch
 *  reads, :237); /api/ai/run/active answers per the mutable `activeState` (the shape
 *  useBackgroundChatRun's probe expects). One global fetch serves both routes, matching production
 *  (one window, one fetch). */
function stubFetch(activeState: { active: boolean; runId?: string }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/ai/chat')) {
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-mailagent-run-id': RUN_ID }
      })
    }
    if (url.includes('/api/ai/run/active')) {
      return activeState.active
        ? new Response(
            JSON.stringify({ active: true, runId: activeState.runId ?? RUN_ID, ageMs: 100 }),
            { status: 200 }
          )
        : new Response(JSON.stringify({ active: false }), { status: 404 })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The keyed provider AiChatPanel.tsx actually remounts on a session switch (AiChatPanel.tsx:756).
 *  Rerendering THIS component with a new `sessionKey` drives the key change through React's real
 *  reconciliation (unmount effects of the OLD AiSdkRuntimeProvider instance commit, THEN the NEW
 *  instance's setup effects run) — not a manual unmount() call standing in for it. */
function RemountHarness({ sessionKey }: { sessionKey: string }): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        key={sessionKey}
        gatewayBaseUrl="http://127.0.0.1:8300"
        sessionId={SESSION_ID}
      >
        <ChatComposerControlsProvider value={stubControls()}>
          <ThreadComposer />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

/** A live panel's background-run watcher for the same session (mirrors AiChatPanel's wiring of
 *  useBackgroundChatRun, minus the panel chrome). */
function BackgroundWatcher({ onSettled }: { onSettled: () => void }): null {
  useBackgroundChatRun({
    gatewayBaseUrl: 'http://127.0.0.1:8300',
    sessionId: SESSION_ID,
    enabled: true,
    refreshNonce: 0,
    localRunning: false,
    onSettled
  })
  return null
}

function broadcast(p: TurnPersistedPayload): void {
  turnPersistedHandlers.forEach((h) => h(p))
}

describe('own-run ownership survives a REAL keyed AiSdkRuntimeProvider remount (session switch)', () => {
  test('send (own registered) → keyed remount (owner released) → fresh instance treats the run as background and settles exactly once', async () => {
    const activeState: { active: boolean; runId?: string } = { active: false }
    const fetchMock = stubFetch(activeState)

    // Phase 1 — instance #1 sends through the REAL composer form; the wrapped transport fetch
    // records the gateway-stamped run id under this instance's owner token.
    const { rerender, container } = render(<RemountHarness sessionKey="s1" />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello there' } })
    fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(chatSendCount(fetchMock)).toBe(1))

    // (1) live — the owning instance is still mounted: the run reads as OWN.
    await waitFor(() => expect(isOwnRun(RUN_ID)).toBe(true))

    // Phase 2 — keyed remount: React unmounts instance #1 (owner-token cleanup effect fires) and
    // mounts a FRESH instance #2 with its own token — exactly like a session switch in AiChatPanel.
    rerender(<RemountHarness sessionKey="s2" />)

    // (2a) the run is no longer owned by any LIVE instance.
    expect(isOwnRun(RUN_ID)).toBe(false)

    // Phase 3 — a background watcher (as the (re)mounted panel would run for this session) probes,
    // witnesses the now-background run, and settles EXACTLY once on the persisted-truth broadcast.
    activeState.active = true
    activeState.runId = RUN_ID
    const onSettled = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <BackgroundWatcher onSettled={onSettled} />
      </QueryClientProvider>
    )
    await waitFor(() => expect(runActiveProbeCount(fetchMock)).toBeGreaterThan(0))
    expect(onSettled).not.toHaveBeenCalled()

    activeState.active = false
    broadcast({ sessionId: SESSION_ID, status: 'finished', runId: RUN_ID })
    // (2b) settles exactly once — the watched session marks itself read too.
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(mockMarkRead).toHaveBeenCalledWith(SESSION_ID)
    // a duplicate observation of the SAME run (the invalidated poll racing the broadcast) must not
    // double-fire.
    await new Promise((r) => setTimeout(r, 30))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})
