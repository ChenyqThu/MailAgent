// @vitest-environment happy-dom
//
// WP-15「context 环」（task 08-05）—— composer 右下 Send 旁的上下文占用指示器。
//
// 覆盖的契约（每条都是「改错了会让用户看到假数字」的那种）：
//   1. **上限命中 → 画比例环**；上限未命中 → 退化成中性 token 药丸（`~91K`），**不画环**。
//      画一个用猜来的上限撑起来的环，比什么都不显示更糟：它会诱导用户误判还能塞多少。
//   2. **没有占用就整个不渲染** —— 老会话（pre-v23 行 context_tokens 全 NULL）/ 首轮未完成，
//      控件消失，长得和引入本功能之前逐字一样。绝不写 0、绝不写 '?'。
//   3. **末条不是 assistant / 末条是审批暂停行（占用为 NULL）时，显示上一轮的值**，而不是闪一下
//      消失（暂停那一段早退不落库，resume 才补写）。
//   4. **落库广播驱动刷新**（`chat:turn-persisted`，回合间刷新 = 零 wire 改动的那条路径）。
//   5. **挂载点真的在 composer 里、且在 Send 之前** —— 组件写好了但没人挂 = 功能不存在。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import type { ChatMessage } from '@shared/api/types'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'

const { listMessages, onTurnPersisted, turnPersistedHandlers } = vi.hoisted(() => ({
  listMessages: vi.fn(),
  onTurnPersisted: vi.fn(),
  turnPersistedHandlers: [] as Array<(p: { sessionId: number }) => void>
}))
// 🔴 必须返回**同一个**对象引用：生产的 `makeMailApi()` 是模块级单例（api/factory.ts），
// 每次调用新建一个字面量会让所有以 mailApi 为依赖的 useCallback/useEffect 每帧失效 ——
// 那是测试自己造出来的 bug，不是被测代码的。
const stableMailApi = {
  chat: { listMessages, onTurnPersisted },
  // ThreadComposer 里的 MentionPopover 也读 mailApi（其 query enabled=false，只是不能少这个键）。
  email: { search: vi.fn().mockResolvedValue([]) }
}
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { ContextUsageRing } from '@shared/assistant/components/ContextUsageRing'
import { ThreadComposer } from '@shared/assistant/components/composer'
import {
  buildContextUsageView,
  latestContextTokens
} from '@shared/assistant/components/contextUsage.lib'

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  turnPersistedHandlers.length = 0
})

onTurnPersisted.mockImplementation((h: (p: { sessionId: number }) => void) => {
  turnPersistedHandlers.push(h)
  return () => {
    const i = turnPersistedHandlers.indexOf(h)
    if (i >= 0) turnPersistedHandlers.splice(i, 1)
  }
})

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
    thinkingSupported: true,
    thinkingEnabled: false,
    onToggleThinking: vi.fn(),
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
    content: 'ok',
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

// ── 纯函数面 ────────────────────────────────────────────────────────────────

describe('contextUsage.lib', () => {
  test('latestContextTokens 从尾往前找最后一条带占用的 assistant 行', () => {
    expect(
      latestContextTokens([
        row({ id: 1, context_tokens: 1000 }),
        row({ id: 2, context_tokens: 2000 })
      ])
    ).toBe(2000)
  })

  test('末条是 user（回复还没落库）/ 是暂停的 assistant（占用 NULL）→ 仍报上一轮的值', () => {
    expect(
      latestContextTokens([
        row({ id: 1, context_tokens: 2000 }),
        row({ id: 2, role: 'user', content: '再问一句' })
      ])
    ).toBe(2000)
    expect(
      latestContextTokens([
        row({ id: 1, context_tokens: 2000 }),
        row({ id: 2, context_tokens: null }) // 审批暂停行：resume 时才补写
      ])
    ).toBe(2000)
  })

  test('全是老行（列缺席 / NULL）→ null；空数组 / 非数组 → null', () => {
    expect(latestContextTokens([row({ id: 1 }), row({ id: 2 })])).toBeNull()
    expect(latestContextTokens([{ role: 'assistant' }])).toBeNull() // 未迁移库：整字段缺席
    expect(latestContextTokens([])).toBeNull()
    expect(latestContextTokens(undefined)).toBeNull()
  })

  test('buildContextUsageView：used 未知 → null（整个控件不渲染）', () => {
    expect(buildContextUsageView(null, 200_000)).toBeNull()
    expect(buildContextUsageView(undefined, 200_000)).toBeNull()
  })

  test('buildContextUsageView：上限未知/非正数 → pill 档（绝不拿 0 当分母画满环）', () => {
    for (const limit of [null, undefined, 0, -1, Number.NaN]) {
      const v = buildContextUsageView(91_000, limit)
      expect(v?.variant).toBe('pill')
      expect(v?.ratio).toBeNull()
      expect(v?.percent).toBeNull()
    }
  })

  test('buildContextUsageView：比例、色阶与超限钳位', () => {
    expect(buildContextUsageView(50_000, 200_000)).toMatchObject({
      variant: 'ring',
      percent: 25,
      tone: 'normal',
      overflow: false
    })
    expect(buildContextUsageView(160_000, 200_000)).toMatchObject({ percent: 80, tone: 'warn' })
    expect(buildContextUsageView(190_000, 200_000)).toMatchObject({ percent: 95, tone: 'danger' })
    // 超限：环钉满（ratio=1）但百分比**如实**报 >100，且标 overflow。
    const over = buildContextUsageView(400_000, 200_000)
    expect(over).toMatchObject({ ratio: 1, percent: 200, overflow: true, tone: 'danger' })
  })

  test('P4 阈值注入：0.799 不提醒、0.80 提醒；默认参数仍保持旧 0.75 行为且没有 0.85 档', () => {
    expect(
      buildContextUsageView(799, 1_000, { warnRatio: 0.8, dangerRatio: 0.9 })?.tone
    ).toBe('normal')
    expect(
      buildContextUsageView(800, 1_000, { warnRatio: 0.8, dangerRatio: 0.9 })?.tone
    ).toBe('warn')
    expect(
      buildContextUsageView(850, 1_000, { warnRatio: 0.8, dangerRatio: 0.9 })?.tone
    ).toBe('warn')
    expect(buildContextUsageView(750, 1_000)?.tone).toBe('warn')
  })
})

// ── 组件 ────────────────────────────────────────────────────────────────────

describe('ContextUsageRing', () => {
  test('P4 flag 注入后 80% 明确提示接近上限；flag off 保持旧阈值且无新文案', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 160_000 })])
    const { rerender } = render(
      <Harness value={controls({ compactEnabled: true, autoCompactEnabled: false })}>
        <ContextUsageRing />
      </Harness>
    )
    fireEvent.click(await screen.findByTestId('context-usage'))
    const warning = '已接近模型上下文上限；达到 90% 时会在当前回复结束后自动压缩。'
    expect(screen.queryByText(warning)).toBeNull()

    rerender(
      <Harness value={controls({ compactEnabled: true, autoCompactEnabled: true })}>
        <ContextUsageRing />
      </Harness>
    )
    expect(await screen.findByText(warning)).toBeTruthy()
  })

  test('上限命中 → 比例环 + 短文案', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    const el = await screen.findByTestId('context-usage')
    expect(el.getAttribute('data-variant')).toBe('ring')
    expect(el.textContent).toContain('91K')
    expect(el.querySelector('svg')).toBeTruthy()
  })

  test('上限未命中（目录没这个模型）→ 中性药丸，不画环', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    render(
      <Harness value={controls({ availableModels: [model({ contextWindow: null })] })}>
        <ContextUsageRing />
      </Harness>
    )
    const el = await screen.findByTestId('context-usage')
    expect(el.getAttribute('data-variant')).toBe('pill')
    expect(el.querySelector('svg')).toBeNull()
    expect(el.textContent).toContain('~')
    expect(el.textContent).toContain('91K')
  })

  test('老会话（占用全 NULL）→ 什么都不渲染', async () => {
    listMessages.mockResolvedValue([row({ id: 1 }), row({ id: 2 })])
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    await waitFor(() => expect(listMessages).toHaveBeenCalled())
    expect(screen.queryByTestId('context-usage')).toBeNull()
  })

  test('还没有会话（sessionId=null）→ 不渲染，也不去读库', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    render(
      <Harness value={controls({ sessionId: null })}>
        <ContextUsageRing />
      </Harness>
    )
    await waitFor(() => expect(screen.queryByTestId('context-usage')).toBeNull())
    expect(listMessages).not.toHaveBeenCalled()
  })

  test('落库广播（chat:turn-persisted）驱动回合间刷新；别的会话的广播不打扰', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    expect((await screen.findByTestId('context-usage')).textContent).toContain('91K')

    listMessages.mockResolvedValue([
      row({ id: 1, context_tokens: 91_000 }),
      row({ id: 2, context_tokens: 120_000 })
    ])
    const callsBefore = listMessages.mock.calls.length
    turnPersistedHandlers.forEach((h) => h({ sessionId: 99 })) // 别的会话
    await new Promise((r) => setTimeout(r, 0))
    expect(listMessages.mock.calls.length).toBe(callsBefore)

    turnPersistedHandlers.forEach((h) => h({ sessionId: 7 })) // 本会话
    await waitFor(() => expect(screen.getByTestId('context-usage').textContent).toContain('120K'))
  })

  test('卸载时用返回的 disposer 退订 IPC（fe0437e：跨 contextBridge removeListener 匹配不到 → 泄漏 + StrictMode 双订阅）', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    const { unmount } = render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    await screen.findByTestId('context-usage')
    expect(turnPersistedHandlers.length).toBeGreaterThan(0)
    unmount()
    // effect cleanup 必须调用 onTurnPersisted 返回的 unsubscribe（本 mock 的 disposer 会把 handler
    // 从数组里摘掉）。effect 里写成 `mailApi.chat.onTurnPersisted?.(...)` 而不 return 它 → 这里非空。
    expect(turnPersistedHandlers.length).toBe(0)
    // 已卸载的组件不再被广播唤起（否则就是往一个死组件上 setState + 白发请求）。
    const callsBefore = listMessages.mock.calls.length
    turnPersistedHandlers.forEach((h) => h({ sessionId: 7 }))
    await new Promise((r) => setTimeout(r, 0))
    expect(listMessages.mock.calls.length).toBe(callsBefore)
  })

  // ── 08-06 owner dogfood ①（第二件）：垂直对齐 bug 的回归闸 ────────────────────────
  //
  // owner 实机看到的是「环和旁边的 effort / 模型 / 发送不在同一水平线上」。实测（Chromium +
  // 本仓编译后的真实 CSS）：**环心比 effort/发送心高 2.00px**。
  //
  // 根因（不是 margin，也不是 line-height 调错）：包裹层是**块级盒**，它唯一的孩子是 inline 级的
  // （`inline-flex` 的按钮），于是包裹层要开一个行盒、孩子按**基线**对齐。inline-flex 的基线取自
  // 它第一个 flex item —— 那颗 16px 的 svg，合成基线 = svg 下边缘，只比按钮下边缘高 2px(py-0.5)；
  // 而包裹层的 strut（继承 16px 字号 + `line-height: normal`）要求基线以下留 ~4px 降部。多出来的
  // ~4px 全落在按钮**下方** → 包裹层 24px / 按钮 20px，行 `items-center` 居中的是包裹层。
  // 同排的 effort（28px 方盒里居中 13px 图标，合成基线离下边缘 7.5px > strut 降部）不中招。
  //
  // 修法 = 让包裹层自己成为 flex 容器（`flex items-center`）→ 孩子变 flex item，行盒与 strut
  // 双双消失，包裹层高度 = 按钮高度。改后实测差值 0.00px。
  //
  // 🔴 判据只能取**类**：happy-dom 不排版（getBoundingClientRect 恒 0，且测试环境不加载
  // Tailwind CSS），量不出 2px。几何证据由 Playwright + 编译后 CSS 的离线量测提供（见上面的
  // 数字）；这一格守的是「那两个类还在不在」—— 把 `flex items-center` 删掉，bug 当场复发。
  test('🔴 环的包裹层是 flex 容器（对齐 bug 的修法本体：块级盒会引入 strut 降部把按钮顶高 2px）', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    render(
      <Harness>
        <ContextUsageRing />
      </Harness>
    )
    const trigger = await screen.findByTestId('context-usage')
    const wrap = trigger.parentElement as HTMLElement
    expect(wrap.className).toContain('flex')
    expect(wrap.className).toContain('items-center')
    // 🔴 且触发器必须是包裹层的**直接**孩子：中间再插一层 inline 级包装（比如把 HoverTip 加
    // 回来）会把行盒重新引进来，`flex items-center` 就管不到按钮了。
    expect(trigger.parentElement).toBe(wrap)
    expect(wrap.className).not.toContain('relative') // 弹层的包含块仍是工具条整行
  })

  test('挂载点：真的长在 composer 里，且排在 Send 之前', async () => {
    listMessages.mockResolvedValue([row({ id: 1, context_tokens: 91_000 })])
    const { container } = render(
      <Harness>
        <ThreadComposer />
      </Harness>
    )
    const el = await screen.findByTestId('context-usage')
    const send = container.querySelector('button[aria-label="发送"]')
    expect(send).toBeTruthy()
    // compareDocumentPosition: FOLLOWING(4) = send 在指示器之后。
    expect(el.compareDocumentPosition(send as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
