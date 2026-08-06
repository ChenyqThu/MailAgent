// @vitest-environment happy-dom
//
// beui `tool-result` 收编 —— **只补收尾编排**的五条（R1–R5）。既有四段式（流式参数 / 骨架 /
// 标题行 / 最终结果）与实时计时的回归网仍在 `ToolTraceCard.test.tsx`，那份必须原样全绿。
//
// 驱动方式与那份同源：真 ai-sdk runtime（useAISDKRuntime → react-ai-sdk convertMessage →
// MessagePrimitive.Parts）+ 真生产 part map，所以 args/result/approval 是转换器产出的而非手捏。
// 唯一例外是 R5 的 cancelled —— 见该 describe 里的说明（转换器结构上就吐不出那个形状）。
//
// 🔴 判别式纪律：下面每条断言在收编前都会红。特别是 R1/R3，实现短路掉即转红（变异检验已跑）。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { getAssistantPartComponents } from '@shared/assistant/tools/registerToolUIs'
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'

await i18n.changeLanguage('zh-CN')

/** 记录每一次 scrollTo：`this` 是哪个元素、参数是什么。vi.fn() 不记 this，所以手写。 */
const scrollCalls: Array<{ el: Element; opts: unknown }> = []

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
  Element.prototype.scrollTo = function (this: Element, opts: unknown): void {
    scrollCalls.push({ el: this, opts })
  } as unknown as Element['scrollTo']
})

afterEach(() => {
  cleanup()
  scrollCalls.length = 0
  vi.unstubAllGlobals()
})

/** 关掉全局 reduced-motion（tests/setup.ts 强制开），跑真实动效分支。 */
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

/** convertMessage 在 message OBJECT 上缓存，所以每次 rerender 必须换一个新对象。 */
function turn(name: string, over: Record<string, unknown>): unknown[] {
  return [
    USER,
    { id: 'a1', role: 'assistant', parts: [{ type: `tool-${name}`, toolCallId: 't1', ...over }] }
  ]
}

const RUNNING = { state: 'input-available', input: { q: 'okr' } }
const SETTLED = { state: 'output-available', input: { q: 'okr' }, output: { hits: 1 } }

function toggle(): HTMLElement {
  return screen.getByRole('button')
}
function logRegion(): HTMLElement {
  return screen.getByRole('log')
}

describe('R1 — 完成即自动折叠 / 重新 running 自动展开', () => {
  test('running → settled: 用户手动展开的详情自动收起', async () => {
    const { rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')

    rerender(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  test('settled → running: 又跑起来时自动展开（不需要用户再点一次）', async () => {
    const { rerender } = render(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    rerender(<Harness status="streaming" messages={turn('kos_query', RUNNING)} />)
    await waitFor(() => expect(screen.getByLabelText('运行中')).toBeTruthy())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  test('🔴 挂载即 running 仍从折叠态起 —— R1 是「转变」不是 `open = !settled`', async () => {
    // 这条守的是把 R1 写成派生态的那种实现：那样每轮对话一开口就炸出一堆 JSON。
    render(<Harness status="streaming" messages={turn('kos_query', RUNNING)} />)
    await waitFor(() => expect(screen.getByLabelText('运行中')).toBeTruthy())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  test('折叠态走 CollapsibleRegion 的 inert（子树退出 tab 序），展开即撤销', async () => {
    render(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())

    const region = document.getElementById(toggle().getAttribute('aria-controls') ?? '')
    expect(region).toBeTruthy()
    expect(region?.hasAttribute('inert')).toBe(true)

    fireEvent.click(toggle())
    expect(region?.hasAttribute('inert')).toBe(false)
  })
})

/** 组件里 `OUTPUT_MAX_HEIGHT` 的镜像（该常量是模块私有；R4 的第一条测试把这个数字钉死）。 */
const VIEWPORT_H = 220

describe('R2 — running 时输出区自动滚到底', () => {
  test('展开且仍在跑 → 对输出视口发起 scrollTo；reduce 下 behavior 取 auto', async () => {
    render(<Harness status="streaming" messages={turn('kos_query', RUNNING)} />)
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    fireEvent.click(toggle())

    const viewport = logRegion()
    await waitFor(() => {
      const mine = scrollCalls.filter((c) => c.el === viewport)
      expect(mine.length).toBeGreaterThan(0)
      expect((mine[mine.length - 1]?.opts as { behavior?: string }).behavior).toBe('auto')
    })
  })

  test('允许动效时 behavior 取 smooth', async () => {
    allowMotion()
    render(<Harness status="streaming" messages={turn('kos_query', RUNNING)} />)
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    fireEvent.click(toggle())

    const viewport = logRegion()
    await waitFor(() => {
      const mine = scrollCalls.filter((c) => c.el === viewport)
      expect(mine.length).toBeGreaterThan(0)
      expect((mine[mine.length - 1]?.opts as { behavior?: string }).behavior).toBe('smooth')
    })
  })

  // happy-dom 不做布局计算，scrollHeight/clientHeight 恒 0；手动喂一副「内容比视口高很多」的
  // 几何，下面两条才谈得上「离底部多远」。
  function makeScrollable(el: HTMLElement): void {
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: VIEWPORT_H, configurable: true })
  }

  test('🔴 用户手动上滚后不再被拽回底部（参数仍在流式增长）', async () => {
    // 这条守的是自动滚底最经典的体验 bug：running 期这个区**只可能**是用户手点开的（R1 从不
    // 自动展开挂载即 running 的卡），被拽回的正是刚表达了「我要看」的那个人。
    //
    // 🔴 08-06 ⑤ 起触发源换了，判据必须跟着换：**秒表不再是重渲来源**（`useToolElapsed` 已下沉
    // 到叶子组件 `ToolElapsedLabel`，见该组件注释 —— 提频到 100ms 前先掐掉的那条因果）。原来这
    // 条只靠「等 500ms ≥2 个 tick」就能逼出重跑；现在必须显式喂一次**真正的内容增长**（流式
    // 参数变长 = props 变 = 那个无依赖数组的 layout effect 重跑），否则删掉 `stickToBottomRef`
    // 这道闸测试照样绿（实测：改判据前把闸删掉，本条不红）。
    allowMotion()
    const { rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    fireEvent.click(toggle())

    const viewport = logRegion()
    makeScrollable(viewport)
    await waitFor(() =>
      expect(scrollCalls.filter((c) => c.el === viewport).length).toBeGreaterThan(0)
    )

    fireEvent.wheel(viewport, { deltaY: -120 })
    viewport.scrollTop = 0
    fireEvent.scroll(viewport)

    const before = scrollCalls.filter((c) => c.el === viewport).length
    // 内容继续长（模型还在吐参数）——「跟随」的本职触发源。
    rerender(
      <Harness
        status="streaming"
        messages={turn('kos_query', { state: 'input-available', input: { q: 'okr 又长了一截' } })}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(scrollCalls.filter((c) => c.el === viewport)).toHaveLength(before)
  })

  // 08-06 ⑤ 注记：「恢复」的观察窗口也跟着换了。秒表下沉成叶子组件后，回到底部只是把意图闸拨
  // 回 true —— **下一次真实内容增长**才会看到跟随重新发生。这不是退化：没有新内容时本来就没有
  // 「跟」这回事（人已经在底部了），旧行为只是被每 200ms 一次的秒表重渲顺带触发的空滚动。
  test('用户自己滚回底部 → 下一次内容增长时跟随恢复', async () => {
    allowMotion()
    const { rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    fireEvent.click(toggle())

    const viewport = logRegion()
    makeScrollable(viewport)
    // 🔴 先把首次挂载排的那个 rAF 排空，否则它会在下面的 `paused` 之后才落，把「跟随恢复了」
    // 伪装出来（本条测试第一版就这样假绿过，把 epsilon 改坏也照样通过）。
    await waitFor(() =>
      expect(scrollCalls.filter((c) => c.el === viewport).length).toBeGreaterThan(0)
    )

    fireEvent.wheel(viewport, { deltaY: -120 })
    viewport.scrollTop = 0
    fireEvent.scroll(viewport)
    await new Promise((resolve) => setTimeout(resolve, 300)) // 确认真的停了
    const paused = scrollCalls.filter((c) => c.el === viewport).length

    viewport.scrollTop = 1000 - VIEWPORT_H // 回到底
    fireEvent.scroll(viewport)
    rerender(
      <Harness
        status="streaming"
        messages={turn('kos_query', { state: 'input-available', input: { q: 'okr 又长了一截' } })}
      />
    )
    await waitFor(() =>
      expect(scrollCalls.filter((c) => c.el === viewport).length).toBeGreaterThan(paused)
    )
  })

  test('又跑起来时跟随复位 —— 上一轮的「我要往上翻」不粘到下一轮', async () => {
    allowMotion()
    const { rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByText('查询知识图谱')).toBeTruthy())
    fireEvent.click(toggle())

    const viewport = logRegion()
    makeScrollable(viewport)
    await waitFor(() =>
      expect(scrollCalls.filter((c) => c.el === viewport).length).toBeGreaterThan(0)
    )

    // 第一轮：用户滚上去 → 跟随停
    fireEvent.wheel(viewport, { deltaY: -120 })
    viewport.scrollTop = 0
    fireEvent.scroll(viewport)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const paused = scrollCalls.filter((c) => c.el === viewport).length

    // settle 后又跑起来（R1 会自动展开）→ 新一轮该重新跟随，不必用户再滚回底部
    rerender(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    rerender(<Harness status="streaming" messages={turn('kos_query', RUNNING)} />)
    await waitFor(() => expect(screen.getByLabelText('运行中')).toBeTruthy())

    await waitFor(() =>
      expect(scrollCalls.filter((c) => c.el === logRegion()).length).toBeGreaterThan(paused)
    )
  })

  test('已完成的卡不再跟随（历史回放不该被拽到底）', async () => {
    render(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    fireEvent.click(toggle())

    const viewport = logRegion()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(scrollCalls.filter((c) => c.el === viewport)).toHaveLength(0)
  })
})

describe('R3 — 状态槽位 roll 切换', () => {
  test('允许动效：状态槽位由 roll 层承载，且层身份 = 当前状态', async () => {
    allowMotion()
    const { container, rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByLabelText('运行中')).toBeTruthy())
    expect(container.querySelector('[data-roll-swap="on"]')).toBeTruthy()
    expect(container.querySelector('[data-roll-layer="live"]')).toBeTruthy()
    expect(container.querySelector('[data-roll-layer="ok"]')).toBeNull()

    rerender(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(container.querySelector('[data-roll-layer="ok"]')).toBeTruthy())
  })

  test('🔴 reduce 下不做 roll：直接替换，结构上没有第二层', async () => {
    const { container, rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByLabelText('运行中')).toBeTruthy())
    expect(container.querySelector('[data-roll-swap="on"]')).toBeNull()
    expect(container.querySelector('[data-roll-swap="off"]')).toBeTruthy()

    rerender(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    expect(container.querySelectorAll('[data-roll-layer]')).toHaveLength(0)
  })

  test('🔴 无 blur —— DESIGN §8「filter is never transitioned」', async () => {
    allowMotion()
    const { container } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(container.querySelector('[data-roll-layer="live"]')).toBeTruthy())
    for (const el of container.querySelectorAll('[data-roll-layer]')) {
      expect((el as HTMLElement).style.filter ?? '').not.toContain('blur')
      expect(el.className).not.toContain('filter')
    }
  })

  test('状态名留在不参与动画的外层，退场层不带第二个名字', async () => {
    allowMotion()
    const { rerender } = render(
      <Harness status="streaming" messages={turn('kos_query', RUNNING)} />
    )
    await waitFor(() => expect(screen.getByLabelText('运行中')).toBeTruthy())

    rerender(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    // 即便退场层还挂在 DOM 上，AT 也只看得到一个状态。
    expect(screen.queryByLabelText('运行中')).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })
})

describe('R4 — 输出视口：高度上限 + log 语义', () => {
  test('详情区是一个 role=log / aria-live=polite 的滚动视口，高度封顶 220', async () => {
    render(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())

    const viewport = logRegion()
    expect(viewport.getAttribute('aria-live')).toBe('polite')
    expect(viewport.style.maxHeight).toBe('220px')
    expect(viewport.className).toContain('overflow-y-auto')
    // 请求与结果都在这**一个**视口里 —— 两层滚动条套起来外层永远滚不到底，R2 就成了摆设。
    fireEvent.click(toggle())
    expect(viewport.textContent).toContain('请求参数')
    expect(viewport.textContent).toContain('返回结果')
  })

  test('结果 pre 不再自带 max-h-48（单一滚动容器）', async () => {
    const { container } = render(<Harness status="ready" messages={turn('kos_query', SETTLED)} />)
    await waitFor(() => expect(screen.getByLabelText('已完成')).toBeTruthy())
    fireEvent.click(toggle())
    expect(logRegion().querySelector('.max-h-48')).toBeNull()
    expect(container.querySelectorAll('[role="log"]')).toHaveLength(1)
  })
})

describe('R5 — cancelled 从 denied 里分出来', () => {
  // 🔴 这一组直接渲染组件，而不是走上面的真 runtime —— 不是图省事：当前
  // `@assistant-ui/react-ai-sdk` 的 convertMessage 只透传 {id, approved, reason, isAutomatic}，
  // 结构上**丢掉** approval.resolution，所以这个形状根本喂不进 useAISDKRuntime。判据本身
  // （isToolCancelled）在 toolPhase.test.ts 里另有纯函数覆盖。
  function renderPart(over: Record<string, unknown>): void {
    render(
      <ToolTraceCard
        {...({
          toolName: 'kos_query',
          args: { q: 'okr' },
          argsText: '{"q":"okr"}',
          result: { error: 'x' },
          isError: true,
          status: { type: 'complete' },
          ...over
        } as never)}
      />
    )
  }

  test('resolution=cancelled → 已过期，而不是已拒绝/已失败', () => {
    renderPart({ approval: { id: 'ap1', resolution: 'cancelled' } })
    expect(screen.getByLabelText('已过期')).toBeTruthy()
    expect(screen.queryByLabelText('已拒绝')).toBeNull()
    expect(screen.queryByLabelText('已失败')).toBeNull()
  })

  test('resolution=expired 同样落这一态（闸没人决定，不是有人拒绝）', () => {
    renderPart({ approval: { id: 'ap1', resolution: 'expired' } })
    expect(screen.getByLabelText('已过期')).toBeTruthy()
    expect(screen.queryByLabelText('已拒绝')).toBeNull()
  })

  test('approved=false 仍是已拒绝 —— 主动拒绝没有被新态吃掉', () => {
    renderPart({ approval: { id: 'ap1', approved: false, reason: '用户拒绝' } })
    expect(screen.getByLabelText('已拒绝')).toBeTruthy()
    expect(screen.queryByLabelText('已过期')).toBeNull()
  })

  test('🔴 跨面同词：同一个 wire 条件在 trace 卡与审批卡上必须读作同一个词', () => {
    // 这条原本防的是「撞车」：审批卡的 `approvalShell.phase.rejected` 当时也叫「已取消 /
    // Cancelled」，而本行的新态是「没人决定」，语义相反 —— 同词不同义比不区分更误导。
    // 0805 收尾③ 把那个词让给了真正的非决定终态：`phase.rejected` 改叫「已拒绝 / Denied」，
    // 于是两个面在**两个**条件上都同词了。这里正向钉住，任一面改文案即红。
    renderPart({ approval: { id: 'ap1', resolution: 'cancelled' } })
    // ① resolution ∈ {cancelled, expired}（没人决定）→ 两面同为 expired 那个词。
    expect(screen.getByLabelText(i18n.t('chat.approvalShell.phase.expired'))).toBeTruthy()
    // ② approved === false（用户主动拒绝）→ trace 的 statusDenied 与卡的 phase.rejected 同词。
    expect(i18n.t('chat.toolStep.statusDenied')).toBe(i18n.t('chat.approvalShell.phase.rejected'))
    // ③ 而「没人决定」这一行绝不能读成「有人拒绝」——两个词必须仍然不同。
    expect(i18n.t('chat.approvalShell.phase.expired')).not.toBe(
      i18n.t('chat.approvalShell.phase.rejected')
    )
    expect(screen.queryByLabelText(i18n.t('chat.approvalShell.phase.rejected'))).toBeNull()
  })
})

describe('既有能力零丢失（收编不许吃掉这些）', () => {
  test('本地化标题 + 参数预览 chip + 请求/结果小节仍在', async () => {
    render(
      <Harness
        status="ready"
        messages={turn('email_search_fulltext', {
          state: 'output-available',
          input: { query: 'redis timeout' },
          output: { hits: 3 }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('全文搜索邮件')).toBeTruthy())
    expect(screen.getByText('redis timeout')).toBeTruthy()
    fireEvent.click(toggle())
    expect(screen.getByText('请求参数')).toBeTruthy()
    expect(screen.getByText('返回结果')).toBeTruthy()
  })
})
