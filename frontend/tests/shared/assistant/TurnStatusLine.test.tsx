// @vitest-environment happy-dom
//
// harness-chat lane B — TurnStatusLine render gating + the stall watchdog.
//
// The component tests drive the REAL ai-sdk runtime pipeline (useAISDKRuntime →
// AISDKMessageConverter → external store), the same harness as thread_running_guard.test.tsx, so
// the message.parts / message.status the stage machine reads are production-derived. They assert
// the CORE 永动 fix: shimmer shows only for in-progress stages and is ABSENT at an approval gate
// and after the turn completes. The stall escalation is exercised at the hook level (useStallLevel
// + fake timers) — deterministic and free of runtime timer entanglement.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { TurnStatusLine } from '@shared/assistant/components/TurnStatusLine'
import { useStallLevel } from '@shared/assistant/runtime/useTurnStage'

await i18n.changeLanguage('zh-CN')

beforeAll(() => {
  for (const key of ['ResizeObserver', 'IntersectionObserver'] as const) {
    if (!(key in globalThis)) {
      ;(globalThis as Record<string, unknown>)[key] = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): [] {
          return []
        }
      }
    }
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
})

afterEach(() => {
  cleanup()
})

// --- full-runtime render harness ------------------------------------------------------------

function stubChatHelpers(
  status: string,
  messages: unknown[],
  error?: unknown
): Parameters<typeof useAISDKRuntime>[0] {
  return {
    status,
    messages,
    error,
    setMessages: () => {},
    sendMessage: async () => {},
    regenerate: async () => {},
    stop: () => {},
    addToolResult: () => {},
    addToolOutput: () => {},
    addToolApprovalResponse: () => {}
  } as unknown as Parameters<typeof useAISDKRuntime>[0]
}

// Minimal part map: isolate TurnStatusLine on the Empty slot; tools render a bare marker so a
// tool-tail message reaches ConditionalEmpty without pulling the A2UI cards in.
const PARTS = {
  Empty: TurnStatusLine,
  Text: ({ text }: { text: string }) => <span>{text}</span>,
  Reasoning: ({ text }: { text: string }) => <span>{text}</span>,
  tools: { Fallback: ({ toolName }: { toolName: string }) => <span data-testid="tool">{toolName}</span> }
} as unknown as React.ComponentProps<typeof MessagePrimitive.Parts>['components']

function TestAssistant(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts components={PARTS} />
    </MessagePrimitive.Root>
  )
}
function TestUser(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

function Harness({
  status,
  messages,
  error
}: {
  status: string
  messages: unknown[]
  error?: unknown
}): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages, error))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages
            components={{ UserMessage: TestUser, AssistantMessage: TestAssistant }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }

describe('TurnStatusLine — render gating (the 永动 fix)', () => {
  test('running + 0 parts → connecting shimmer shows', async () => {
    render(<Harness status="streaming" messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]} />)
    await waitFor(() => expect(screen.getByText('AI 思考中…')).toBeTruthy())
  })

  test('running + tool executing → "正在调用 {tool}…" shimmer', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          {
            id: 'a1',
            role: 'assistant',
            parts: [{ type: 'tool-email_search', toolCallId: 't1', state: 'input-available', input: { q: 'x' } }]
          }
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText('正在调用 email_search…')).toBeTruthy())
  })

  test('tool paused at approval → NO shimmer (the approval card IS the status)', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          {
            id: 'a1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-email_draft_reply',
                toolCallId: 't1',
                state: 'approval-requested',
                input: {},
                approval: { id: 'ap1' }
              }
            ]
          }
        ]}
      />
    )
    // the tool marker renders, but no status shimmer of any stage.
    await waitFor(() => expect(screen.getByTestId('tool')).toBeTruthy())
    expect(screen.queryByText('AI 思考中…')).toBeNull()
    expect(screen.queryByText(/正在调用/)).toBeNull()
    expect(screen.queryByText(/仍在等待响应/)).toBeNull()
  })

  test('completed turn (tool-tail, status ready) → NO shimmer (settled-tail 永动 fix)', async () => {
    render(
      <Harness
        status="ready"
        messages={[
          USER,
          {
            id: 'a1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-email_search',
                toolCallId: 't1',
                state: 'output-available',
                input: {},
                output: { ok: true }
              }
            ]
          }
        ]}
      />
    )
    await waitFor(() => expect(screen.getByTestId('tool')).toBeTruthy())
    expect(screen.queryByText('AI 思考中…')).toBeNull()
    expect(screen.queryByText(/正在调用/)).toBeNull()
  })
})

// --- stall watchdog (hook-level, fake timers) -----------------------------------------------

function StallProbe({ resetKey, active }: { resetKey: unknown; active: boolean }): React.JSX.Element {
  const level = useStallLevel(resetKey, active)
  return <div data-testid="lvl">{level}</div>
}

describe('useStallLevel — escalation + reset', () => {
  test('active: 0 → 1 (15s) → 2 (30s); reset on key change; inert when not active', () => {
    vi.useFakeTimers()
    try {
      const { getByTestId, rerender } = render(<StallProbe resetKey={1} active={true} />)
      expect(getByTestId('lvl').textContent).toBe('0')
      act(() => vi.advanceTimersByTime(15_000))
      expect(getByTestId('lvl').textContent).toBe('1')
      act(() => vi.advanceTimersByTime(15_000))
      expect(getByTestId('lvl').textContent).toBe('2')

      // a new resetKey (a stream delta) drops the level back to 0.
      rerender(<StallProbe resetKey={2} active={true} />)
      expect(getByTestId('lvl').textContent).toBe('0')

      // inactive (stream ended) → never escalates.
      rerender(<StallProbe resetKey={2} active={false} />)
      act(() => vi.advanceTimersByTime(60_000))
      expect(getByTestId('lvl').textContent).toBe('0')
    } finally {
      vi.useRealTimers()
    }
  })
})
