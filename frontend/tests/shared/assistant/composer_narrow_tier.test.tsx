// @vitest-environment happy-dom
//
// 侧栏拖窄时 AgentComposer 工具条的逐级降级：composer 根 <form> 的宽度 → 工具条那行的
// `data-narrow` 档位（各 picker 用 `group-data-[narrow=…]/composer:` 自己读档）。
//
// 这里钉的是**档位映射与写属性的接线**，不是像素：happy-dom 不排版，宽度靠替身给。真实渲染
// 的越界判据（发送按钮右缘 ≤ 输入框右缘）在任务的 dev 预览实测里，不是本文件能覆盖的。
//
// 宽度取值用侧栏四档的实测 form 宽（侧栏宽 − 32px 的 Viewport px-4 − 1px 的 border-l）：
//   侧栏 350 → 317 · 360 → 327 · 400 → 367 · 720 → 687。

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

// ─── ResizeObserver 替身（happy-dom 不实现）───────────────────────────────────────────────
// 手动驱动：宽度改完 fire 一次，模拟浏览器把 resize 派给观察者。
type FakeRO = { fire: () => void }
const observers: FakeRO[] = []

class StubResizeObserver {
  private readonly self: FakeRO
  constructor(cb: () => void) {
    this.self = { fire: cb }
    observers.push(this.self)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    const i = observers.indexOf(this.self)
    if (i !== -1) observers.splice(i, 1)
  }
}

// 宽度替身装在 HTMLFormElement 原型上，不是某个 form 实例上：happy-dom 里
// `toolbar.closest('form')`（hook 拿 host 的方式）返回的引用与 `container.querySelector('form')`
// 不是同一个对象，装实例上喂不到 hook。原型级同时覆盖两者，且本文件只渲染这一个 composer。
let formWidth = 0
const realFormRect = HTMLFormElement.prototype.getBoundingClientRect

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
  HTMLFormElement.prototype.getBoundingClientRect = (): DOMRect =>
    ({ width: formWidth, height: 0 }) as DOMRect
})

afterAll(() => {
  HTMLFormElement.prototype.getBoundingClientRect = realFormRect
})

afterEach(() => {
  cleanup()
  observers.length = 0
  formWidth = 0
  vi.unstubAllGlobals()
  capturedAui = null
})

function stubControls(): ChatComposerControls {
  return {
    model: 'claude-sonnet-4-6',
    // 非空才渲染模型 chip（ModelPicker 在无可选模型时整枚不渲染）。
    availableModels: [
      {
        ref: 'claude-sonnet-4-6',
        providerId: 'default',
        providerLabel: null,
        protocol: null,
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        capabilities: null,
        maxOutput: null,
        contextWindow: null,
        catalogMeta: null
      }
    ],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    agentMentions: [],
    onAddAgentMention: vi.fn(),
    onRemoveAgentMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn()
  }
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

/** 工具条那一行 = 带 `group/composer` 的盒子（`data-narrow` 的唯一载体）。 */
function toolbarOf(container: HTMLElement): HTMLElement {
  const el = Array.from(container.querySelectorAll('div')).find((d) =>
    (d.getAttribute('class') ?? '').split(/\s+/).includes('group/composer')
  )
  expect(el, '找不到工具条那一行（group/composer）').toBeTruthy()
  return el!
}

async function mount(): Promise<{
  form: HTMLFormElement
  toolbar: HTMLElement
  setFormWidth: (w: number) => void
}> {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={stubControls()}>
          <AuiProbe />
          <AgentComposer />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true))
  const form = container.querySelector('form')
  expect(form, '找不到 composer 根 form').toBeTruthy()
  const toolbar = toolbarOf(container)
  // happy-dom 的 getBoundingClientRect 恒 0 —— 宽度由 formWidth 喂，改完驱动一次观察者。
  const setFormWidth = (w: number): void => {
    formWidth = w
    act(() => {
      for (const o of observers) o.fire()
    })
  }
  return { form: form as HTMLFormElement, toolbar, setFormWidth }
}

describe('AgentComposer 工具条窄档（data-narrow）', () => {
  test('四档侧栏宽度 → 档位：720/400 各自一档，360 与 350 同为最窄档', async () => {
    const { toolbar, setFormWidth } = await mount()

    setFormWidth(687) // 侧栏 720（SIDEBAR_WIDTH_MAX）
    expect(toolbar.getAttribute('data-narrow')).toBeNull()

    setFormWidth(367) // 侧栏 400（默认宽）
    expect(toolbar.getAttribute('data-narrow')).toBe('md')

    setFormWidth(327) // 侧栏 360
    expect(toolbar.getAttribute('data-narrow')).toBe('sm')

    setFormWidth(317) // 侧栏 350（SIDEBAR_WIDTH_MIN）
    expect(toolbar.getAttribute('data-narrow')).toBe('sm')
  })

  test('阈值两侧各一格：367/368 分档，327/328 分档', async () => {
    const { toolbar, setFormWidth } = await mount()

    setFormWidth(368)
    expect(toolbar.getAttribute('data-narrow')).toBeNull()
    setFormWidth(367)
    expect(toolbar.getAttribute('data-narrow')).toBe('md')
    setFormWidth(328)
    expect(toolbar.getAttribute('data-narrow')).toBe('md')
    setFormWidth(327)
    expect(toolbar.getAttribute('data-narrow')).toBe('sm')
  })

  test('降档可逆：窄回宽恢复无档（拖宽不留残档）', async () => {
    const { toolbar, setFormWidth } = await mount()
    setFormWidth(287)
    expect(toolbar.getAttribute('data-narrow')).toBe('sm')
    setFormWidth(687)
    expect(toolbar.getAttribute('data-narrow')).toBeNull()
  })

  test('档位真的接到降级样式：授权档文字挂两档 hidden、模型名挂最窄档 max-w', async () => {
    const { form } = await mount()
    const approval = form.querySelector(`[aria-label="${i18n.t('chat.approvalMode.label')}"]`)
    const model = form.querySelector(`[aria-label="${i18n.t('chat.composer.model')}"]`)
    expect(approval, '找不到授权档 chip').toBeTruthy()
    expect(model, '找不到模型 chip').toBeTruthy()
    const truncated = (el: Element | null): string =>
      Array.from(el?.querySelectorAll('span') ?? [])
        .map((s) => s.getAttribute('class') ?? '')
        .find((c) => c.includes('truncate')) ?? ''

    const approvalText = truncated(approval)
    expect(approvalText).toContain('group-data-[narrow=md]/composer:hidden')
    expect(approvalText).toContain('group-data-[narrow=sm]/composer:hidden')
    expect(truncated(model)).toContain('group-data-[narrow=sm]/composer:max-w-[72px]')
  })
})
