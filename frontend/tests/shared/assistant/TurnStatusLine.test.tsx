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
  tools: {
    Fallback: ({ toolName }: { toolName: string }) => <span data-testid="tool">{toolName}</span>
  }
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
    render(
      <Harness status="streaming" messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]} />
    )
    await waitFor(() => expect(screen.getByText('AI 思考中…')).toBeTruthy())
  })

  // 阶段 0.5-① G7 — a running tool used to be narrated TWICE (this line + the tool card's own
  // spinner/elapsed). The card owns that row now, so the status line goes silent at calling-tool,
  // exactly like it already did beside an approval card.
  test('running + tool executing → NO status line (the tool card IS the status)', async () => {
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
                type: 'tool-email_search',
                toolCallId: 't1',
                state: 'input-available',
                input: { q: 'x' }
              }
            ]
          }
        ]}
      />
    )
    await waitFor(() => expect(screen.getByTestId('tool')).toBeTruthy())
    expect(screen.queryByText(/正在调用/)).toBeNull()
    expect(screen.queryByText('AI 思考中…')).toBeNull()
    expect(screen.queryByText(/仍在等待响应/)).toBeNull()
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

// --- W3-② 回合级秒表 --------------------------------------------------------------------------
//
// 同一口渲染器时钟（useToolElapsed），所以同样的三条契约在这条线上也要成立：没起点不编数、
// reduced-motion 不 tick（于是整条秒表不出现，而不是冻在一个骗人的 0.0s）、终态不挂读数。

describe('TurnStatusLine — W3-② 回合级秒表', () => {
  const running = [USER, { id: 'a1', role: 'assistant', parts: [] }]

  test('reduced-motion（套件默认）→ 不 tick，也就没有秒表（冻住的 0.0s 是谎话）', async () => {
    render(<Harness status="streaming" messages={running} />)
    await waitFor(() => expect(screen.getByText('AI 思考中…')).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByTitle('耗时')).toBeNull()
  })

  test('motion allowed → connecting/thinking 阶段秒表在走', async () => {
    // 退出套件默认的 reduced-motion（先例：ToolTraceCard.test.tsx / useExitAnimation.test.tsx）。
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null
        }) as unknown as MediaQueryList
    )
    try {
      render(<Harness status="streaming" messages={running} />)
      await waitFor(() => expect(screen.getByTitle('耗时')).toBeTruthy())
      const first = screen.getByTitle('耗时').textContent ?? ''
      expect(first).toMatch(/^\d+(\.\d)?[sm]/)
      // 自己在长 —— 这是「秒表」，不是挂载那一刻冻住的数。
      await waitFor(() => expect(screen.getByTitle('耗时').textContent).not.toBe(first), {
        timeout: 2000
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('工具执行中 → 这条线整个不渲染，秒表自然也不重复（G7 由工具卡自己报时）', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          {
            id: 'a1',
            role: 'assistant',
            parts: [
              { type: 'tool-email_search', toolCallId: 't1', state: 'input-available', input: {} }
            ]
          }
        ]}
      />
    )
    await waitFor(() => expect(screen.getByTestId('tool')).toBeTruthy())
    expect(screen.queryByTitle('耗时')).toBeNull()
  })
})

// --- stall watchdog (hook-level, fake timers) -----------------------------------------------

function StallProbe({
  resetKey,
  active
}: {
  resetKey: unknown
  active: boolean
}): React.JSX.Element {
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
