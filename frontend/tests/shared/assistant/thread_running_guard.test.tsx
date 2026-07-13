// @vitest-environment happy-dom
//
// Part B (island live-refresh) — the mid-stream guard's regression net, ported out of the deleted
// legacy panel test (AssistantUIChatPanel.test.tsx) when S3 removed the dual-runtime shell. The panel
// itself is now AiChatPanel.tsx (single ai-sdk runtime); the guard modules it wires
// (ThreadRunningBridge sensor + makeSessionSettledHandler decision) are unchanged, so the coverage
// that matters lives here, independent of any panel chrome.
//
// The block below drives the sensor through the REAL ai-sdk runtime pipeline (useAISDKRuntime →
// AISDKMessageConverter → external store → useThread), NOT a legacy adapter (the legacy-driven
// sensor tests could never carry an ai@6 `approval-requested` tool part, so the paused-state
// semantics — where the on-device bug lived — were untestable there). The chatHelpers stub replaces
// only the ai@6 useChat layer, whose paused-state semantics are known (stream closed → status
// 'ready'); everything above it is the production code.
//
// Device condition pinned: at an approval pause assistant-ui's thread.isRunning read TRUE (CDP probe:
// the settle IPC arrived, `aiSdkRunningRef.current === true`, no reload ran) even though the gateway
// had already closed the stream. We force isRunning=true via status:'streaming' and assert the settle
// handler REFRESHES anyway when (and only when) the last message is approval-paused.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, type ThreadMessage } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import { ThreadRunningBridge } from '@shared/assistant/runtime/ThreadRunningBridge'
import {
  makeSessionSettledHandler,
  threadMessagesAwaitApproval
} from '@shared/assistant/runtime/threadRunningGuard'

beforeAll(() => {
  // assistant-ui internals reference observers happy-dom lacks; stub them.
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
})

afterEach(() => {
  cleanup()
})

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
  const EMPTY_ASSISTANT_PLACEHOLDER = {
    id: 'a-empty-placeholder',
    role: 'assistant',
    parts: []
  }
  const RECOMMENDATION_PLACEHOLDER = {
    id: 'a-recommendation-placeholder',
    role: 'assistant',
    parts: [{ type: 'data-followups', data: ['继续分析风险', '生成回复草稿'] }]
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

  test('approval pause + trailing empty assistant placeholder → settle reloads', async () => {
    const runningRef = { current: true }
    render(
      <AiSdkGuardHarness
        status="streaming"
        messages={[USER_MSG, PAUSED_ASSISTANT, EMPTY_ASSISTANT_PLACEHOLDER]}
        runningRef={runningRef}
      />
    )
    await waitFor(() => expect(runningRef.current).toBe(false))

    const reload = vi.fn().mockResolvedValue(undefined)
    const onReloaded = vi.fn()
    makeSessionSettledHandler({
      runningRef,
      activeSessionId: 7,
      reload,
      onReloaded
    })({ sessionId: 7 })
    expect(reload).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onReloaded).toHaveBeenCalledTimes(1))
  })

  test('approval pause + trailing recommendation placeholder → settle reloads', async () => {
    const runningRef = { current: true }
    render(
      <AiSdkGuardHarness
        status="streaming"
        messages={[USER_MSG, PAUSED_ASSISTANT, RECOMMENDATION_PLACEHOLDER]}
        runningRef={runningRef}
      />
    )
    await waitFor(() => expect(runningRef.current).toBe(false))

    const reload = vi.fn().mockResolvedValue(undefined)
    const onReloaded = vi.fn()
    makeSessionSettledHandler({
      runningRef,
      activeSessionId: 7,
      reload,
      onReloaded
    })({ sessionId: 7 })
    expect(reload).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onReloaded).toHaveBeenCalledTimes(1))
  })

  test('external-store binding missing → fails closed without crashing', () => {
    const unboundEmptyAssistant = {
      id: 'a-unbound',
      role: 'assistant',
      content: [],
      status: { type: 'running' },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {}
      }
    } as unknown as ThreadMessage

    expect(() => threadMessagesAwaitApproval([unboundEmptyAssistant])).not.toThrow()
    expect(threadMessagesAwaitApproval([unboundEmptyAssistant])).toBe(false)
  })

  test('approval pause + genuinely streaming assistant → settle stays blocked', async () => {
    const runningRef = { current: false }
    render(
      <AiSdkGuardHarness
        status="streaming"
        messages={[USER_MSG, PAUSED_ASSISTANT, STREAMING_ASSISTANT]}
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
