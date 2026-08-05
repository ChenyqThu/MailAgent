// @vitest-environment happy-dom
//
// ModelPicker — 两个 composer 共用的模型选择器（task 08-04 WP2 / chat-ui W8）。
//
// 覆盖的契约（每条都是「改错了用户会中招」的那种）：
//   1. **双 variant 一份实现**：icon（邮件面）与 chip（agent 面）渲染同一份菜单内容。
//      这条正是收编 ComposerModelPicker / AgentModelPicker 的理由——两份漂移过一次。
//   2. **值仍是完整 providerRef**：菜单里显示的是 displayName（人话），点下去回调必须拿到
//      `providerId:modelId` 全串。显示与取值搞混 = 发给 gateway 的模型 id 直接失效。
//   3. **分组只在多 provider 时出现**：单 provider（含 flag-off 的裸 id 场景）不摆组标题。
//   4. **capabilities === null ≠ 全 false**：未标注不渲染任何 badge；显式 false 也不渲染；
//      只有 true 才出。把「未知」画成「不支持」是撒谎。
//   5. **maxOutput 药丸**：有值 → 64K；null → 整个药丸不存在。
//   6. **孤儿当前值**：选中的模型已被 Settings 取消勾选时，仍作为一行出现并标「（未启用）」——
//      否则菜单里一个 checked 都没有，用户看不出自己在用什么。
//   7. **360px 不越界**（PRD 布局红线）。happy-dom 不排版（getBoundingClientRect 恒 0），所以
//      分两半机械化验：(a) 弹层保持 `left-0` + 固定 `w-[264px]`；(b) 在**真的** ThreadComposer 里
//      断言它仍是左组第 3 个控件 —— 位置正是那道算式唯一会悄悄失效的前提（有人往前面插一个钮，
//      触发器右移，弹层就顶出去了）。算式：12(px-3) + 3×28 + 2×4 = 76 起，76+264=340 ≤ 348。
//      真实观感仍需 dogfood（已入 07-29 acceptance-checklist W8 节）。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { ModelPicker } from '@shared/assistant/components/ModelPicker'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  // assistant-ui Viewport 依赖 happy-dom 没有的 observer（抄 composer_send_gate.test 的 stub）。
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})
afterEach(() => cleanup())

function option(over: Partial<ComposerModelOption> & { ref: string }): ComposerModelOption {
  const providerId = over.ref.includes(':') ? over.ref.split(':')[0] : 'default'
  const modelId = over.ref.includes(':') ? over.ref.slice(over.ref.indexOf(':') + 1) : over.ref
  return {
    providerId,
    providerLabel: null,
    protocol: null,
    modelId,
    displayName: modelId,
    capabilities: null,
    maxOutput: null,
    ...over
  }
}

function controlsFor(
  availableModels: ComposerModelOption[],
  model: string | null,
  onModelChange = vi.fn()
): ChatComposerControls {
  return {
    thinkingSupported: true,
    thinkingEnabled: false,
    onToggleThinking: vi.fn(),
    model,
    availableModels,
    onModelChange,
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn()
  }
}

const TWO_PROVIDERS: ComposerModelOption[] = [
  option({
    ref: 'anthropic:claude-sonnet-4-6',
    providerLabel: 'Anthropic',
    protocol: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    capabilities: { tools: true, vision: true, reasoning: false },
    maxOutput: 64000
  }),
  option({
    ref: 'openai:gpt-5.5',
    providerLabel: 'OpenAI',
    protocol: 'openai',
    displayName: 'GPT-5.5',
    capabilities: { tools: true },
    maxOutput: 128000
  })
]

function openMenu(variant: 'icon' | 'chip'): void {
  fireEvent.click(screen.getByLabelText(i18n.t('chat.composer.model')))
  expect(variant).toBeTruthy()
}

describe('ModelPicker — 双 variant 一份实现', () => {
  test.each(['icon', 'chip'] as const)('%s variant: 同一份分组菜单 + 厂商组标题', (variant) => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant={variant}
      />
    )
    openMenu(variant)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText('OpenAI')).toBeTruthy()
    // chip variant 的触发器也印着当前模型名 → 用 getAllBy（icon variant 只有菜单里那一处）。
    expect(screen.getAllByText('Claude Sonnet 4.6').length).toBeGreaterThan(0)
    expect(screen.getByText('GPT-5.5')).toBeTruthy()
  })

  test('chip variant 的触发器显示当前模型的 displayName（不是裸 ref）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="chip"
      />
    )
    expect(screen.getByLabelText(i18n.t('chat.composer.model')).textContent).toContain(
      'Claude Sonnet 4.6'
    )
  })

  test('零模型 → 整个入口不渲染（不占 composer 的位）', () => {
    const { container } = render(<ModelPicker controls={controlsFor([], null)} variant="icon" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('ModelPicker — 选中值仍是完整 providerRef', () => {
  test('点 displayName 的行，回调拿到的是 providerId:modelId 全串', () => {
    const onModelChange = vi.fn()
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6', onModelChange)}
        variant="chip"
      />
    )
    openMenu('chip')
    fireEvent.click(screen.getByText('GPT-5.5'))
    expect(onModelChange).toHaveBeenCalledWith('openai:gpt-5.5')
    // 选完即关。
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('当前项 aria-checked，其余不 checked', () => {
    render(<ModelPicker controls={controlsFor(TWO_PROVIDERS, 'openai:gpt-5.5')} variant="chip" />)
    openMenu('chip')
    const rows = screen.getAllByRole('menuitemradio')
    const checked = rows.filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].textContent).toContain('GPT-5.5')
  })
})

describe('ModelPicker — 分组只在多 provider 时出现', () => {
  test('单 provider（裸 legacy id）不摆组标题', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [option({ ref: 'claude-sonnet-4-6' }), option({ ref: 'gpt-5.5' })],
          'claude-sonnet-4-6'
        )}
        variant="icon"
      />
    )
    openMenu('icon')
    // 'default（主网关）' 的组标题在单组时不该出现。
    expect(screen.queryByText(i18n.t('settings.providers.group.default'))).toBeNull()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  })

  test('provider 行缺 displayName 时组标题回落 providerId / default 文案', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [option({ ref: 'claude-sonnet-4-6' }), option({ ref: 'zhipu:glm-4.6' })],
          'claude-sonnet-4-6'
        )}
        variant="icon"
      />
    )
    openMenu('icon')
    expect(screen.getByText(i18n.t('settings.providers.group.default'))).toBeTruthy()
    expect(screen.getByText('zhipu')).toBeTruthy()
  })
})

describe('ModelPicker — 能力 badge 与 maxOutput 药丸', () => {
  test('capabilities=null（上游未标注）→ 一个 badge 都不渲染', () => {
    render(
      <ModelPicker
        controls={controlsFor([option({ ref: 'anthropic:x', capabilities: null })], 'anthropic:x')}
        variant="icon"
      />
    )
    openMenu('icon')
    expect(screen.queryByLabelText(i18n.t('settings.providers.models.cap.vision'))).toBeNull()
    expect(screen.queryByLabelText(i18n.t('settings.providers.models.cap.tools'))).toBeNull()
    expect(screen.queryByLabelText(i18n.t('settings.providers.models.cap.reasoning'))).toBeNull()
  })

  test('只有显式 true 的能力位出 badge（false 与缺席都不出）', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [option({ ref: 'anthropic:x', capabilities: { vision: true, tools: false } })],
          'anthropic:x'
        )}
        variant="icon"
      />
    )
    openMenu('icon')
    expect(screen.getByLabelText(i18n.t('settings.providers.models.cap.vision'))).toBeTruthy()
    expect(screen.queryByLabelText(i18n.t('settings.providers.models.cap.tools'))).toBeNull()
    expect(screen.queryByLabelText(i18n.t('settings.providers.models.cap.reasoning'))).toBeNull()
  })

  test('maxOutput 有值 → 药丸（64000 → 64K）；null → 无药丸', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [
            option({ ref: 'a:with', displayName: 'with', maxOutput: 64000 }),
            option({ ref: 'a:without', displayName: 'without', maxOutput: null })
          ],
          'a:with'
        )}
        variant="icon"
      />
    )
    openMenu('icon')
    expect(screen.getByText('64K')).toBeTruthy()
    const withoutRow = screen
      .getAllByRole('menuitemradio')
      .find((r) => r.textContent?.includes('without'))
    expect(withoutRow?.textContent).not.toMatch(/\d+K/)
  })
})

describe('ModelPicker — 孤儿当前值', () => {
  test('当前模型不在启用列表里时仍作为一行出现并标「（未启用）」', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-opus-4-8')}
        variant="chip"
      />
    )
    openMenu('chip')
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows).toHaveLength(3)
    const orphan = rows.find((r) => r.textContent?.includes('claude-opus-4-8'))
    expect(orphan).toBeTruthy()
    expect(orphan?.getAttribute('aria-checked')).toBe('true')
    expect(orphan?.textContent).toContain(i18n.t('settings.ai.enabledModels.notEnabled'))
  })

  test('孤儿不影响启用列表本身（不会被当成第 3 个可选项算进分组标题）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-opus-4-8')}
        variant="chip"
      />
    )
    openMenu('chip')
    // 孤儿归到 anthropic 组（同 providerId），不新开一个组。
    expect(screen.getAllByText('Anthropic')).toHaveLength(1)
  })
})

describe('ModelPicker — 邮件面 360px 布局红线', () => {
  test('弹层保持 left-0 锚定 + 固定 264px（越界闸）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="icon"
      />
    )
    openMenu('icon')
    const menu = screen.getByRole('menu')
    expect(menu.className).toContain('left-0')
    expect(menu.className).toContain('w-[264px]')
    // 触发器 x = 12(px-3) + 3×28(h-7 w-7) + 2×4(gap-1) = 76 → 76 + 264 = 340 ≤ 348（360 - px-3）。
    expect(76 + 264).toBeLessThanOrEqual(360 - 12)
  })

  test('🔴 位置前提：在真的 ThreadComposer 里，模型钮仍是左组第 3 个控件', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
          <ChatComposerControlsProvider
            value={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
          >
            <ThreadComposer />
          </ChatComposerControlsProvider>
        </AiSdkRuntimeProvider>
      </QueryClientProvider>
    )
    const trigger = await screen.findByLabelText(i18n.t('chat.composer.model'))
    // 左组 = 工具条那一行；数模型钮前面有几个可点控件（上面那道算式唯一会悄悄失效的前提就是
    // 有人往前面插一个钮 → 触发器右移 → 264px 弹层顶出右边界）。
    const row = trigger.closest('div.flex.items-center.gap-1')
    expect(row).toBeTruthy()
    const buttons = Array.from(row!.querySelectorAll('button'))
    expect(buttons.indexOf(trigger as HTMLButtonElement)).toBe(2)
  })
})

describe('ModelPicker — disabled 态', () => {
  test('modelPickerDisabled 时点击不开菜单', () => {
    const controls = {
      ...controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6'),
      modelPickerDisabled: true
    }
    render(<ModelPicker controls={controls} variant="icon" />)
    fireEvent.click(screen.getByLabelText(i18n.t('chat.composer.model')))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
