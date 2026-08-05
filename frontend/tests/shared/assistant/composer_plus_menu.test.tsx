// @vitest-environment happy-dom
//
// ComposerPlusMenu — 两个 composer 共用的「+」菜单（task 08-04 WP6）。
//
// 覆盖的契约（每条都是「改错了用户会中招」的那种）：
//   1. **「+」是菜单，不是伪装成菜单的按钮**。WP6 之前 agent 面的「+」点下去**直接**弹文件
//      选择器 —— 图标承诺「加点什么」，行为只有一种，用户按图标去找外部连接必然扑空。现在
//      点开是一级菜单，附件是**其中一项**。
//   2. **附件通路没换管道**：菜单里点「附件」→ 隐藏 input → 选文件 → `composer.addAttachment`
//      （issue #61 Lane 3 的 adapter 管线，与 paste/drop 同一条）。这里在**真 runtime** 上验
//      到 composer state 收下附件为止，而不是只断言 input.click() 被调过。
//   3. **两面同一个组件**：icon（邮件面）与 chip（agent 面）开出同一份菜单。
//   4. **关闭语义**：Escape / 点外都关；两级都关（不留一个吊在半空的一级菜单）。
//   5. **邮件面 360px 布局红线**（PRD）：happy-dom 不排版（getBoundingClientRect 恒 0），所以
//      抄 model_picker.test.tsx 的分两半机械化验法 —— (a) 弹层锚定类 + 固定宽度；(b) 在**真的**
//      ThreadComposer 里断言控件次序（算式唯一会悄悄失效的前提就是有人往前面插钮）。
//      🔴 顺带钉住 ApprovalModePicker 的越界修复：它现在是左组最后一个控件（x=140），248px
//      弹层再用 left-0 会伸到 388 > 348，故改居中锚定。
//
// connector 侧（那一项出不出、常驻强调点、二级面板全功能）在 ConnectorQuickPanel.test.tsx 里
// 用全 mock 的 api 测；这里**有意**不 mock `useMailApi` —— 真 api 在 happy-dom 里拿不到
// `/chat/config`，flag 判定 fail-closed 成 false，于是这里天然覆盖「connector 不可用时菜单
// 只剩附件项、但菜单本身仍在」这个形态。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { ComposerPlusMenu } from '@shared/assistant/components/ComposerPlusMenu'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedAui = null
})

/** 至少一个可选模型 —— 否则 ModelPicker 整个不渲染，下面数控件次序的用例会数错。 */
const MODELS: ComposerModelOption[] = [
  {
    ref: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    protocol: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    capabilities: null,
    maxOutput: null
  }
]

function stubControls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
  return {
    thinkingSupported: true,
    thinkingEnabled: false,
    onToggleThinking: vi.fn(),
    model: 'anthropic:claude-sonnet-4-6',
    availableModels: MODELS,
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

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

function Harness({
  children,
  controls
}: {
  children: React.ReactNode
  controls?: ChatComposerControls
}): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={controls ?? stubControls()}>
          <AuiProbe />
          {children}
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

const PLUS = (): string => i18n.t('chat.composer.plus')
const ATTACH_ITEM = (): string => i18n.t('chat.attachment.add')

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByLabelText(PLUS()))
  return screen.getByRole('menu', { name: PLUS() })
}

function txtFile(name = 'notes.txt'): File {
  return new File(['hello'], name, { type: 'text/plain' })
}

describe('ComposerPlusMenu — 「+」是菜单不是直通钮', () => {
  test('点「+」开出菜单，附件是其中一项（而不是点了就弹文件选择器）', () => {
    render(
      <Harness>
        <ComposerPlusMenu variant="icon" />
      </Harness>
    )
    const trigger = screen.getByLabelText(PLUS())
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()

    const menu = openMenu()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menuitem', { name: ATTACH_ITEM() })).toBeTruthy()
    // connector 不可用（真 api 在测试环境拿不到 flag → fail-closed）→ 只剩附件一项，
    // 但菜单**本身**仍在：它是「加东西」的固定落点。
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(1)
  })

  test.each(['icon', 'chip'] as const)('%s variant 开出同一份菜单', (variant) => {
    render(
      <Harness>
        <ComposerPlusMenu variant={variant} />
      </Harness>
    )
    openMenu()
    expect(screen.getByRole('menuitem', { name: ATTACH_ITEM() })).toBeTruthy()
  })
})

describe('ComposerPlusMenu — 附件通路（真 runtime，管线没换）', () => {
  test('点「附件」→ 触发隐藏 input → 选中的文件进 composer.addAttachment', async () => {
    const { container } = render(
      <Harness>
        <ComposerPlusMenu variant="icon" />
      </Harness>
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const clickSpy = vi.spyOn(input, 'click')

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: ATTACH_ITEM() }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    // 点完即收：文件选择器接管之后还挂着一层菜单是纯遮挡。
    expect(screen.queryByRole('menu')).toBeNull()

    // 选文件（浏览器会在 input 上派 change）→ adapter 管线收下（第 2 条契约的落点）。
    await act(async () => {
      fireEvent.change(input, { target: { files: [txtFile()] } })
    })
    await waitFor(() => expect(capturedAui!.composer().getState().attachments).toHaveLength(1))
    expect(capturedAui!.composer().getState().attachments[0]).toMatchObject({
      name: 'notes.txt'
    })
    // input 复位（同一个文件连选两次也要能再触发 change）。
    expect(input.value).toBe('')
  })
})

describe('ComposerPlusMenu — 关闭语义', () => {
  test('Escape 关菜单', () => {
    render(
      <Harness>
        <ComposerPlusMenu variant="icon" />
      </Harness>
    )
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('点外面关菜单', () => {
    render(
      <Harness>
        <div data-testid="outside">outside</div>
        <ComposerPlusMenu variant="icon" />
      </Harness>
    )
    openMenu()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ComposerPlusMenu — 邮件面 360px 布局红线', () => {
  test('一级菜单 left-0 + 196px、二级弹层 left-0 + 268px（都不越界）', () => {
    render(
      <Harness>
        <ComposerPlusMenu variant="icon" />
      </Harness>
    )
    const menu = openMenu()
    expect(menu.className).toContain('left-0')
    expect(menu.className).toContain('w-[196px]')
    // 触发器 x = 12(px-3) + 1×28(h-7 w-7) + 1×4(gap-1) = 44（左组第 2 个控件）。
    expect(44 + 196).toBeLessThanOrEqual(360 - 12)
    // 二级弹层同锚点、268px（内容与 08-03 的面板逐字一致）。
    expect(44 + 268).toBeLessThanOrEqual(360 - 12)
    // 🔴 反向：这里**不能**抄 ConnectorQuickPanel 旧版的居中锚定 —— 居中会把 268px 弹层的
    // 左缘推到 44 + 14 - 134 = -76，改成顶出左边界。
    expect(44 + 14 - 268 / 2).toBeLessThan(0)
  })

  test('🔴 位置前提：真 ThreadComposer 里左组是 @ / + / 模型 / 思考 / 授权模式 五控件', async () => {
    render(
      <Harness>
        <ThreadComposer />
      </Harness>
    )
    const plus = await screen.findByLabelText(PLUS())
    const row = plus.closest('div.flex.items-center.gap-1')
    expect(row).toBeTruthy()
    const buttons = Array.from(row!.querySelectorAll('button'))
    // 左组 5 个 + 右侧 send/cancel（ThreadPrimitive.If 同一时刻只渲染一个）= 6。
    expect(buttons).toHaveLength(6)
    expect(buttons.indexOf(plus as HTMLButtonElement)).toBe(1)
    // W8 的算式前提未变：模型钮仍是第 3 个（model_picker.test.tsx 的 340 ≤ 348 靠它）。
    expect(buttons.indexOf(screen.getByLabelText(i18n.t('chat.composer.model')))).toBe(2)
    // 授权模式是最后一个（第 5 个）—— 下面那条越界修复的算式前提。
    expect(buttons.indexOf(screen.getByLabelText(i18n.t('chat.approvalMode.label')))).toBe(4)
  })

  test('🔴 ApprovalModePicker 越界修复：左组最后一个控件的 248px 弹层改居中锚定', async () => {
    render(
      <Harness>
        <ThreadComposer />
      </Harness>
    )
    fireEvent.click(await screen.findByLabelText(i18n.t('chat.approvalMode.label')))
    const menu = screen.getByRole('menu', { name: i18n.t('chat.approvalMode.label') })
    expect(menu.className).toContain('left-1/2')
    expect(menu.className).toContain('-translate-x-1/2')
    expect(menu.className).toContain('w-[248px]')
    // 触发器 x = 12(px-3) + 4×28 + 4×4 = 140，中心 154；居中后 [30, 278] 都在 [0, 348] 内。
    // （改前 left-0 → 右缘 140 + 248 = 388，越界 40px —— check-WP2 实测的预存缺陷。）
    expect(154 - 248 / 2).toBeGreaterThanOrEqual(0)
    expect(154 + 248 / 2).toBeLessThanOrEqual(360 - 12)
  })
})

// 🔴 出入场回归闸（08-05 WP-03）。这一条存在的理由是**台账说过谎**：`docs/motion-gsap.md` §8
// 从很早起就登记着「Composer model-picker 出入场已落地」，而 W8 重写 ModelPicker 时把它丢了，
// 「+」菜单与授权模式 picker 更是从来就没有过 —— 三个弹层全是 `{open && …}` 硬切，且**没有任何
// 测试**会因此变红，于是没人发现。判据取「退场期间仍在 DOM」这个可观测签名：硬切实现下，关闭的
// 同一拍元素就没了，这条必红。
// 全局 setup 强制 reduced-motion（那时 useExitAnimation 直切、与硬切不可分辨），所以这里必须自己
// 把 matchMedia 换成「不 reduce」——写法抄 tests/shared/useExitAnimation.test.tsx。
describe('composer 三个弹层 — 出入场（退场播完才卸载）', () => {
  beforeEach(() => {
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
  })
  afterEach(() => vi.unstubAllGlobals())

  // 触发器与弹层挂的是同一个 aria-label，故必须带 role 限定才选得到弹层本体。
  const popoverOf = (label: string): Element | null =>
    document.querySelector(`[role="menu"][aria-label="${label}"]`)

  test.each([
    ['「+」菜单', 'chat.composer.plus'],
    ['模型选择器', 'chat.composer.model'],
    ['授权模式', 'chat.approvalMode.label']
  ])('%s：Escape 后先留在 DOM 播退场，再卸载', async (_name, labelKey) => {
    render(
      <Harness>
        <ThreadComposer />
      </Harness>
    )
    const label = i18n.t(labelKey)
    fireEvent.click(await screen.findByLabelText(label))
    expect(popoverOf(label)).not.toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    // 硬切实现在这一行就已经是 null（本闸的失败模式）。
    expect(popoverOf(label)).not.toBeNull()
    // DUR.fast=120ms 的退场播完后才真正卸载。
    await waitFor(() => expect(popoverOf(label)).toBeNull(), { timeout: 2000 })
  })

  // 🔴 check 补：接了退场之后，「关闭时顺手复位内部步骤」这种以前无害的写法会变成**淡出途中
  // 当场换内容**。ApprovalModePicker 的 bypass 确认步骤是这一类里唯一还剩的（另一处是
  // ComposerPlusMenu 的 view，闸在 ConnectorQuickPanel.test.tsx）。复位改到「开」的那一侧，
  // 契约仍由触发器这唯一入口守住 —— 两条断言分别钉住「退场期间不换内容」与「重开必回列表」。
  test('授权模式：从 bypass 确认步骤 Escape，退场期间仍是确认面板；重开回模式列表', async () => {
    render(
      <Harness>
        <ThreadComposer />
      </Harness>
    )
    const label = i18n.t('chat.approvalMode.label')
    const trigger = await screen.findByLabelText(label)
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /完全授权/ }))
    const confirmTitle = i18n.t('chat.approvalMode.bypassConfirmTitle')
    expect(screen.queryByText(confirmTitle)).not.toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    // 复位若留在关的那一侧，这一拍确认面板已被换成三行模式列表（列表更高 → 边淡出边长高）。
    expect(screen.queryByText(confirmTitle)).not.toBeNull()
    await waitFor(() => expect(popoverOf(label)).toBeNull(), { timeout: 2000 })

    fireEvent.click(trigger)
    await waitFor(() => expect(popoverOf(label)).not.toBeNull(), { timeout: 2000 })
    expect(screen.queryByText(confirmTitle)).toBeNull()
  })
})

describe('ComposerPlusMenu — agent 面落点', () => {
  test('AgentComposer 动作行里「+」在最前，且不再有独立的 connector 圆钮', async () => {
    render(
      <Harness>
        <AgentComposer />
      </Harness>
    )
    const plus = await screen.findByLabelText(PLUS())
    const row = plus.closest('div.flex.items-center.gap-0\\.5')
    expect(row).toBeTruthy()
    const buttons = Array.from(row!.querySelectorAll('button'))
    expect(buttons.indexOf(plus as HTMLButtonElement)).toBe(0)
    // 独立的「外部连接」钮已经不在动作行里（入口只剩「+」这一处）。
    expect(screen.queryByLabelText(i18n.t('chat.connectors.label'))).toBeNull()
  })
})
