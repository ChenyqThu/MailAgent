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
//   5. **上下文长度药丸**（08-05 起 —— 首版印的是 maxOutput「最大输出」，语义与参考产品不是
//      一回事）：有值 → 200K/1M；null → 整个药丸不存在（不写 '?'、不写 0）。
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
import { AI_TAB_ANCHOR_IDS, llmProviderAnchorId } from '@shared/components/settings/aiTabAnchors'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import type { CatalogModelMeta } from '@shared/modelCatalog/lookup'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'

// 齿轮深链的两端各打一个桩：这些测试不挂 RouterProvider（挂了要连带把整棵路由树搬进来），
// 而 scrollToAnchorWhenReady 是 rAF 轮询，在 happy-dom 里等它不划算 —— 断言「用什么参数调的」
// 就够，函数本身的行为归它自己的实现。
const navigateSpy = vi.fn()
const scrollSpy = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: navigateSpy }) }))
vi.mock('@shared/components/settings/aiTabAnchors', async (orig) => ({
  ...(await orig<typeof import('@shared/components/settings/aiTabAnchors')>()),
  scrollToAnchorWhenReady: (...args: unknown[]) => scrollSpy(...args)
}))

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
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

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
    contextWindow: null,
    catalogMeta: null,
    ...over
  }
}

/** 目录命中的最小形状（hover 能力卡的输入）。 */
function meta(over: Partial<CatalogModelMeta> = {}): CatalogModelMeta {
  return {
    displayName: 'Claude Sonnet 4.6',
    description: '一句话描述',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    capabilities: { tools: true, vision: true },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: null },
    releasedAt: '2026-02-17',
    knowledgeCutoff: '2025-08-31',
    deprecated: false,
    catalogProviderId: 'anthropic',
    catalogProviderName: 'Anthropic',
    match: 'exact',
    matchedModelId: 'claude-sonnet-4-6',
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
    maxOutput: 64000,
    contextWindow: 1_000_000,
    catalogMeta: meta()
  }),
  option({
    ref: 'openai:gpt-5.5',
    providerLabel: 'OpenAI',
    protocol: 'openai',
    displayName: 'GPT-5.5',
    capabilities: { tools: true },
    maxOutput: 128000,
    contextWindow: 400_000
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

  test('contextWindow 有值 → 药丸（200000 → 200K）；null → 无药丸（静默降级，不写 ? 不写 0）', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [
            option({ ref: 'a:with', displayName: 'with', contextWindow: 200_000 }),
            // 🔴 maxOutput 有值也不该冒出药丸 —— 药丸语义已改成上下文长度，两者不是一回事。
            option({
              ref: 'a:without',
              displayName: 'without',
              contextWindow: null,
              maxOutput: 64000
            })
          ],
          'a:with'
        )}
        variant="icon"
      />
    )
    openMenu('icon')
    expect(screen.getByText('200K')).toBeTruthy()
    const withoutRow = screen
      .getAllByRole('menuitemradio')
      .find((r) => r.textContent?.includes('without'))
    expect(withoutRow?.textContent).not.toMatch(/\d+[KM]/)
  })

  test('1M 档不写成 1000K（owner 的 1_050_000 中转档保一位小数）', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [
            option({ ref: 'a:m', displayName: 'm', contextWindow: 1_000_000 }),
            option({ ref: 'a:relay', displayName: 'relay', contextWindow: 1_050_000 })
          ],
          'a:m'
        )}
        variant="icon"
      />
    )
    openMenu('icon')
    expect(screen.getByText('1M')).toBeTruthy()
    expect(screen.getByText('1.1M')).toBeTruthy()
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
    const notEnabled = i18n.t('settings.ai.enabledModels.notEnabled')
    const orphan = rows.find((r) => r.textContent?.includes(notEnabled))
    expect(orphan).toBeTruthy()
    expect(orphan?.getAttribute('aria-checked')).toBe('true')
    // 行内的完整 ref 仍在 title 上（displayName 可能已被目录换成人话全名 —— 孤儿走的是同一个
    // 合成器，目录元数据照拿；否则「被取消勾选的当前模型」会莫名比别的行少一半信息）。
    expect(orphan?.querySelector('[title]')?.getAttribute('title')).toBe(
      'anthropic:claude-opus-4-8'
    )
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

describe('ModelPicker — hover 能力卡', () => {
  test('hover 一行 → 出卡；卡里有全名/上下文/最大输出/能力/定价/来源', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="chip"
      />
    )
    openMenu('chip')
    expect(screen.queryByTestId('model-detail-card')).toBeNull()
    const row = screen
      .getAllByRole('menuitemradio')
      .find((r) => r.textContent?.includes('Claude Sonnet 4.6'))!
    fireEvent.mouseEnter(row)
    const card = screen.getByTestId('model-detail-card')
    expect(card.textContent).toContain('一句话描述')
    expect(card.textContent).toContain(i18n.t('chat.composer.modelCard.context'))
    expect(card.textContent).toContain('1M')
    expect(card.textContent).toContain('128K')
    expect(card.textContent).toContain(i18n.t('chat.composer.modelCard.pricing'))
    expect(card.textContent).toContain('$3.00')
    expect(card.textContent).toContain('$0.300')
    expect(card.textContent).toContain('models.dev')
    // 🔴 exact 命中**不许**带「按 X 推断」那句 —— 逐字命中是事实，加这句是给准确数据泼脏水
    //（也是「注明来源」与「注明推断」两件事被写成一件时最容易出的错）。
    expect(card.textContent).not.toContain(
      i18n.t('chat.composer.modelCard.inferred', { id: 'claude-sonnet-4-6' })
    )
    // 🔴 卡不接受交互 —— 它 portal 在 body 上，能点就会被 picker 的 document.mousedown
    // 当成「点了外面」，把整个选择器关掉。
    expect(card.className).toContain('pointer-events-none')
  })

  test('🔴 目录未命中的行（catalogMeta=null）hover 不出卡（静默降级，不摆空卡）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="chip"
      />
    )
    openMenu('chip')
    const row = screen
      .getAllByRole('menuitemradio')
      .find((r) => r.textContent?.includes('GPT-5.5'))!
    fireEvent.mouseEnter(row)
    expect(screen.queryByTestId('model-detail-card')).toBeNull()
  })

  test('🔴 normalized 命中要如实标「按 X 推断」（中转把档位写进 id 时数字是推断值）', () => {
    render(
      <ModelPicker
        controls={controlsFor(
          [
            option({
              ref: 'relay:claude-opus-5[1m]',
              displayName: 'Claude Opus 5',
              catalogMeta: meta({ match: 'normalized', matchedModelId: 'claude-opus-5' })
            })
          ],
          'relay:claude-opus-5[1m]'
        )}
        variant="chip"
      />
    )
    openMenu('chip')
    fireEvent.mouseEnter(screen.getAllByRole('menuitemradio')[0])
    expect(screen.getByTestId('model-detail-card').textContent).toContain(
      i18n.t('chat.composer.modelCard.inferred', { id: 'claude-opus-5' })
    )
  })

  test('弹层关闭时卡跟着消失（卡在 body 上，弹层没了它不会自己走）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="chip"
      />
    )
    openMenu('chip')
    fireEvent.mouseEnter(
      screen.getAllByRole('menuitemradio').find((r) => r.textContent?.includes('Sonnet'))!
    )
    expect(screen.getByTestId('model-detail-card')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('model-detail-card')).toBeNull()
  })
})

describe('ModelPicker — 组标题齿轮深链', () => {
  test('点齿轮 → 跳设置-AI，并优先滚到这一家 provider 的卡（找不到才退到整区）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="chip"
      />
    )
    openMenu('chip')
    fireEvent.click(
      screen.getByLabelText(i18n.t('chat.composer.modelProviderSettings', { name: 'OpenAI' }))
    )
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/settings', search: { tab: 'ai' } })
    expect(scrollSpy).toHaveBeenCalledWith(
      llmProviderAnchorId('openai'),
      AI_TAB_ANCHOR_IDS.modelServices
    )
    // 跳走前先收起弹层（否则回到 chat 时它还开着）。
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ModelPicker — 打开时滚到选中项', () => {
  test('打开弹层 → 当前选中行 scrollIntoView（恒从顶部 = 用户每次自己找）', () => {
    const seen: unknown[] = []
    const orig = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (arg?: unknown) {
      seen.push([(this as HTMLElement).textContent, arg])
    } as typeof orig
    try {
      render(<ModelPicker controls={controlsFor(TWO_PROVIDERS, 'openai:gpt-5.5')} variant="chip" />)
      openMenu('chip')
      expect(seen).toHaveLength(1)
      expect(String((seen[0] as [string])[0])).toContain('GPT-5.5')
    } finally {
      HTMLElement.prototype.scrollIntoView = orig
    }
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
