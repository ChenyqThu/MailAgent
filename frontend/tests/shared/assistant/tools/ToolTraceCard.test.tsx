// @vitest-environment happy-dom
//
// 阶段 0.5-① 「工具执行过程可见」 — the four-段 generic tool card, driven through the REAL ai-sdk
// runtime (useAISDKRuntime → react-ai-sdk convertMessage → store → MessagePrimitive.Parts) and the
// REAL production part map (`getAssistantPartComponents()`), so `args` / `argsText` / `result` /
// `approval` are converter-derived rather than hand-mocked — the phase split depends on exactly
// how convertMessage truncates argsText mid-stream, which a hand-mock would paper over.
//
// The card is the `tools.Fallback` slot on ALL THREE chat surfaces — email panel
// (components/message.tsx), agent panel / Cmd+O (components/agents/AgentMessage.tsx) and the
// read-only history transcript (ReadOnlyTranscript → thread.tsx → AssistantMessage) — and all
// three spread the SAME `getAssistantPartComponents()` object. So the surfaces differ only in
// the INPUT they feed the runtime, and that is what is covered below:
//   · live stream  → wire parts in input-streaming / input-available (both panels);
//   · history replay → `chatMessageToUIMessage(persisted row)`, ReadOnlyTranscript's only
//     transformation, with the thread already settled (status 'ready').

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { getAssistantPartComponents } from '@shared/assistant/tools/registerToolUIs'
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'
import { McpToolFallback } from '@shared/assistant/tools/generic/McpApprovalCard'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'

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

const PARTS = getAssistantPartComponents() as unknown as React.ComponentProps<
  typeof MessagePrimitive.Parts
>['components']

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

function Harness({ status, messages }: { status: string; messages: unknown[] }): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages))
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

/** One assistant message carrying one tool part, freshly constructed — convertMessage caches on
 *  the message OBJECT, so a re-render must hand it a new one to see the updated stream. */
function turn(name: string, over: Record<string, unknown>): unknown[] {
  return [
    USER,
    { id: 'a1', role: 'assistant', parts: [{ type: `tool-${name}`, toolCallId: 't1', ...over }] }
  ]
}

const DURATION_RE = /^\d+(\.\d)?[sm]/

describe('ToolTraceCard — ① 流式参数 (live, args still arriving)', () => {
  test('runs with args flowing: partial args are VISIBLE and the row can be expanded mid-run', async () => {
    const { rerender } = render(
      <Harness
        status="streaming"
        messages={turn('email_search_fulltext', {
          state: 'input-streaming',
          input: { query: 'redis tim' }
        })}
      />
    )
    // ③ human-readable localized title, not the bare `email_search_fulltext` identifier.
    await waitFor(() => expect(screen.getByText('全文搜索邮件')).toBeTruthy())
    // ① the partially-streamed argument is already on screen.
    expect(screen.getByText('redis tim')).toBeTruthy()

    // G1 — the toggle used to be DISABLED until the tool finished; it must open mid-run now.
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('请求参数')).toBeTruthy()

    // ① the args keep growing in place as more deltas land.
    rerender(
      <Harness
        status="streaming"
        messages={turn('email_search_fulltext', {
          state: 'input-streaming',
          input: { query: 'redis timeout in the sync log' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('redis timeout in the sync log')).toBeTruthy())
  })

  test('② 首帧无参数 → animate-pulse 骨架占位（不是空白，也不是裸 spinner）', async () => {
    const { container } = render(
      <Harness
        status="streaming"
        messages={turn('email_search_fulltext', { state: 'input-streaming', input: {} })}
      />
    )
    await waitFor(() => expect(screen.getByText('全文搜索邮件')).toBeTruthy())
    const skeleton = screen.getAllByLabelText('参数生成中…')
    expect(skeleton.length).toBeGreaterThan(0)
    for (const el of skeleton) expect(el.className).toContain('animate-pulse')
    // reduced-motion degradation is on the same element (repo rule: 手写 animate-pulse 必带它).
    for (const el of skeleton) expect(el.className).toContain('motion-reduce:animate-none')
    // loading 三词汇: no shimmer anywhere on this card (spinner + shimmer must never co-exist).
    expect(container.querySelector('.think-shimmer')).toBeNull()
  })
})

describe('ToolTraceCard — ③ 标题行: status + live elapsed', () => {
  test('executing (args final) → running status, NO args skeleton', async () => {
    render(
      <Harness
        status="streaming"
        messages={turn('kos_query', { state: 'input-available', input: { q: 'okr' } })}
      />
    )
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    expect(screen.getByLabelText('运行中')).toBeTruthy()
    expect(screen.queryByLabelText('参数生成中…')).toBeNull()
  })

  test('reduced-motion (the suite default): the elapsed clock does NOT self-tick while running', async () => {
    // tests/setup.ts forces prefers-reduced-motion, and useToolElapsed then arms no interval —
    // a live tool shows no number at all rather than a frozen, lying "0.0s". The真 total still
    // lands on settle (covered by the cleanup path in the tick test below).
    render(
      <Harness
        status="streaming"
        messages={turn('kos_query', { state: 'input-available', input: { q: 'okr' } })}
      />
    )
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    expect(screen.queryByTitle('耗时')).toBeNull()
  })

  test('motion allowed → the clock TICKS while running and FREEZES on settle', async () => {
    // Opt out of the suite-wide reduced-motion stub (tests/setup.ts) — precedent:
    // tests/shared/useExitAnimation.test.tsx. Real timers: the tick is 100ms (08-06 ⑤).
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
      const running = turn('kos_query', { state: 'input-available', input: { q: 'okr' } })
      const { rerender } = render(<Harness status="streaming" messages={running} />)
      await waitFor(() => expect(screen.getByTitle('耗时')).toBeTruthy())
      const first = screen.getByTitle('耗时').textContent ?? ''
      expect(first).toMatch(DURATION_RE)
      // it grows on its own — this is the "tick", not a value frozen at mount.
      await waitFor(() => expect(screen.getByTitle('耗时').textContent).not.toBe(first), {
        timeout: 2000
      })

      // settle → the cleanup takes the final reading and nothing moves after that.
      rerender(
        <Harness
          status="ready"
          messages={turn('kos_query', {
            state: 'output-available',
            input: { q: 'okr' },
            output: { hits: 1 }
          })}
        />
      )
      await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
      const settledText = screen.getByTitle('耗时').textContent ?? ''
      expect(settledText).toMatch(DURATION_RE)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(screen.getByTitle('耗时').textContent).toBe(settledText)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // 🔴 08-06 owner dogfood ⑤ —— 「计时器的跳不连贯，看起来是 200ms？是不是 100ms 流畅一些」。
  // 判据取**读数序列**而不是 `TICK_MS === 100`：常量断言是假闸（改了显示精度、或把 interval 换成
  // rAF，它照样绿）。这里数的是「700ms 内这行字变了几个不同的值」——
  //   · 100ms 档：≈7 个；
  //   · 旧的 200ms 档：≈3 个（且十分位每次跳 2，正是 owner 看到的那种不连贯）。
  // 取 ≥5 作阈值：能咬住 200ms 回退，又给调度抖动留了 3 个 tick 的余量。
  test('🔴 节拍 100ms：读数在 700ms 内至少换 5 个不同的值（200ms 档只做得到 3 个）', async () => {
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
      render(
        <Harness
          status="streaming"
          messages={turn('kos_query', { state: 'input-available', input: { q: 'okr' } })}
        />
      )
      await waitFor(() => expect(screen.getByTitle('耗时')).toBeTruthy())
      const seen = new Set<string>()
      await waitFor(
        () => {
          seen.add(screen.getByTitle('耗时').textContent ?? '')
          expect(seen.size).toBeGreaterThanOrEqual(5)
        },
        { timeout: 700, interval: 20 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('unknown / future tool name degrades to the raw identifier (registry+i18n miss never blocks)', async () => {
    render(
      <Harness
        status="streaming"
        messages={turn('future_tool_x', { state: 'input-available', input: {} })}
      />
    )
    await waitFor(() => expect(screen.getByText('future_tool_x')).toBeTruthy())
  })
})

describe('ToolTraceCard — ④ 终态: ok / error / denied are distinguishable per row', () => {
  test('output-available → 已完成', async () => {
    render(
      <Harness
        status="ready"
        messages={turn('email_get', {
          state: 'output-available',
          input: { internal_id: 53675 },
          output: { subject: 'hi' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    expect(screen.queryByLabelText('已失败')).toBeNull()
    expect(screen.queryByLabelText('已拒绝')).toBeNull()
  })

  test('output-error → 已失败 (and the result JSON is behind the disclosure)', async () => {
    render(
      <Harness
        status="ready"
        messages={turn('email_get', { state: 'output-error', input: {}, errorText: 'boom' })}
      />
    )
    await waitFor(() => expect(screen.getByLabelText('已失败')).toBeTruthy())
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('返回结果')).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
  })

  test('output-denied → 已拒绝, NOT 已失败 (refused ≠ broke)', async () => {
    render(
      <Harness
        status="ready"
        messages={turn('email_get', {
          state: 'output-denied',
          input: {},
          approval: { id: 'ap1', approved: false, reason: '用户拒绝' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByLabelText('已拒绝')).toBeTruthy())
    expect(screen.queryByLabelText('已失败')).toBeNull()
    expect(screen.queryByLabelText('运行中')).toBeNull()
  })
})

describe('ToolTraceCard — W2-② 图标位变形（右端独立 chevron 已退役）', () => {
  test('静息 = kind 图标；hover / 展开 = chevron（展开再转 90°），行尾不再挂第二枚 chevron', async () => {
    const { container } = render(
      <Harness
        status="ready"
        messages={turn('email_get', {
          state: 'output-available',
          input: { internal_id: 53675 },
          output: { subject: 'hi' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('读取邮件')).toBeTruthy())

    // 两枚图标常驻同一个 grid 格（.icon-swap 原语），data-active 决定谁可见。
    const items = container.querySelectorAll('.icon-swap-item')
    expect(items.length).toBe(2)
    const kindIcon = items[0] as HTMLElement
    const chevron = items[1] as HTMLElement
    expect(kindIcon.getAttribute('data-active')).toBe('true')
    expect(chevron.getAttribute('data-active')).toBe('false')

    // 行尾最后一个槽位是状态图标，不再是那枚独立 chevron。
    const button = screen.getByRole('button')
    expect(button.lastElementChild?.getAttribute('role')).toBe('img')

    fireEvent.mouseEnter(button)
    expect(kindIcon.getAttribute('data-active')).toBe('false')
    expect(chevron.getAttribute('data-active')).toBe('true')
    expect(chevron.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('rotate-90')

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // 展开后指针离开，chevron 仍在（继承原 chevron 的 `open 恒显`），并保持 90°。
    fireEvent.mouseLeave(button)
    expect(chevron.getAttribute('data-active')).toBe('true')
    expect(chevron.querySelector('svg')?.getAttribute('class') ?? '').toContain('rotate-90')
  })
})

describe('ToolTraceCard — history replay surface (ReadOnlyTranscript data path)', () => {
  /** A persisted chat_db row whose ui_message_json holds a settled tool part — exactly what
   *  ReadOnlyTranscript feeds the runtime via chatMessageToUIMessage. */
  const persistedAssistantRow = {
    id: 42,
    role: 'assistant' as const,
    content: '查到了',
    thinking: null,
    model: 'claude',
    tokens_input: 10,
    tokens_output: 20,
    ui_message_json: JSON.stringify({
      id: 'a-42',
      role: 'assistant',
      parts: [
        {
          type: 'tool-email_search_fulltext',
          toolCallId: 'hist-1',
          state: 'output-available',
          input: { query: 'redis timeout' },
          output: { hits: 3 }
        }
      ]
    })
  }

  test('replayed tool: settled, with NO live affordances (no spinner, no fake 0s, no skeleton)', async () => {
    // 🔴 motion is ALLOWED here on purpose: under the suite's reduced-motion default no tool shows
    // a number at all, which would make the "no fake duration" assertion pass vacuously. With the
    // clock enabled, an absent 耗时 can only mean the start stamp was never taken (contract 1).
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
      const replayed = chatMessageToUIMessage(persistedAssistantRow)
      render(<Harness status="ready" messages={[USER, replayed]} />)

      await waitFor(() => expect(screen.getByText('全文搜索邮件')).toBeTruthy())
      expect(screen.getByLabelText('已完成')).toBeTruthy()
      // R5 — the clock never started for this part, so nothing is rendered ("0.0s" would be a lie).
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(screen.queryByTitle('耗时')).toBeNull()
      expect(screen.queryByLabelText('运行中')).toBeNull()
      expect(screen.queryByLabelText('参数生成中…')).toBeNull()
      // and the replayed request/result are still reachable.
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByText('请求参数')).toBeTruthy()
      expect(screen.getByText('返回结果')).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ToolTraceCard — mounted identically on all three surfaces', () => {
  test('the production part map used by message.tsx / AgentMessage.tsx / ReadOnlyTranscript routes here', () => {
    // message.tsx (email panel) and AgentMessage.tsx (agent panel / Cmd+O) both spread
    // getAssistantPartComponents(); ReadOnlyTranscript renders AssistantThread → AssistantMessage
    // (message.tsx). One object, one Fallback — the render assertions above therefore hold for all
    // three, and the tests above cover both INPUT shapes (live stream vs replayed row).
    // Stage 1 PR2 — the Fallback slot is now the MCP-aware router (McpToolFallback): every
    // NON-`mcp__*` tool (all of the above) still renders ToolTraceCard byte-identically — the
    // render assertions in this file drive the REAL map, so that equivalence is exercised, not
    // assumed. Routing itself is pinned in McpApprovalCard.test.tsx.
    const tools = getAssistantPartComponents().tools as { Fallback?: unknown }
    expect(tools.Fallback).toBe(McpToolFallback)
    expect(tools.Fallback).not.toBe(ToolTraceCard)
  })
})
