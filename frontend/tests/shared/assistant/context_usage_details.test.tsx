// @vitest-environment happy-dom
//
// WP-22「context 环四段明细弹层」（task 08-05）—— 点环出来的 Context Details。
//
// 覆盖的契约（每条都是「改错了用户会看到假数字」的那种）：
//   1. **残差段的算式**：工具与其他 = 实报总量 − 可测三段；估算之和超了 → **钳 0** 且立旗
//      （分段条的分母跟着换成「各段之和」，否则条子会溢出 100%，或者要把某段悄悄缩小 = 编数字）。
//   2. **上限未知 → 不出 Remaining / Total Available**（WP-15 的同一条纪律延伸到弹层：
//      拿猜的上限编「还能塞多少」比不显示更糟）。
//   3. **权威与估算分得开**：Total Used 不带 ≈（模型实报），四段全带 ≈（字符数换算）。
//   4. **拉不到配置就说拉不到**：`/chat/config` 不可达 → 只出总量 + 一句「分段明细暂不可用」，
//      绝不拿 0 顶上（0 会被读成「身份文档没占地方」）。
//   5. **两个 composer 面都能开**（邮件面 ThreadComposer + agent 面 AgentComposer 共用同一个
//      组件，这是本仓「一份组件双面挂载」纪律的验收位）。
//   6. **弹层锚定与宽度**：happy-dom 不排版（getBoundingClientRect 恒 0），所以抄
//      model_picker/composer_plus_menu 的机械验法 —— 断言右锚类 + 固定宽度（320px 侧栏里
//      右锚 260px 才不越界），并断言几何**走类不走内联 style**（reduced-motion 分支的
//      `clearProps:'all'` 会清空弹层根的整个内联 style，16b 刚踩过）。
//   7. **reduced-motion 直切**：关闭时立刻卸载，不留叠层。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import type { ChatMessage } from '@shared/api/types'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'

const { listMessages, onTurnPersisted } = vi.hoisted(() => ({
  listMessages: vi.fn(),
  onTurnPersisted: vi.fn(() => () => {})
}))
// 同 context_usage_ring.test.tsx：必须返回**同一个**对象引用（生产的 makeMailApi 是模块级单例，
// 每次新字面量会让所有以 mailApi 为依赖的 useCallback/useEffect 每帧失效）。
const stableMailApi = {
  chat: {
    listMessages,
    onTurnPersisted,
    listSkills: vi.fn(async () => []),
    setSkillEnabled: vi.fn(async () => {})
  },
  email: { search: vi.fn(async () => []) }
}
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { ContextUsageRing } from '@shared/assistant/components/ContextUsageRing'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'
import {
  buildContextBreakdown,
  buildContextUsageView,
  estimateMessagesTokens,
  estimateTokens
} from '@shared/assistant/components/contextUsage.lib'

let reduceMatches = false

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
})

beforeEach(() => {
  reduceMatches = false
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('reduce') ? reduceMatches : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null
      }) as unknown as MediaQueryList
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const T = (k: string): string => i18n.t(`chat.contextUsage.${k}`)

// ── fixtures ────────────────────────────────────────────────────────────────

function model(over: Partial<ComposerModelOption> = {}): ComposerModelOption {
  return {
    ref: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    protocol: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    capabilities: null,
    maxOutput: null,
    contextWindow: 200_000,
    catalogMeta: null,
    ...over
  }
}

function controls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
  return {
    model: 'anthropic:claude-sonnet-4-6',
    availableModels: [model()],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    sessionId: 7,
    ...over
  }
}

function row(over: Partial<ChatMessage> & { id: number }): ChatMessage {
  return {
    session_id: 7,
    role: 'assistant',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: 'claude-sonnet-4-6',
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    context_tokens: null,
    created_at: 1,
    updated_at: 1,
    ...over
  } as ChatMessage
}

/** `/chat/config` 的两个原料字段。null = 端点不可达（走「分段明细暂不可用」那一档）。
 *  返回 mock 本身，供「拉了几次」这类计数断言用。 */
function stubFetch(
  config: {
    standingContext?: string
    memorySummary?: string
  } | null
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/chat/config')) {
      if (config === null) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ data: config }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const configCallCount = (f: ReturnType<typeof vi.fn>): number =>
  f.mock.calls.filter((c) => String(c[0]).includes('/chat/config')).length

function Harness({
  children,
  value
}: {
  children: React.ReactNode
  value?: ChatComposerControls
}): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={value ?? controls()}>
          {children}
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

async function openDetails(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('context-usage'))
  return await screen.findByTestId('context-usage-details')
}

// ── 1. 估算函数 ─────────────────────────────────────────────────────────────

describe('estimateTokens — 字符 → token', () => {
  test('拉丁按 4 chars/token，CJK 按 1.5', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
    expect(estimateTokens('中'.repeat(300))).toBe(200)
    // 混排 = 两半各自换算后相加再取整一次（不是逐段 ceil 累计）。
    expect(estimateTokens('中'.repeat(3) + 'ab')).toBe(Math.ceil(3 / 1.5 + 2 / 4))
  })

  test('空 / 非字符串 → 0', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })
})

describe('estimateMessagesTokens — 会话消息段', () => {
  test('优先 ui_message_json 的**字符串值**（键名是簿记字段，不算）', () => {
    const json = JSON.stringify({
      id: 'msg_1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'a'.repeat(400) }]
    })
    // 'msg_1'(5) + 'assistant'(9) + 'text'(4) + 400 = 418 chars（键名不计）→ ceil(418/4)
    expect(estimateMessagesTokens([row({ id: 1, ui_message_json: json })])).toBe(Math.ceil(418 / 4))
  })

  test('🔴 内联 data: URL（粘贴的图片）不计入 —— 按字符算会把消息段撑爆、残差压成 0', () => {
    const withImage = JSON.stringify({
      parts: [{ type: 'file', url: `data:image/png;base64,${'A'.repeat(100_000)}` }]
    })
    // 只剩 'file'(4) + 'parts' 之外的字符串值；远小于 100K/4 = 25K token。
    expect(estimateMessagesTokens([row({ id: 1, ui_message_json: withImage })])).toBeLessThan(10)
  })

  test('没有 ui_message_json / JSON 坏掉 → 退回 content', () => {
    expect(estimateMessagesTokens([row({ id: 1, content: 'a'.repeat(400) })])).toBe(100)
    expect(
      estimateMessagesTokens([
        row({ id: 1, ui_message_json: '{not json', content: 'a'.repeat(80) })
      ])
    ).toBe(20)
  })

  test('空 / 非数组 → 0', () => {
    expect(estimateMessagesTokens([])).toBe(0)
    expect(estimateMessagesTokens(undefined)).toBe(0)
  })
})

// ── 2. 残差与分段 ───────────────────────────────────────────────────────────

describe('buildContextBreakdown — 残差段', () => {
  const view = (used: number, limit: number | null): ReturnType<typeof buildContextUsageView> =>
    buildContextUsageView(used, limit)

  test('工具与其他 = 总量 − 可测三段；顺序固定；各段比例相加 = 1', () => {
    const b = buildContextBreakdown(view(10_000, 200_000)!, {
      system: 100,
      memory: 50,
      messages: 200
    })
    expect(b.segments.map((s) => s.key)).toEqual(['system', 'tools', 'memory', 'messages'])
    expect(b.segments.find((s) => s.key === 'tools')?.tokens).toBe(9650)
    expect(b.segments.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1, 6)
    expect(b.estimateExceedsTotal).toBe(false)
    expect(b.remaining).toBe(190_000)
  })

  test('🔴 估算之和 > 实报总量 → 残差钳 0 + 立旗，且比例仍相加 = 1（分母换成各段之和）', () => {
    const b = buildContextBreakdown(view(300, null)!, { system: 400, memory: 100, messages: 200 })
    expect(b.segments.find((s) => s.key === 'tools')).toBeUndefined() // 0 段不出现
    expect(b.estimateExceedsTotal).toBe(true)
    expect(b.segments.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1, 6)
    expect(b.segments.every((s) => s.share <= 1)).toBe(true)
  })

  test('可测段拉不到（measured=null）→ 无分段，只剩总量', () => {
    const b = buildContextBreakdown(view(10_000, 200_000)!, null)
    expect(b.hasSegments).toBe(false)
    expect(b.segments).toEqual([])
    expect(b.used).toBe(10_000)
    expect(b.remaining).toBe(190_000)
  })

  test('上限未知 → remaining 为 null（不编总量）', () => {
    const b = buildContextBreakdown(view(10_000, null)!, { system: 10, memory: 0, messages: 20 })
    expect(b.limit).toBeNull()
    expect(b.remaining).toBeNull()
    // 0 值段（memory 关掉时确实是 0）不占一行。
    expect(b.segments.map((s) => s.key)).toEqual(['system', 'tools', 'messages'])
  })
})

// ── 3. 弹层 ─────────────────────────────────────────────────────────────────

describe('ContextUsageDetails — 点环出明细', () => {
  test('四段 + Total Used（无 ≈）+ 上限已知时的 Remaining / Total Available', async () => {
    listMessages.mockResolvedValue([
      row({ id: 1, content: 'a'.repeat(800), context_tokens: 10_000 })
    ])
    stubFetch({ standingContext: 'a'.repeat(400), memorySummary: 'a'.repeat(200) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    const pop = await openDetails()
    await waitFor(() => expect(screen.queryByTestId('context-segment-system')).not.toBeNull())

    expect(screen.getByTestId('context-segment-system').textContent).toContain('≈100')
    expect(screen.getByTestId('context-segment-memory').textContent).toContain('≈50')
    expect(screen.getByTestId('context-segment-messages').textContent).toContain('≈200')
    // 残差 = 10000 − 350 = 9650 → formatTokens → '10K'
    expect(screen.getByTestId('context-segment-tools').textContent).toContain('≈10K')
    expect(screen.getByTestId('context-usage-bar')).toBeTruthy()

    // 权威值不带 ≈（这是「实报 vs 估算」的唯一视觉判据）。
    expect(screen.getByTestId('context-total-used').textContent).toBe(`${T('totalUsed')}10K`)

    expect(pop.textContent).toContain(T('remaining'))
    expect(pop.textContent).toContain(T('totalAvailable'))
    expect(pop.textContent).toContain('190K')
    expect(pop.textContent).toContain('200K')
    expect(pop.textContent).toContain(T('estimateNote'))
  })

  test('🔴 上限未命中（目录没这个模型）→ 只有各段与已用，没有 Remaining / Total Available', async () => {
    listMessages.mockResolvedValue([row({ id: 1, content: 'a'.repeat(80), context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(400), memorySummary: '' })
    render(
      <Harness value={controls({ availableModels: [model({ contextWindow: null })] })}>
        <ContextUsageRing />
      </Harness>
    )
    const pop = await openDetails()
    await waitFor(() => expect(screen.queryByTestId('context-segment-system')).not.toBeNull())
    expect(pop.textContent).toContain(T('totalUsed'))
    // 🔴 判据取**行**而不是文案子串：08-06 ① 补进来的「上限未知」说明本身含「上限」两字，
    // 拿 `not.toContain(T('totalAvailable'))` 判会把一句解释误判成那一行。
    expect(screen.queryByTestId('context-total-remaining')).toBeNull()
    expect(screen.queryByTestId('context-total-limit')).toBeNull()
    // 08-06 ①：短提示（pillTip）删掉后，「为什么没有剩余/上限」这句话只剩这个面能说。
    expect(screen.getByTestId('context-limit-unknown').textContent).toBe(T('limitUnknown'))
    // memory 为 0（memory.md 空 / flag 关）→ 不占一行。
    expect(screen.queryByTestId('context-segment-memory')).toBeNull()
  })

  test('/chat/config 不可达 → 只出总量 + 「分段明细暂不可用」，绝不拿 0 顶上', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch(null)
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    const pop = await openDetails()
    await waitFor(() => expect(pop.textContent).toContain(T('segmentsUnavailable')))
    expect(screen.queryByTestId('context-usage-bar')).toBeNull()
    expect(screen.queryByTestId('context-segment-tools')).toBeNull()
    expect(pop.textContent).toContain(T('totalUsed'))
  })

  test('弹层几何走类不走内联 style（clearProps:"all" 会清空根的内联样式）+ 右锚 260px + max-w-full', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    const pop = await openDetails()
    expect(pop.className).toContain('right-0')
    expect(pop.className).toContain('bottom-full')
    expect(pop.className).toContain('w-[260px]')
    // 🔴 结构性防越界：包含块比 260 窄时跟着缩（AssistantChatModal 根是 overflow-hidden，
    // 越界 = 直接被裁掉，不是「盖住旁边」）。
    expect(pop.className).toContain('max-w-full')
    expect(pop.className).toContain('glass-pop')
    for (const prop of ['width', 'right', 'bottom', 'position']) {
      expect(pop.style.getPropertyValue(prop)).toBe('')
    }
  })

  // 🔴 **两面各一格**。这条不变式在 agent 面比邮件面更要紧（320px 是侧栏的 SIDEBAR_WIDTH_MIN），
  // 偏偏 agent 面的 `ComposerPrimitive.Root` 自己就是 `relative` —— 把行上的 relative 拿掉，
  // 包含块会**静默**上移到那个 Root 而不是报错，「往上第一个 relative 装着发送钮」这种判据
  // 因此在 agent 面恒真、拦不住任何东西（复核时实测：删掉 agent 行的 relative，全部用例照绿）。
  // 所以判据取**同一性**：往上第一个 relative 必须**就是**工具条那一行本身。
  // 行 = 环包裹层的祖父（两面同构：行 > 组 > 环包裹层 > 弹层）。
  test.each([
    ['邮件面 ThreadComposer', <ThreadComposer key="mail" />],
    ['agent 面 AgentComposer', <AgentComposer key="agent" />]
  ])('🔴 包含块是**工具条整行**而不是环自己（%s）—— 320px 窄面不越界的唯一依据', async (_n, ui) => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    const { container } = render(<Harness>{ui}</Harness>)
    const pop = await openDetails()
    // 环自己的包裹层**不能**是 relative（否则 right-0 锚到环的右缘 → 260px 的面在 320px 里
    // 左缘落到负值被裁）。
    const ringWrap = pop.parentElement as HTMLElement
    expect(ringWrap.className).not.toContain('relative')
    const toolbarRow = ringWrap.parentElement?.parentElement as HTMLElement | null
    expect(toolbarRow).toBeTruthy()
    // 可读性判据：那一行确实是工具条（装着发送钮）。
    expect(toolbarRow!.querySelector('button[aria-label="发送"]')).toBeTruthy()
    // 🔴 真正的闸：最近的 positioned 祖先 **就是**这一行，不是更上层任何 relative。
    expect(toolbarRow!.className).toContain('relative')
    expect(ringWrap.closest('.relative')).toBe(toolbarRow)
    expect(container.contains(toolbarRow!)).toBe(true)
  })

  // 🔴 懒拉的闸。这条不是性能洁癖 —— 同一条工具条上的 `ComposerToolsMenu` 正因为在挂载时
  // 无条件拉 connector 行，composer 每渲染一次就打一发真请求（本轮复核实测：composer_effort
  // 跑一遍打了 4 发到 127.0.0.1:8200）。这个面「多数人不会点开」，配置又是全局的，所以拉取
  // 必须挂在 open 上；没有这一格，把 `if (!open) return` 删掉全部用例照绿。
  test('🔴 /chat/config 只在开弹层时拉 —— 不是每次挂 composer 都拉', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    const fetchMock = stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    await screen.findByTestId('context-usage')
    expect(configCallCount(fetchMock)).toBe(0)
    await openDetails()
    await waitFor(() => expect(configCallCount(fetchMock)).toBe(1))
  })

  test('Escape 关闭；reduced-motion 下直接卸载不留叠层', async () => {
    reduceMatches = true
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    await openDetails()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('context-usage-details')).toBeNull())
    expect(screen.queryAllByTestId('context-usage-details')).toHaveLength(0)
  })

  test('点外面关闭', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    await openDetails()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('context-usage-details')).toBeNull(), {
      timeout: 2000
    })
  })

  test('🔴 超限时弹层里如实说「已超过目录记的上限」（短提示删掉后这句只剩这里能说）', async () => {
    // used 400K > 上限 200K：环钉满，但「上限本身可能不对」这件事必须写出来。
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 400_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    await openDetails()
    expect(screen.getByTestId('context-overflow').textContent).toBe(T('overflowTip'))
    // 上限已知的那一档不该出现「上限未知」的说明。
    expect(screen.queryByTestId('context-limit-unknown')).toBeNull()
  })
})

// ── 3b. 08-06 owner dogfood ①：hover 出明细 + 短提示退役 ─────────────────────────
//
// owner 原话：「Context 环，不需要那个 hover tips，把点击的那个直接改为 hover 效果。」
// 覆盖的契约：
//   1. **hover 就出明细**（新主路径）；
//   2. **短提示 `HoverTip` 整个没了** —— hover 时不再有 `role="tooltip"` 那颗小 chip
//      （留着它 = 同一件事的两个详略版本叠在一起）；
//   3. **点击路径与键盘可达性一字未丢**：点击仍开，且点开的是**钉住**态（移开鼠标不收），
//      `aria-expanded` / `aria-haspopup` 照常。触屏 / 无指针环境因此仍然能用；
//   4. 只 hover（没点）时移开鼠标要收 —— 否则弹层会赖在屏幕上盖住工具条。
describe('08-06 ① hover 出明细', () => {
  async function mount(): Promise<HTMLElement> {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    return await screen.findByTestId('context-usage')
  }
  /** 包裹层（hover 判据挂在它上面：弹层是它的 DOM 子节点，指针进面里不算离开）。 */
  const wrapOf = (trigger: HTMLElement): HTMLElement => trigger.parentElement as HTMLElement

  test('hover 环 → 直接出四段明细（不用点）', async () => {
    const trigger = await mount()
    fireEvent.mouseEnter(wrapOf(trigger))
    const pop = await screen.findByTestId('context-usage-details')
    expect(pop.textContent).toContain(T('detailsTitle'))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  test('🔴 短提示已删：hover 不再冒出 role="tooltip" 的小 chip', async () => {
    const trigger = await mount()
    fireEvent.mouseEnter(wrapOf(trigger))
    await screen.findByTestId('context-usage-details')
    expect(screen.queryByRole('tooltip')).toBeNull()
    // 触发器本身也不再被 HoverTip 的 span 包着（那层就是短提示的宿主）。
    expect(wrapOf(trigger).getAttribute('data-testid')).toBeNull()
    expect(wrapOf(trigger).tagName).toBe('DIV')
  })

  test('只 hover（没点）→ 移开鼠标收起', async () => {
    const trigger = await mount()
    fireEvent.mouseEnter(wrapOf(trigger))
    await screen.findByTestId('context-usage-details')
    fireEvent.mouseLeave(wrapOf(trigger))
    await waitFor(() => expect(screen.queryByTestId('context-usage-details')).toBeNull())
  })

  test('🔴 点击 = 钉住：移开鼠标不收，再点一次才关（触屏 / 键盘 Enter 走的就是这条）', async () => {
    const trigger = await mount()
    fireEvent.click(trigger)
    await screen.findByTestId('context-usage-details')
    fireEvent.mouseLeave(wrapOf(trigger))
    // 给 hover 收起的宽限期足够长的时间证明它确实没被排程。
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.queryByTestId('context-usage-details')).not.toBeNull()
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.queryByTestId('context-usage-details')).toBeNull())
  })

  test('可及性属性一字未丢（hover 是新增入口，不是替换）', async () => {
    const trigger = await mount()
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect((trigger as HTMLButtonElement).type).toBe('button')
  })
})

// ── 4. 两个 composer 面 ─────────────────────────────────────────────────────

describe('两面挂载 —— 同一个组件，两个 composer 都能开', () => {
  test('邮件面 ThreadComposer：点环出明细，且不会误触发送（type="button"）', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    const { container } = render(
      <Harness>
        <ThreadComposer />
      </Harness>
    )
    const trigger = await screen.findByTestId('context-usage')
    // composer 根是 <form>：不写 type="button" 的按钮默认 submit → 点明细把消息发出去。
    expect((trigger as HTMLButtonElement).type).toBe('button')
    expect(container.querySelector('form')).toBeTruthy()
    fireEvent.click(trigger)
    expect(await screen.findByTestId('context-usage-details')).toBeTruthy()
  })

  test('agent 面 AgentComposer：同一个组件同样能开', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 9_000 })])
    stubFetch({ standingContext: 'a'.repeat(40) })
    render(
      <Harness>
        <AgentComposer />
      </Harness>
    )
    fireEvent.click(await screen.findByTestId('context-usage'))
    expect(await screen.findByTestId('context-usage-details')).toBeTruthy()
  })
})
