// @vitest-environment happy-dom
//
// WP-16b effort 接线 —— 面板侧状态（useComposerEffort）+ composer 菜单（EffortPicker）+
// **请求体到底带不带 `effort` 键**（16a 的硬契约，本文件最后一组是它的 wire 闸）。
//
// 覆盖的契约（每条都是「改错了用户会中招」的那种）：
//   1. 🔴 **applicable === false ⇒ 请求体不带 `effort` 键**（连 'none' 也不塞）。16a 的字段注释
//      写了两条实证依据：deepseek 协议的 'none' 会往 wire 发 `thinking:{type:'disabled'}`；
//      openai 协议的 'none' 会让 SDK 推 `reasoning_effort`（chat 分支直接下发）。判据只能由
//      调用方守，所以这条必须有 wire 级测试。
//   2. **S2 拍板**：pref 为空 ⇒ 主动下发家族 defaultTier（Claude 从「默认不思考」翻成
//      「默认 medium」是有意的行为反转）。
//   3. **切模型档位子集跟着变**：manual 族 Claude 有「不思考」、adaptive 族（opus-5/fable）没有
//      （那类模型不带 thinking 参数也会自发思考，给 none 是撒谎）。
//   4. **pref 跨模型的收敛**：全局 pref 落到新模型没有的档时向下取最近可选档（不是跳回默认）。
//   5. **不撒谎**：passthroughUnknown 时菜单里有一句 hedge；模型没有 reasoning 能力时触发器灰掉。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { EffortPicker } from '@shared/assistant/components/EffortPicker'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { resolveEffortTier, useComposerEffort } from '@shared/hooks/useComposerEffort'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import { EFFORT_PREF_KEY } from '@shared/modelCatalog/effort'

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { listSkills: vi.fn(async () => []) } })
}))

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
})

// 🔴 本仓的 happy-dom 环境**没有** localStorage（`typeof localStorage === 'undefined'`，实测）——
// 16a 的 read/writeEffortPref 因此在测试里恒静默失败（它们各自包了 try/catch）。要验「选档落盘」
// 就得自己塞一个内存实现（auto-title-settings.test.ts 同款手法）。
const memory: Record<string, string> = {}
const fakeLocalStorage = {
  getItem: (k: string) => memory[k] ?? null,
  setItem: (k: string, v: string) => {
    memory[k] = String(v)
  },
  removeItem: (k: string) => {
    delete memory[k]
  },
  clear: () => {
    for (const k of Object.keys(memory)) delete memory[k]
  }
}

beforeEach(() => {
  fakeLocalStorage.clear()
  vi.stubGlobal('localStorage', fakeLocalStorage)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function option(over: Partial<ComposerModelOption> & { ref: string }): ComposerModelOption {
  const modelId = over.ref.includes(':') ? over.ref.slice(over.ref.indexOf(':') + 1) : over.ref
  return {
    ref: over.ref,
    providerId: over.providerId ?? 'anthropic',
    providerLabel: over.providerLabel ?? 'Anthropic',
    protocol: over.protocol ?? 'anthropic',
    modelId: over.modelId ?? modelId,
    displayName: over.displayName ?? modelId,
    capabilities: over.capabilities ?? null,
    maxOutput: over.maxOutput ?? null,
    contextWindow: over.contextWindow ?? null,
    catalogMeta: over.catalogMeta ?? null
  }
}

const SONNET = option({ ref: 'anthropic:claude-sonnet-4-6' }) // manual 族：none/low/medium/high
const OPUS5 = option({ ref: 'anthropic:claude-opus-5' }) // adaptive 族：low..max（无 none）
const GEMINI = option({
  ref: 'google:gemini-2.5-pro',
  providerId: 'google',
  providerLabel: 'Google',
  protocol: 'google'
}) // low/medium/high，默认 low

const T = (tier: string): string => i18n.t(`chat.effort.tier.${tier}`)

// ── 1. pref 收敛（纯函数）────────────────────────────────────────────────────────

describe('resolveEffortTier — 全局 pref 收进当前模型的可选档', () => {
  const OPTS = ['low', 'medium', 'high'] as const

  test('pref 为空 → 家族默认档（S2：这一档要主动下发，不是不发）', () => {
    expect(resolveEffortTier(null, OPTS, 'low')).toBe('low')
  })

  test('pref 可选 → 原样', () => {
    expect(resolveEffortTier('medium', OPTS, 'low')).toBe('medium')
  })

  test('pref 高于所有可选档 → 向下取最近可选（max→high，不是跳回默认 low）', () => {
    expect(resolveEffortTier('max', OPTS, 'low')).toBe('high')
    expect(resolveEffortTier('xhigh', OPTS, 'low')).toBe('high')
  })

  test('pref 低于所有可选档（adaptive 族上带着 none）→ 取最低的一档', () => {
    expect(resolveEffortTier('none', OPTS, 'medium')).toBe('low')
  })
})

// ── 2. 面板侧状态 ───────────────────────────────────────────────────────────────

describe('useComposerEffort — 请求体值与档位集', () => {
  test('pref 空 → bodyTier = 家族默认档（sonnet=medium / gemini=low）', () => {
    const a = renderHook(() =>
      useComposerEffort({ model: SONNET.ref, availableModels: [SONNET, GEMINI] })
    )
    expect(a.result.current.bodyTier).toBe('medium')
    expect(a.result.current.control.options).toEqual(['none', 'low', 'medium', 'high'])

    const b = renderHook(() =>
      useComposerEffort({ model: GEMINI.ref, availableModels: [SONNET, GEMINI] })
    )
    expect(b.result.current.bodyTier).toBe('low')
    expect(b.result.current.control.options).toEqual(['low', 'medium', 'high'])
  })

  test('选档 → 写全局 pref，bodyTier 跟着走', () => {
    const { result } = renderHook(() =>
      useComposerEffort({ model: SONNET.ref, availableModels: [SONNET] })
    )
    act(() => result.current.control.onSelect('high'))
    expect(localStorage.getItem(EFFORT_PREF_KEY)).toBe('high')
    expect(result.current.bodyTier).toBe('high')
    expect(result.current.control.selected).toBe('high')
  })

  test('🔴 模型无 reasoning 能力 → applicable=false 且 bodyTier=undefined（请求体不带 effort 键）', () => {
    const dumb = option({
      ref: 'openai:gpt-4o',
      providerId: 'openai',
      protocol: 'openai',
      capabilities: { reasoning: false, tools: true }
    })
    const { result } = renderHook(() =>
      useComposerEffort({ model: dumb.ref, availableModels: [dumb] })
    )
    expect(result.current.control.applicable).toBe(false)
    expect(result.current.bodyTier).toBeUndefined()
  })

  test('🔴 model=null（只读 legacy 会话）→ 同样不带 effort 键（连模型是谁都不知道，不猜）', () => {
    const { result } = renderHook(() => useComposerEffort({ model: null, availableModels: [] }))
    expect(result.current.control.applicable).toBe(false)
    expect(result.current.bodyTier).toBeUndefined()
  })

  test('capabilities 全未标注（unknown ≠ false）→ 仍适用（16a 三态口径）', () => {
    const relay = option({
      ref: 'relay:mystery-relay-model-z9',
      providerId: 'relay',
      protocol: 'openai-compatible'
    })
    const { result } = renderHook(() =>
      useComposerEffort({ model: relay.ref, availableModels: [relay] })
    )
    expect(result.current.control.applicable).toBe(true)
    expect(result.current.control.passthroughUnknown).toBe(true)
  })
})

// ── 3. 菜单 ────────────────────────────────────────────────────────────────────

function PickerHarness({
  model,
  models
}: {
  model: string | null
  models: ComposerModelOption[]
}): React.JSX.Element {
  const effort = useComposerEffort({ model, availableModels: models })
  return <EffortPicker control={effort.control} variant="icon" />
}

describe('EffortPicker — 档位随模型', () => {
  test('manual 族 Claude 有「不思考」，adaptive 族（opus-5）没有', () => {
    const { unmount } = render(<PickerHarness model={SONNET.ref} models={[SONNET]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    expect(screen.getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual([
      expect.stringContaining(T('none')),
      expect.stringContaining(T('low')),
      expect.stringContaining(T('medium')),
      expect.stringContaining(T('high'))
    ])
    unmount()

    render(<PickerHarness model={OPUS5.ref} models={[OPUS5]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    const labels = screen.getAllByRole('menuitemradio').map((b) => b.textContent ?? '')
    expect(labels.some((l) => l.includes(T('none')))).toBe(false)
    expect(labels).toHaveLength(5) // low / medium / high / xhigh / max
  })

  test('🔴 切模型 → 档位子集当场跟随（同一个挂载里 rerender，不是换组件）', () => {
    const { rerender } = render(<PickerHarness model={SONNET.ref} models={[SONNET, GEMINI]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4) // none/low/medium/high
    fireEvent.keyDown(document, { key: 'Escape' })

    rerender(<PickerHarness model={GEMINI.ref} models={[SONNET, GEMINI]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    const labels = screen.getAllByRole('menuitemradio').map((b) => b.textContent ?? '')
    expect(labels).toHaveLength(3) // low/medium/high
    expect(labels.some((l) => l.includes(T('none')))).toBe(false)
  })

  test('默认档标注「默认」，且选中的是它（pref 空）', () => {
    render(<PickerHarness model={GEMINI.ref} models={[GEMINI]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    const checked = screen
      .getAllByRole('menuitemradio')
      .filter((b) => b.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].textContent).toContain(T('low'))
    expect(checked[0].textContent).toContain(i18n.t('chat.effort.default'))
  })

  test('选一档 → 菜单收起、选中态转移、pref 落盘', async () => {
    render(<PickerHarness model={SONNET.ref} models={[SONNET]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(T('high')) }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(localStorage.getItem(EFFORT_PREF_KEY)).toBe('high')
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    const checked = screen
      .getAllByRole('menuitemradio')
      .filter((b) => b.getAttribute('aria-checked') === 'true')
    expect(checked[0].textContent).toContain(T('high'))
  })

  test('🔴 模型没有 reasoning 能力 → 触发器灰掉（disabled + 「不支持」tooltip），点不开', () => {
    const dumb = option({
      ref: 'openai:gpt-4o',
      providerId: 'openai',
      protocol: 'openai',
      capabilities: { reasoning: false }
    })
    render(<PickerHarness model={dumb.ref} models={[dumb]} />)
    const trigger = screen.getByLabelText(i18n.t('chat.effort.label')) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('passthroughUnknown → 菜单底部有 hedge（不声称档位一定生效）', () => {
    const relayClaude = option({
      ref: 'crs:claude-opus-5[1m]',
      providerId: 'crs',
      providerLabel: 'CRS',
      protocol: 'openai-compatible'
    })
    render(<PickerHarness model={relayClaude.ref} models={[relayClaude]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    expect(screen.getByText(i18n.t('chat.effort.hedge'))).toBeTruthy()
  })

  test('同族直通（sonnet @ anthropic）→ 不摆 hedge', () => {
    render(<PickerHarness model={SONNET.ref} models={[SONNET]} />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.effort.label')))
    expect(screen.queryByText(i18n.t('chat.effort.hedge'))).toBeNull()
  })
})

// ── 4. wire 闸：请求体到底带不带 effort ─────────────────────────────────────────

function stubChatFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/ai/chat')) {
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function controls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
  return {
    model: SONNET.ref,
    availableModels: [SONNET],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    ...over
  }
}

/** 真的通过 composer 发一条，返回 /api/ai/chat 的请求体。 */
async function sendAndReadBody(
  fetchMock: ReturnType<typeof vi.fn>,
  container: HTMLElement
): Promise<Record<string, unknown>> {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
  fireEvent.submit(container.querySelector('form')!)
  await waitFor(() =>
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/ai/chat'))).toBe(true)
  )
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/ai/chat'))!
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>
}

function WireHarness({ effort }: { effort?: string }): React.JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        gatewayBaseUrl="http://127.0.0.1:8300"
        sessionId={7}
        effort={effort as never}
      >
        <ChatComposerControlsProvider value={controls()}>
          <ThreadComposer />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

describe('Brain 布尔开关零残留', () => {
  test('工具条上再没有「思考模式」那颗钮（组件层判据；i18n 的 toggleOn/Off/unsupported 也已删）', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
          <ChatComposerControlsProvider value={controls()}>
            <ThreadComposer />
          </ChatComposerControlsProvider>
        </AiSdkRuntimeProvider>
      </QueryClientProvider>
    )
    // 旧 Brain 钮的 aria-label 是 `chat.thinking.label`（该 key 本身仍在用 —— 消息流里的
    // 「思考过程」折叠块），所以判据取「composer 里有没有这么一颗按钮」。
    expect(screen.queryByLabelText(i18n.t('chat.thinking.label'))).toBeNull()
  })
})

// 🔴 右组控件序（owner 08-05 第三轮拍板：环 · effort · 模型 · 发送）。左组三颗与「模型贴着
// 发送钮」分别由 composer_plus_menu / model_picker 的红线闸钉住，但那两处的 stub 都**不供给**
// controls.effort，于是 effort 插在哪一位没有任何闸 —— 插到模型后面会同时打破 ModelPicker
// right-0 弹层的算式前提（它按「倒数第二」算左缘）。这里补上那一格。
describe('composer 右组控件序 — effort 在模型之前', () => {
  test('真 ThreadComposer 里右组 = [effort][模型][发送]', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const stub: ChatComposerControls = controls({
      effort: {
        options: ['low', 'medium', 'high'],
        applicable: true,
        passthroughUnknown: false,
        defaultTier: 'medium',
        selected: 'medium',
        onSelect: vi.fn()
      }
    })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
          <ChatComposerControlsProvider value={stub}>
            <ThreadComposer />
          </ChatComposerControlsProvider>
        </AiSdkRuntimeProvider>
      </QueryClientProvider>
    )
    const group = container.querySelector('div.ml-auto')
    expect(group).toBeTruthy()
    const buttons = Array.from(group!.querySelectorAll('button'))
    // send/cancel 同一时刻只渲染一个 → [effort, 模型, 发送]。
    expect(buttons).toHaveLength(3)
    expect(buttons.indexOf(screen.getByLabelText(i18n.t('chat.effort.label')))).toBe(0)
    expect(buttons.indexOf(screen.getByLabelText(i18n.t('chat.composer.model')))).toBe(1)
  })
})

describe('请求体 wire —— effort 键', () => {
  test('传了档位 → body.effort = 该档（gateway 走 effortCallOptions 新路径）', async () => {
    const fetchMock = stubChatFetch()
    const { container } = render(<WireHarness effort="high" />)
    const body = await sendAndReadBody(fetchMock, container)
    expect(body.effort).toBe('high')
    // 🔴 Brain 布尔已下线：没有任何 UI 会再发它（gateway 的 legacy 分支只服务 island resume
    // 回放的冻结 originalBody）。
    expect(body.thinking).toBeUndefined()
  })

  test('🔴 没传（applicable=false 的模型 / 只读线程）→ 请求体**根本没有** effort 这个键', async () => {
    const fetchMock = stubChatFetch()
    const { container } = render(<WireHarness />)
    const body = await sendAndReadBody(fetchMock, container)
    expect('effort' in body).toBe(false)
  })
})
