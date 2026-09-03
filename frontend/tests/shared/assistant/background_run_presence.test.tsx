// @vitest-environment happy-dom
//
// 0813 dogfood 轮 5（C/D）—— 运行条退役后的两份遗产。
//
// 迁移自已删的 `thread_run_status_bar.test.tsx`：那条药丸的三件契约里，「阶段短语」搬去了
// TurnPresence.test.tsx（叙述现在长在回合头像行上），另外两件在这里原样存活：
//   1. **detached run 的秒表接续**：`/api/ai/run/active` 只给 `ageMs`，换算成起点后秒表必须从
//      「已经跑了 42 秒」接着走 —— 切走再切回读数**不清零**是需求 D 的核心验收项，所以这里直接
//      断言它不是 0.0s。
//   2. **reduced-motion 不 tick 就不显示秒表**（沿用 useToolElapsed 的契约：冻住的读数是谎话）。
// 外加两件本轮新增的机器判据：
//   3. 「可以切走」那条提示（`chat.runStatus.safeToLeave`）中英两份 locale 都已清干净，且退役的
//      组件文件真的不在了 —— 只删组件不删文案（或反过来）都会在这里红。
//   4. 通用面 AgentThread 仍然把 `runStatusSlot` 渲染出来（运行条虽退役，这个槽还装着事项控件；
//      将来谁把这个 prop 顺手删了会在这里红）。邮件面 AssistantThread 的槽 09-02 起已删：输入
//      队列条搬进了消息流末尾（pendingSlot 尾部），那个面只剩 pendingSlot 要验。

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AssistantThread } from '@shared/assistant/components/thread'
import { BackgroundRunPresence } from '@shared/assistant/components/TurnPresence'
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

// --- ① 后台 run 的在场行（头像 + 状态 + 接续秒表） ---------------------------------------------

describe('BackgroundRunPresence — 后台 run 用同一套「头像 + 状态」呈现', () => {
  test('active=false → 整行不渲染（自门控，宿主省心）', () => {
    render(<BackgroundRunPresence active={false} startedAt={Date.now() - 5_000} />)
    expect(screen.queryByTestId('background-run-presence')).toBeNull()
  })

  test('active → 头像 working + 后台文案 + 完成后自动刷新提示', async () => {
    render(<BackgroundRunPresence active startedAt={null} />)
    const row = await waitFor(() => screen.getByTestId('background-run-presence'))
    // 「在干活」的表情：与面板头 AssistantPanelBotAvatar 同一档，不是 idle。
    expect(row.dataset.botState).toBe('working')
    expect(screen.getByText('AI 正在后台继续回复')).toBeTruthy()
    expect(screen.getByText('完成后自动刷新')).toBeTruthy()
  })

  // 🔴 需求 D 的核心验收项：切走再切回，秒表接着 /run/active 的 ageMs 走，而不是从 0.0s 重来。
  test('🔴 秒表用 ageMs 换算的起点接续 —— 切回来不从 0 起', async () => {
    allowMotion()
    render(<BackgroundRunPresence active startedAt={Date.now() - 42_000} />)
    const clock = await waitFor(() => screen.getByTitle('本回合已运行'), { timeout: 3000 })
    expect(clock.textContent).not.toBe('0.0s')
    // 42s 起算，加上测试自身的调度余量 → 42.0s~49.9s。
    expect(clock.textContent).toMatch(/^4[2-9]\.\ds$/)
  })

  test('reduced-motion（套件默认）→ 不 tick，于是整条秒表不出现（冻住的读数是谎话）', async () => {
    render(<BackgroundRunPresence active startedAt={Date.now() - 42_000} />)
    await waitFor(() => expect(screen.getByText('AI 正在后台继续回复')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 700))
    expect(screen.queryByTitle('本回合已运行')).toBeNull()
  })

  // 🔴 退役的运行条要靠一个显式 `key` 才能防止后台起点漏进紧接着的附着回合；现在这条纪律
  // **结构性消失** —— 后台形态与回合形态是两个组件、挂在两个位点，React 不可能复用同一个
  // startedAtRef。这里钉住那个结构：本组件不出现「回合」相关的判据，且 active 翻假即整行消失。
  test('active 翻假 → 整行消失（起点随实例一起走，不可能漏给下一回合）', async () => {
    allowMotion()
    const view = render(<BackgroundRunPresence active startedAt={Date.now() - 42_000} />)
    await waitFor(() => expect(screen.getByTitle('本回合已运行')).toBeTruthy(), { timeout: 3000 })
    view.rerender(<BackgroundRunPresence active={false} startedAt={null} />)
    expect(screen.queryByTestId('background-run-presence')).toBeNull()
    expect(screen.queryByTitle('本回合已运行')).toBeNull()
  })
})

// --- ② 运行条退役的机器判据 --------------------------------------------------------------------

describe('运行条整条退役（组件 + 文案一起）', () => {
  const LOCALES = resolve(process.cwd(), 'src/shared/i18n/locales')

  test('🔴 `chat.runStatus.safeToLeave` 中英两份 locale 都已清掉', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const raw = readFileSync(resolve(LOCALES, locale, 'common.json'), 'utf8')
      const dict = JSON.parse(raw) as { chat: { runStatus: Record<string, string> } }
      expect(Object.keys(dict.chat.runStatus)).not.toContain('safeToLeave')
      // 文案本体也不许改名换姓活下来。
      expect(raw).not.toContain('可以切走')
      expect(raw).not.toContain('Safe to leave —')
    }
  })

  test('🔴 组件文件真的不在了（只删文案不删组件 = 死代码继续渲染那句话）', () => {
    expect(
      existsSync(resolve(process.cwd(), 'src/shared/assistant/components/ThreadRunStatusBar.tsx'))
    ).toBe(false)
  })

  test('被 TurnPresence 接管的 label 集仍在（删过头会让头像行掉回缺翻译占位符）', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const dict = JSON.parse(readFileSync(resolve(LOCALES, locale, 'common.json'), 'utf8')) as {
        chat: { runStatus: Record<string, string> }
      }
      expect(Object.keys(dict.chat.runStatus).sort()).toEqual([
        'background',
        'backgroundHint',
        'callingTool',
        'connecting',
        'elapsed',
        'writing'
      ])
    }
  })
})

// --- ③ 槽还在 -------------------------------------------------------------------------------------
//
// jsdom 不排版，验不了「在 composer 上方」；能验的是 **slot 真的接上了** —— AgentThread 把
// runStatusSlot 渲染出来了（运行条退役后它装的是事项控件）；两个 shell 的 pendingSlot 都渲染。

describe('thread shell 的槽', () => {
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

  test('通用面 AgentThread（sticky ViewportFooter 内 → 跟着 composer 走）', async () => {
    mount(<AgentThread runStatusSlot={marker} />)
    await waitFor(() => expect(screen.getByTestId('run-slot')).toBeTruthy())
  })

  test('两个 shell 的 pendingSlot（后台在场行的落点）也都渲染', async () => {
    const pending = <div data-testid="pending-slot">bg</div>
    mount(<AssistantThread pendingSlot={pending} />)
    await waitFor(() => expect(screen.getByTestId('pending-slot')).toBeTruthy())
    cleanup()
    mount(<AgentThread pendingSlot={pending} />)
    await waitFor(() => expect(screen.getByTestId('pending-slot')).toBeTruthy())
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
