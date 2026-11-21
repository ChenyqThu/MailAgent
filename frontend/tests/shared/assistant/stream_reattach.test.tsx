// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuiState } from '@assistant-ui/react'

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { MailAgentChatTransport } from '@shared/assistant/runtime/useMailAgentAiSdkRuntime'
import { ThreadRunningBridge } from '@shared/assistant/runtime/ThreadRunningBridge'
import { useBackgroundChatRun } from '@shared/assistant/runtime/useBackgroundChatRun'
import {
  isOwnRun,
  registerOwnRunOwner,
  _resetOwnRunsForTest,
  type OwnRunOwner
} from '@shared/assistant/runtime/ownRuns'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'

const RUN_ID = 'run-stream-reattach-1'
const SESSION_ID = 77

type TurnPersistedPayload = {
  sessionId: number
  status: 'finished' | 'paused' | 'compacted'
  runId: string | null
}

const { stableMailApi, turnPersistedHandlers } = vi.hoisted(() => {
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
  return { stableMailApi, turnPersistedHandlers }
})

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

beforeAll(() => {
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

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function stubControls(): ChatComposerControls {
  return {
    model: 'claude-sonnet-4-6',
    availableModels: [],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    agentMentions: [],
    onAddAgentMention: vi.fn(),
    onRemoveAgentMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn()
  }
}

function makeControlledSseStream(): {
  stream: ReadableStream<Uint8Array>
  push: (frame: string) => void
  close: () => void
} {
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    }
  })
  return {
    stream,
    push: (frame: string) => controller.enqueue(enc.encode(frame)),
    close: () => controller.close()
  }
}

function ThreadMessagesProbe(): React.JSX.Element {
  const messages = useAuiState((s) => s.thread.messages)
  const text = messages
    .map((m) =>
      m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('')
    )
    .join('\n')
  return <div data-testid="thread-text">{text}</div>
}

describe('MailAgentChatTransport.reconnectToStream', () => {
  test('hits GET /api/ai/run/stream without body/onEnsureSession, records runId, and ignores 204/non-SSE/errors', async () => {
    const owner: OwnRunOwner = {}
    const dispose = registerOwnRunOwner(owner)
    let mounted = true
    let seq = 0
    const bodySpy = vi.fn(async () => ({ sessionId: 55 }))

    const sse = makeControlledSseStream()
    const fetchMock = vi
      .fn()
      // 1) 204 -> null
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // 2) non-SSE 200 JSON -> null
      .mockResolvedValueOnce(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      )
      // 3) network rejection -> null (graceful degrade)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      // 4) live SSE -> records runId & supports mounted abort -> /run/stop
      .mockResolvedValueOnce(
        new Response(sse.stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-mailagent-run-id': RUN_ID
          }
        })
      )
      // 5) POST /api/ai/run/stop
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const transport = new MailAgentChatTransport(
      {
        api: 'http://127.0.0.1:8300/api/ai/chat',
        body: bodySpy
      },
      {
        gatewayBaseUrl: 'http://127.0.0.1:8300',
        getSessionId: () => 55,
        isMounted: () => mounted,
        ownRunOwner: owner,
        nextReconnectSeq: () => ++seq,
        currentReconnectSeq: () => seq
      }
    )

    expect(await transport.reconnectToStream({ chatId: 'c1' })).toBeNull()
    expect(await transport.reconnectToStream({ chatId: 'c1' })).toBeNull()
    expect(await transport.reconnectToStream({ chatId: 'c1' })).toBeNull()
    expect(bodySpy).not.toHaveBeenCalled()
    expect(isOwnRun(RUN_ID)).toBe(false)

    const ac = new AbortController()
    const reconnected = await transport.reconnectToStream({ chatId: 'c1', abortSignal: ac.signal })
    expect(reconnected).not.toBeNull()
    expect(isOwnRun(RUN_ID)).toBe(true)
    expect(String(fetchMock.mock.calls[3][0])).toBe('http://127.0.0.1:8300/api/ai/run/stream?sessionId=55')

    // Explicit abort while mounted triggers POST /api/ai/run/stop
    ac.abort()
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/ai/run/stop'))).toBe(true)
    })

    // Unmount guard: abort when unmounted never fires /run/stop
    const beforeCalls = fetchMock.mock.calls.length
    fetchMock.mockResolvedValueOnce(
      new Response(makeControlledSseStream().stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-mailagent-run-id': 'r-unmounted' }
      })
    )
    const acUnmounted = new AbortController()
    await transport.reconnectToStream({ chatId: 'c1', abortSignal: acUnmounted.signal })
    mounted = false
    acUnmounted.abort()
    await new Promise((r) => setTimeout(r, 30))
    expect(
      fetchMock.mock.calls
        .slice(beforeCalls)
        .some((c) => String(c[0]).includes('/api/ai/run/stop'))
    ).toBe(false)

    dispose()
  })

  test('superseded reconnect seq and in-flight abort before headers do not POST /api/ai/run/stop', async () => {
    const owner: OwnRunOwner = {}
    const dispose = registerOwnRunOwner(owner)
    let seq = 0

    let resolveInFlight!: (res: Response) => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveInFlight = resolve
          })
      )
      .mockResolvedValueOnce(
        new Response(makeControlledSseStream().stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-mailagent-run-id': 'r-seq-1' }
        })
      )
      .mockResolvedValueOnce(
        new Response(makeControlledSseStream().stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-mailagent-run-id': 'r-seq-2' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const transport = new MailAgentChatTransport(
      { api: 'http://127.0.0.1:8300/api/ai/chat' },
      {
        gatewayBaseUrl: 'http://127.0.0.1:8300',
        getSessionId: () => 55,
        isMounted: () => true,
        ownRunOwner: owner,
        nextReconnectSeq: () => ++seq,
        currentReconnectSeq: () => seq
      }
    )

    // Abort while fetch is still pending before headers
    const acInFlight = new AbortController()
    const pending = transport.reconnectToStream({ chatId: 'c1', abortSignal: acInFlight.signal })
    acInFlight.abort()
    resolveInFlight(
      new Response(makeControlledSseStream().stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-mailagent-run-id': 'r-aborted-early' }
      })
    )
    expect(await pending).toBeNull()
    expect(isOwnRun('r-aborted-early')).toBe(false)

    // Superseded seq does not stop the run
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    await transport.reconnectToStream({ chatId: 'c1', abortSignal: ac1.signal })
    await transport.reconnectToStream({ chatId: 'c1', abortSignal: ac2.signal })
    ac1.abort()
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/ai/run/stop'))).toBe(false)

    dispose()
  })
})

describe('AiSdkRuntimeProvider live stream reattach on reopen', () => {
  test('auto-reattaches on existing session mount, streams tokens in real time, and masks background settle', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const sse = makeControlledSseStream()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ai/run/stream')) {
        return new Response(sse.stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-mailagent-run-id': RUN_ID
          }
        })
      }
      if (url.includes('/api/ai/run/active')) {
        return new Response(JSON.stringify({ active: true, runId: RUN_ID, ageMs: 250 }), {
          status: 200
        })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const initialMessages: MailAgentUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '写一段总结' }] }
    ]
    const onSettled = vi.fn()

    function Harness(): React.JSX.Element {
      const runningRef = useRef(false)
      const [localRunning, setLocalRunning] = useState(false)
      const bg = useBackgroundChatRun({
        gatewayBaseUrl: 'http://127.0.0.1:8300',
        sessionId: SESSION_ID,
        enabled: true,
        refreshNonce: 0,
        localRunning,
        onSettled
      })
      return (
        <>
          <div data-testid="bg-active">{String(bg.backgroundActive)}</div>
          <AiSdkRuntimeProvider
            gatewayBaseUrl="http://127.0.0.1:8300"
            sessionId={SESSION_ID}
            initialMessages={initialMessages}
          >
            <ThreadRunningBridge runningRef={runningRef} onRunningChange={setLocalRunning} />
            <ThreadMessagesProbe />
          </AiSdkRuntimeProvider>
        </>
      )
    }

    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>
    )

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(`/api/ai/run/stream?sessionId=${SESSION_ID}`))).toBe(
        true
      )
    })

    // Replay prefix arrives and renders immediately while stream stays open
    await act(async () => {
      sse.push(sseFrame({ type: 'start', messageId: 'a-reattach' }))
      sse.push(sseFrame({ type: 'text-start', id: 't1' }))
      sse.push(sseFrame({ type: 'text-delta', id: 't1', delta: '你好，' }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('thread-text').textContent).toContain('你好，')
    })
    expect(isOwnRun(RUN_ID)).toBe(true)
    expect(screen.getByTestId('bg-active').textContent).toBe('false')

    // Subsequent live delta renders in real time before completion
    await act(async () => {
      sse.push(sseFrame({ type: 'text-delta', id: 't1', delta: '世界！' }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('thread-text').textContent).toContain('你好，世界！')
    })

    // Complete stream and broadcast turn-persisted — masked because this mounted instance owns RUN_ID
    await act(async () => {
      sse.push(sseFrame({ type: 'text-end', id: 't1' }))
      sse.push(sseFrame({ type: 'finish' }))
      sse.push('data: [DONE]\n\n')
      sse.close()
    })
    await new Promise((r) => setTimeout(r, 30))
    act(() => {
      turnPersistedHandlers.forEach((h) =>
        h({ sessionId: SESSION_ID, status: 'finished', runId: RUN_ID })
      )
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(onSettled).not.toHaveBeenCalled()
  })

  test('fresh sessionId=null mount adopting sessionId mid-Turn-#1 does NOT call /api/ai/run/stream', async () => {
    const sse = makeControlledSseStream()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ai/chat')) {
        return new Response(sse.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-mailagent-run-id': 'r-turn-1' }
        })
      }
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)

    function FreshChatHarness(): React.JSX.Element {
      const [sid, setSid] = useState<number | null>(null)
      return (
        <AiSdkRuntimeProvider
          gatewayBaseUrl="http://127.0.0.1:8300"
          sessionId={sid}
          onEnsureSession={async () => {
            setSid(99)
            return 99
          }}
        >
          <ChatComposerControlsProvider value={stubControls()}>
            <ThreadComposer />
          </ChatComposerControlsProvider>
          <ThreadMessagesProbe />
        </AiSdkRuntimeProvider>
      )
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <FreshChatHarness />
      </QueryClientProvider>
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'first message' } })
    fireEvent.submit(container.querySelector('form')!)

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/ai/chat'))).toBe(true)
    })

    await act(async () => {
      sse.push(sseFrame({ type: 'start', messageId: 'a1' }))
      sse.push(sseFrame({ type: 'text-start', id: 't1' }))
      sse.push(sseFrame({ type: 'text-delta', id: 't1', delta: 'reply' }))
      sse.push(sseFrame({ type: 'text-end', id: 't1' }))
      sse.push(sseFrame({ type: 'finish' }))
      sse.push('data: [DONE]\n\n')
      sse.close()
    })

    await waitFor(() => {
      expect(screen.getByTestId('thread-text').textContent).toContain('reply')
    })
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/ai/run/stream'))).toBe(false)
  })
})
