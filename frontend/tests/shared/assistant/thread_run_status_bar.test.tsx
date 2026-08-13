// @vitest-environment happy-dom
//
// WP-14 — composer 上方的回合级运行状态条。
//
// 三件事在这里钉死：
//   1. **阶段短语 + 工具名**：thread 作用域喂同一个纯函数 `deriveTurnStage`（零 gateway 改动），
//      所以 connecting / thinking / calling-tool / writing 各出各的话，idle / 审批门 / 终态一律
//      不渲染（后两者的状态归消息流里的审批卡与错误 footer，运行条不抢话）。
//   2. **detached run 的秒表接续**：`/api/ai/run/active` 只给 `ageMs`，换算成起点后秒表必须从
//      「已经跑了 42 秒」接着走 —— 切走再切回读数**不清零**是这个包的核心验收项，所以这里直接
//      断言它不是 0.0s。
//   3. **reduced-motion 不 tick 就不显示秒表**（沿用 useToolElapsed 的契约：冻住的读数是谎话）。
//
// 渲染用的是真 ai-sdk runtime 管线（useAISDKRuntime → AISDKMessageConverter），harness 逐字沿用
// TurnPresence.test.tsx，所以 parts / status 是生产派生出来的形状，不是手捏的。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AssistantThread } from '@shared/assistant/components/thread'
import { ThreadRunStatusBar } from '@shared/assistant/components/ThreadRunStatusBar'
import { formatRunElapsed, useRunElapsed } from '@shared/assistant/runtime/useRunElapsed'
import { AgentThread } from '@shared/components/agents/AgentThread'

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
  vi.unstubAllGlobals()
})

/** 退出套件默认的 reduced-motion（先例：TurnPresence.test.tsx / ToolTraceCard.test.tsx）。 */
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

// --- full-runtime render harness --------------------------------------------------------------

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

function Harness({
  status,
  messages,
  backgroundActive = false,
  backgroundStartedAt = null
}: {
  status: string
  messages: unknown[]
  backgroundActive?: boolean
  backgroundStartedAt?: number | null
}): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadRunStatusBar
          backgroundActive={backgroundActive}
          backgroundStartedAt={backgroundStartedAt}
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }

const bar = (): HTMLElement | null => document.querySelector('[data-run-status-bar]')

// --- ① 阶段短语 -------------------------------------------------------------------------------

describe('ThreadRunStatusBar — 阶段短语（thread 作用域复用 deriveTurnStage）', () => {
  test('running + 0 parts → 正在连接', async () => {
    render(
      <Harness status="streaming" messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]} />
    )
    await waitFor(() => expect(screen.getByText('正在连接…')).toBeTruthy())
    expect(bar()?.getAttribute('data-run-status-bar')).toBe('connecting')
  })

  test('running + 末条是 reasoning → AI 思考中', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'reasoning', text: '让我想想' }] }
        ]}
      />
    )
    await waitFor(() => expect(bar()?.getAttribute('data-run-status-bar')).toBe('thinking'))
    expect(screen.getByText('AI 思考中…')).toBeTruthy()
  })

  test('running + 工具执行中 → 「正在<工具人话名>…」（复用工具卡那份标题表）', async () => {
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
                type: 'tool-web_search',
                toolCallId: 't1',
                state: 'input-available',
                input: { q: 'x' }
              }
            ]
          }
        ]}
      />
    )
    // chat.toolTitle.web_search = 「联网搜索」→ 「正在联网搜索…」（验收里那句「正在搜索网页」的形态）
    await waitFor(() => expect(screen.getByText('正在联网搜索…')).toBeTruthy())
    expect(bar()?.getAttribute('data-run-status-bar')).toBe('calling-tool')
  })

  test('running + 正文在流 → 正在回复', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '部分答复' }] }
        ]}
      />
    )
    await waitFor(() => expect(bar()?.getAttribute('data-run-status-bar')).toBe('writing'))
    expect(screen.getByText('正在回复…')).toBeTruthy()
  })

  test('进行中恒带「可以切走，不会中断」—— detached run 默认开，这句以前一个字都没说', async () => {
    render(
      <Harness status="streaming" messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]} />
    )
    await waitFor(() => expect(screen.getByText('可以切走，不会中断')).toBeTruthy())
  })

  test('回合结束（complete）→ 整条不渲染', async () => {
    const { container } = render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答完了' }] }
        ]}
      />
    )
    await waitFor(() => expect(container.querySelector('[data-run-status-bar]')).toBeNull())
  })

  test('审批门 → 整条不渲染（审批卡自己就是状态；也避免历史会话重放出一个假秒表）', async () => {
    const { container } = render(
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
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector('[data-run-status-bar]')).toBeNull()
  })
})

// --- ② detached run：ageMs 接续 ---------------------------------------------------------------

describe('ThreadRunStatusBar — detached run（backgroundActive）', () => {
  test('压过本地 idle：显示后台文案 + 完成后自动刷新提示', async () => {
    render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧回合' }] }
        ]}
        backgroundActive
        backgroundStartedAt={null}
      />
    )
    await waitFor(() => expect(screen.getByText('AI 正在后台继续回复')).toBeTruthy())
    expect(bar()?.getAttribute('data-run-status-bar')).toBe('background')
    expect(screen.getByText('完成后自动刷新')).toBeTruthy()
  })

  // 🔴 本包的核心验收项：切走再切回，秒表接着 /run/active 的 ageMs 走，而不是从 0.0s 重来。
  // （08-06 ⑤ 提频/提精度后这条尤其要守：参考实现的「计数器每 tick +1」形状一重挂载就归零，
  //   正是被这一格拦下的东西。）
  test('秒表用 ageMs 换算的起点接续 —— 不清零', async () => {
    allowMotion()
    render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧回合' }] }
        ]}
        backgroundActive
        backgroundStartedAt={Date.now() - 42_000}
      />
    )
    const clock = await waitFor(() => screen.getByTitle('本回合已运行'), { timeout: 3000 })
    expect(clock.textContent).not.toBe('0.0s')
    // 42s 起算，加上测试自身的调度余量 → 42.0s~49.9s。
    expect(clock.textContent).toMatch(/^4[2-9]\.\ds$/)
  })

  // 🔴 回归：后台 run 的起点绝不能漏进紧接着的**附着**回合。用户在后台 run 还挂着时直接发下一条
  // （detached 默认开，这条路真实可达），backgroundActive 翻假的同一次提交里本地阶段就已经是
  // connecting —— 两个形态由同一个组件承载，若不强制换实例，`useRunElapsed` 的 startedAtRef 会把
  // 后台那 42 秒带给新回合（use_background_chat_run 那侧只保证 anchor 变 null，拦不住这个 ref）。
  test('后台 → 附着：秒表重新起表，不把后台 run 的旧起点带进新回合', async () => {
    allowMotion()
    const { rerender } = render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧回合' }] }
        ]}
        backgroundActive
        backgroundStartedAt={Date.now() - 42_000}
      />
    )
    await waitFor(
      () => expect(screen.getByTitle('本回合已运行').textContent).toMatch(/^4[2-9]\./),
      {
        timeout: 3000
      }
    )
    // 生产次序：store 先翻 running（backgroundActive 仍真、条子仍挂着），随后 ThreadRunningBridge
    // 才把 localRunning 报上去 → backgroundActive 翻假。中间没有「整条 null」的空档。
    rerender(
      <Harness
        status="streaming"
        messages={[USER, { id: 'a2', role: 'assistant', parts: [] }]}
        backgroundActive
        backgroundStartedAt={Date.now() - 42_000}
      />
    )
    await new Promise((r) => setTimeout(r, 30))
    rerender(
      <Harness
        status="streaming"
        messages={[USER, { id: 'a2', role: 'assistant', parts: [] }]}
        backgroundActive={false}
        backgroundStartedAt={null}
      />
    )
    await waitFor(() => expect(bar()?.getAttribute('data-run-status-bar')).toBe('connecting'))
    const clock = await waitFor(() => screen.getByTitle('本回合已运行'), { timeout: 3000 })
    expect(clock.textContent).toMatch(/^[0-3]\.\ds$/)
  })

  test('reduced-motion（套件默认）→ 不 tick，于是整条秒表不出现（冻住的读数是谎话）', async () => {
    render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧回合' }] }
        ]}
        backgroundActive
        backgroundStartedAt={Date.now() - 42_000}
      />
    )
    await waitFor(() => expect(screen.getByText('AI 正在后台继续回复')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 700))
    expect(screen.queryByTitle('本回合已运行')).toBeNull()
  })
})

// --- ③ 两个面的挂载点（一份组件双面挂载） -----------------------------------------------------
//
// jsdom 不排版，验不了「在 composer 上方」；能验的是 **slot 真的接上了** —— 两个 thread shell 都
// 把 runStatusSlot 渲染出来了，将来谁把这个 prop 顺手删了会在这里红。观感/位置见终报的手验清单。

describe('两个 thread shell 都挂 runStatusSlot', () => {
  const marker = <div data-testid="run-slot">bar</div>
  // 两个 shell 都会把真 composer 拉进来，composer 里有走 react-query 的子件 → 必须给 client。
  const mount = (thread: React.ReactElement): ReturnType<typeof render> =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <AiSdkRuntimeProvider gatewayBaseUrl="" sessionId={null} initialMessages={[]}>
          {thread}
        </AiSdkRuntimeProvider>
      </QueryClientProvider>
    )

  test('邮件面 AssistantThread（Viewport 与 composer 之间 → 不随消息流滚动）', async () => {
    mount(<AssistantThread runStatusSlot={marker} />)
    await waitFor(() => expect(screen.getByTestId('run-slot')).toBeTruthy())
  })

  test('通用面 AgentThread（sticky ViewportFooter 内 → 跟着 composer 走）', async () => {
    mount(<AgentThread runStatusSlot={marker} />)
    await waitFor(() => expect(screen.getByTestId('run-slot')).toBeTruthy())
  })
})

// --- ④ 秒表本体 -------------------------------------------------------------------------------

// 08-06 owner dogfood ⑤ —— 「计时器的跳不连贯」。两件事一起改：节拍 500ms→100ms（TICK_MS）
// 与读数精度整秒→一位小数（本函数）。**只改节拍治不好**：整秒读数每秒才变一次，跳不跳只取决于
// tick 网格与秒边界的相位。所以下面的表是真正的验收面 —— 断言的是**读数**，不是常量字面量。
describe('formatRunElapsed（08-06 ⑤：一位小数）', () => {
  test.each([
    [0, '0.0s'],
    [900, '0.9s'],
    [1_000, '1.0s'],
    // 🔴 owner 举的那个读数：1.5 秒时必须显示 1.5s（不是 1s，也不是 2s）。
    [1_500, '1.5s'],
    [1_599, '1.5s'], // 向下截断到十分位，不四舍五入
    [42_300, '42.3s'],
    // 🔴 边界：toFixed 自带的四舍五入会把这个变成不存在的 '60.0s'（且跳过 1m 00.0s）。
    [59_990, '59.9s'],
    [59_999, '59.9s'],
    [60_000, '1m 00.0s'],
    [65_200, '1m 05.2s'],
    [3_599_900, '59m 59.9s'],
    [3_600_000, '1h 00m 00.0s'],
    [3_723_400, '1h 02m 03.4s']
  ])('%dms → %s', (ms, expected) => {
    expect(formatRunElapsed(ms)).toBe(expected)
  })

  test('🔴 相邻十分位一定读出不同的数（= 每个 tick 都看得见，这就是"连贯"的定义）', () => {
    const seen = new Set<string>()
    for (let ms = 0; ms < 3_000; ms += 100) seen.add(formatRunElapsed(ms))
    expect(seen.size).toBe(30) // 3 秒里 30 个不同读数；整秒格式只会给出 3 个
  })

  test('非有限 / 负数 → 空串（不编数）', () => {
    expect(formatRunElapsed(Number.NaN)).toBe('')
    expect(formatRunElapsed(-1)).toBe('')
  })
})

describe('useRunElapsed', () => {
  test('有 anchor → 从 anchor 起算（不是从挂载起算）', async () => {
    allowMotion()
    const { result } = renderHook(() => useRunElapsed(Date.now() - 42_000))
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 3000 })
    expect(result.current).toBeGreaterThanOrEqual(42_000)
    expect(result.current).toBeLessThan(48_000)
  })

  test('无 anchor → 从本实例挂载起算', async () => {
    allowMotion()
    const { result } = renderHook(() => useRunElapsed(null))
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 3000 })
    expect(result.current).toBeLessThan(5_000)
  })

  test('reduced-motion（套件默认）→ 恒 null', async () => {
    const { result } = renderHook(() => useRunElapsed(Date.now() - 42_000))
    await new Promise((r) => setTimeout(r, 700))
    expect(result.current).toBeNull()
  })

  // 🔴 08-06 ⑤ —— 节拍 500ms → 100ms。判据取**刷新次数**而不是 `TICK_MS === 100`：常量断言是假闸
  // （把 interval 换成 rAF、或干脆不 setState 都照样绿）。700ms 里：100ms 档 ≈7 次刷新，旧的
  // 500ms 档只有 1 次。阈值取 5，能咬住回退又给调度抖动留余量。
  test('🔴 节拍 100ms：700ms 内至少刷新 5 次（500ms 档只做得到 1 次）', async () => {
    allowMotion()
    const { result } = renderHook(() => useRunElapsed(null))
    const seen = new Set<number>()
    await waitFor(
      () => {
        if (result.current !== null) seen.add(result.current)
        expect(seen.size).toBeGreaterThanOrEqual(5)
      },
      { timeout: 700, interval: 20 }
    )
  })

  // 🔴 参考实现的「计数器每 tick +1」形状会在这里当场翻车：起点必须来自 anchor 的墙钟差，
  // 而不是本实例累加了多少个 tick。
  test('🔴 起点是墙钟差不是 tick 计数：读数一上来就 ≥42s，不是从 0 累加上去的', async () => {
    allowMotion()
    const { result } = renderHook(() => useRunElapsed(Date.now() - 42_000))
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 3000 })
    // 第一次拿到的读数就已经在 42s 附近（累加式实现这时只会是 0.1s 上下）。
    expect(result.current).toBeGreaterThanOrEqual(42_000)
  })
})
