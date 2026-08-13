// @vitest-environment happy-dom
//
// living-bot-avatar WP5 — TurnPresence（消息流回合在场行：动效头像 + 状态文字）的纪律网。
//
// 迁移自已退役的状态行测试（harness-chat lane B）：render-gating（shimmer 永动 fix）与
// W3-② 回合级秒表两套契约在新载体上原样存活 —— 判据从「整行不渲染」改为「文字区沉默但
// 头像在场」（G7 的本意是别双重叙述工具进度，头像是表情不是叙述，纪律不冲突）。
// 新增：TurnPresenceRow 阶段矩阵（直驱展示层）+ celebrate 时序（假时钟）+ 接线纪律
// （isLast / readOnly）。
//
// 组件测试驱动 REAL ai-sdk runtime 管线（useAISDKRuntime → AISDKMessageConverter →
// external store），与 thread_running_guard.test.tsx 同一套 harness，故 stage 机读到的
// message.parts / message.status 是生产同源派生。stall 升级在 hook 层用假时钟演练。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import {
  AssistantPanelBotAvatar,
  CELEBRATE_FADE_MS,
  CELEBRATE_HOLD_MS,
  TurnPresence,
  TurnPresenceEmpty,
  TurnPresenceRow
} from '@shared/assistant/components/TurnPresence'
import { avatarShellRadiusClass } from '@shared/components/agents/avatarShell'
import { ThreadReadOnlyContext } from '@shared/assistant/components/threadReadOnlyContext'
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

/** 退出套件默认的 reduced-motion（先例：ToolTraceCard.test.tsx / useExitAnimation.test.tsx）。
 *  调用方负责 vi.unstubAllGlobals()。 */
function allowMotion(): void {
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
}

// --- TurnPresenceRow — 阶段纪律矩阵（直驱展示层，无 runtime） -------------------------------
//
// 文字区显隐纪律（文件头规格）：connecting/thinking 出 shimmer；stalled 静态两档文案；
// error 静态红字；writing/calling-tool/awaiting-approval 沉默（正文/工具卡/审批卡自述）——
// 但头像全程在场，data-bot-state 按 §6.4 映射换表情。

describe('TurnPresenceRow — 阶段纪律矩阵', () => {
  const silence = (): void => {
    expect(screen.queryByText('AI 思考中…')).toBeNull()
    expect(screen.queryByText(/仍在等待响应/)).toBeNull()
    expect(screen.queryByText('响应出错')).toBeNull()
  }

  test('connecting → waking + shimmer 文案', () => {
    render(<TurnPresenceRow stage="connecting" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('waking')
    expect(screen.getByText('AI 思考中…')).toBeTruthy()
  })

  test('thinking → thinking + shimmer 文案', () => {
    render(<TurnPresenceRow stage="thinking" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('thinking')
    expect(screen.getByText('AI 思考中…')).toBeTruthy()
  })

  test('calling-tool → searching，文字沉默（工具卡自述，G7）', () => {
    render(<TurnPresenceRow stage="calling-tool" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('searching')
    silence()
  })

  test('writing → writing，文字沉默（正文自述）', () => {
    render(<TurnPresenceRow stage="writing" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('writing')
    silence()
  })

  test('awaiting-approval → notifying，文字沉默（审批卡即状态）', () => {
    render(<TurnPresenceRow stage="awaiting-approval" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('notifying')
    silence()
  })

  test('stalled → drowsy + 两档静态文案（非 shimmer）', () => {
    const view = render(<TurnPresenceRow stage="stalled" stallLevel={1} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('drowsy')
    expect(screen.getByText('仍在等待响应…')).toBeTruthy()
    view.rerender(<TurnPresenceRow stage="stalled" stallLevel={2} completed={false} />)
    expect(screen.getByText('仍在等待响应（可点停止中断）…')).toBeTruthy()
  })

  test('error → sad + 静态红字，秒表不挂（终态不编造走动读数）', () => {
    render(<TurnPresenceRow stage="error" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('sad')
    const text = screen.getByText('响应出错')
    expect(text.className).toContain('text-fail')
    expect(screen.queryByTitle('耗时')).toBeNull()
  })

  test('idle 挂载帧 → 整行不渲染（挂载不是下降沿，无幽灵 celebrate）', () => {
    render(<TurnPresenceRow stage="idle" stallLevel={0} completed={true} />)
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })
})

// --- TurnPresenceRow — celebrate 时序（假时钟 + motion allowed） -----------------------------
//
// reduce 判定在效果内：celebrate 分支要 stub matchMedia 才可达（motion-gsap.md §3 先例）。

describe('TurnPresenceRow — celebrate 时序', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('真完成：celebrate hold → fading → 卸载；完成后重渲染不重播', () => {
    allowMotion()
    vi.useFakeTimers()
    const view = render(<TurnPresenceRow stage="writing" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('writing')

    view.rerender(<TurnPresenceRow stage="idle" stallLevel={0} completed={true} />)
    const row = screen.getByTestId('turn-presence')
    expect(row.dataset.botState).toBe('celebrate')
    expect(row.className).toContain('opacity-100')

    act(() => vi.advanceTimersByTime(CELEBRATE_HOLD_MS))
    expect(screen.getByTestId('turn-presence').className).toContain('opacity-0')

    act(() => vi.advanceTimersByTime(CELEBRATE_FADE_MS))
    expect(screen.queryByTestId('turn-presence')).toBeNull()

    // 同 props 重渲染：prev ref 已是 idle，不是边沿 → 绝不重播。
    view.rerender(<TurnPresenceRow stage="idle" stallLevel={0} completed={true} />)
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })

  test('abort（completed=false）不庆祝，行直接消失', () => {
    allowMotion()
    const view = render(<TurnPresenceRow stage="writing" stallLevel={0} completed={false} />)
    view.rerender(<TurnPresenceRow stage="idle" stallLevel={0} completed={false} />)
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })

  test('error → idle 不庆祝（错误收场没有可庆祝的完成）', () => {
    allowMotion()
    const view = render(<TurnPresenceRow stage="error" stallLevel={0} completed={false} />)
    view.rerender(<TurnPresenceRow stage="idle" stallLevel={0} completed={true} />)
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })

  test('新回合抢占庆祝：celebrate 中 stage 变化立即让位真实状态', () => {
    allowMotion()
    vi.useFakeTimers()
    const view = render(<TurnPresenceRow stage="writing" stallLevel={0} completed={false} />)
    view.rerender(<TurnPresenceRow stage="idle" stallLevel={0} completed={true} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('celebrate')

    view.rerender(<TurnPresenceRow stage="thinking" stallLevel={0} completed={false} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('thinking')
    // 被取消的 hold timer 不得在事后把行拽回 fading。
    act(() => vi.advanceTimersByTime(CELEBRATE_HOLD_MS + CELEBRATE_FADE_MS))
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('thinking')
    expect(screen.getByTestId('turn-presence').className).toContain('opacity-100')
  })

  test('reduced-motion（套件默认）→ 不庆祝，行直接消失', () => {
    const view = render(<TurnPresenceRow stage="writing" stallLevel={0} completed={false} />)
    view.rerender(<TurnPresenceRow stage="idle" stallLevel={0} completed={true} />)
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })
})

// --- full-runtime render harness（迁移自状态行测试，逐字同构） --------------------------------

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

// Minimal part map: TurnPresence 挂消息包装层、Empty 槽显式 null（生产同构）；tools 渲染裸
// marker，让 tool-tail 消息不用拉进 A2UI 卡。
const PARTS = {
  Empty: TurnPresenceEmpty,
  Text: ({ text }: { text: string }) => <span>{text}</span>,
  Reasoning: ({ text }: { text: string }) => <span>{text}</span>,
  tools: {
    Fallback: ({ toolName }: { toolName: string }) => <span data-testid="tool">{toolName}</span>
  }
} as unknown as React.ComponentProps<typeof MessagePrimitive.Parts>['components']

function TestAssistant(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <TurnPresence />
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
  error,
  readOnly = false
}: {
  status: string
  messages: unknown[]
  error?: unknown
  readOnly?: boolean
}): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages, error))
  return (
    <ThreadReadOnlyContext.Provider value={readOnly}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Viewport>
            <ThreadPrimitive.Messages
              components={{ UserMessage: TestUser, AssistantMessage: TestAssistant }}
            />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </ThreadReadOnlyContext.Provider>
  )
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }

describe('TurnPresence — render gating（永动 fix 迁移 + 接线纪律）', () => {
  test('running + 0 parts → connecting：头像 waking + shimmer 文案', async () => {
    render(
      <Harness status="streaming" messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]} />
    )
    await waitFor(() => expect(screen.getByText('AI 思考中…')).toBeTruthy())
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('waking')
  })

  // 阶段 0.5-① G7 的纪律在新载体上的形态：工具执行中**文字区**沉默（工具卡自己报进度/耗时，
  // 不双重叙述），但头像在场换 searching 表情 —— 表情不是叙述，不与工具卡竞争。
  test('running + tool executing → 文字沉默，头像 searching 在场', async () => {
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
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('searching')
    expect(screen.queryByText('AI 思考中…')).toBeNull()
    expect(screen.queryByText(/仍在等待响应/)).toBeNull()
  })

  test('tool paused at approval → 文字沉默（审批卡即状态），头像 notifying', async () => {
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
    await waitFor(() => expect(screen.getByTestId('tool')).toBeTruthy())
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('notifying')
    expect(screen.queryByText('AI 思考中…')).toBeNull()
    expect(screen.queryByText(/仍在等待响应/)).toBeNull()
  })

  test('completed turn (tool-tail, status ready) → 整行不渲染（settled-tail 永动 fix）', async () => {
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
    expect(screen.queryByTestId('turn-presence')).toBeNull()
    expect(screen.queryByText('AI 思考中…')).toBeNull()
  })

  test('只挂最后一条 assistant 消息：历史消息零头像', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'done earlier' }] },
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'again' }] },
          { id: 'a2', role: 'assistant', parts: [] }
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText('done earlier')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByTestId('turn-presence')).toHaveLength(1))
  })

  test('只读线程（历史回放）→ 运行态也零头像', async () => {
    render(
      <Harness
        readOnly
        status="streaming"
        messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]}
      />
    )
    // 等一个渲染周期，确认从未出现。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTestId('turn-presence')).toBeNull()
    expect(screen.queryByText('AI 思考中…')).toBeNull()
  })
})

// --- W3-② 回合级秒表（迁移） ------------------------------------------------------------------
//
// 同一口渲染器时钟（useToolElapsed），三条契约照旧：没起点不编数、reduced-motion 不 tick
// （于是整条秒表不出现，而不是冻在一个骗人的 0.0s）、终态不挂读数。

describe('TurnPresence — W3-② 回合级秒表', () => {
  const running = [USER, { id: 'a1', role: 'assistant', parts: [] }]

  test('reduced-motion（套件默认）→ 不 tick，也就没有秒表', async () => {
    render(<Harness status="streaming" messages={running} />)
    await waitFor(() => expect(screen.getByText('AI 思考中…')).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByTitle('耗时')).toBeNull()
  })

  test('motion allowed → connecting/thinking 阶段秒表在走', async () => {
    allowMotion()
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

  test('工具执行中 → 秒表不挂（G7：工具卡自己报时），头像仍在场', async () => {
    allowMotion()
    try {
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
      expect(screen.getByTestId('turn-presence')).toBeTruthy()
      expect(screen.queryByTitle('耗时')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
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

// ── 0813 主 agent 身份（Row 层投影）──────────────────────────────────────────────

describe('主 agent 身份（assistantName / imageSrc）', () => {
  test('assistantName 进 thinking 文案：Jarvis 思考中…', () => {
    render(
      <TurnPresenceRow stage="thinking" stallLevel={0} completed={false} assistantName="Jarvis" />
    )
    expect(screen.getByText('Jarvis 思考中…')).toBeTruthy()
    expect(screen.queryByText('AI 思考中…')).toBeNull()
  })

  test('缺省 assistantName：文案与改名前逐字一致（AI 思考中…）', () => {
    render(<TurnPresenceRow stage="thinking" stallLevel={0} completed={false} />)
    expect(screen.getByText('AI 思考中…')).toBeTruthy()
  })

  test('imageSrc（上传图主头像）：渲染静态 img，替代 BotAvatar', () => {
    const src = `data:image/webp;base64,${'A'.repeat(24)}`
    const { container } = render(
      <TurnPresenceRow stage="thinking" stallLevel={0} completed={false} imageSrc={src} />
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(src)
    expect(container.querySelector('[data-bot-eye]')).toBeNull()
  })
})

// ── 0813 dogfood：头像容器口径与列表侧收成同一份（avatarShell 圆角方形）────────────
// 修的是三方分裂：此前这里 bot **完全没有外壳**、上传图 rounded-full，而 AgentAvatar
// （列表/卡片/抽屉）一律圆裁。

describe('回合头像容器（圆角方形，与 AgentAvatar 同一口径）', () => {
  test('bot 头像有圆角方形外壳，不是正圆', () => {
    const { container } = render(
      <TurnPresenceRow stage="thinking" stallLevel={0} completed={false} />
    )
    const shell = container.querySelector('svg')?.parentElement
    expect(shell?.className).toContain(avatarShellRadiusClass(28))
    expect(container.innerHTML).not.toContain('rounded-full')
  })

  test('上传图走同一个外壳（img 自身不再 rounded-full）', () => {
    const src = `data:image/webp;base64,${'A'.repeat(24)}`
    const { container } = render(
      <TurnPresenceRow stage="thinking" stallLevel={0} completed={false} imageSrc={src} />
    )
    const img = container.querySelector('img')
    expect(img?.className).not.toContain('rounded-full')
    expect(img?.className).toContain('object-cover')
    expect(img?.parentElement?.className).toContain(avatarShellRadiusClass(28))
  })

  test('面板头 20px 同款外壳', () => {
    const { container } = render(<AssistantPanelBotAvatar working={false} />)
    const shell = container.querySelector('[data-testid="panel-bot-avatar"]') as HTMLElement
    expect(shell.className).toContain(avatarShellRadiusClass(20))
    expect(shell.className).toContain('overflow-hidden')
  })
})
