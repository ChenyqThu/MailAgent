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
import { AnthropicColorIcon, OpenAiIcon } from '@shared/components/icons/providers/brandIcons'
import type { ProviderIconRender } from '@shared/components/icons/providers/providerIconMap'
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
    model,
    availableModels,
    onModelChange,
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    // 本闸只测模型选择器，不测 @ 提及 —— 与上面的邮件提及同构：空列表 + 空实现。
    // （agentMentions 与 mentions 是两套：前者是可信本地 agent 配置，后者要过 body 解析。）
    agentMentions: [],
    onAddAgentMention: vi.fn(),
    onRemoveAgentMention: vi.fn(),
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

  // dogfood 轮 2 #1 —— AI chat 浮窗最窄 32rem，模型名长时底部工具/信息行会被撑出去。
  // happy-dom 不排版（getBoundingClientRect 恒 0），验不了真实溢出，机械化验两件事：
  // ①触发器有 `min-w-0`（没有它，flex 布局按钮会保留 max-content 宽度不跟着收缩）
  // ②内部文字仍是 `truncate` + 有界 `max-w`（省略号靠这个生效，不是靠字符串截断）。
  test('chip variant 触发器：长模型名下 min-w-0 + truncate 齐全（防撑爆浮窗工具条）', () => {
    const LONG_NAME = 'Claude Opus 4.8 Extended Thinking Preview (2026-08-13 build)'
    render(
      <ModelPicker
        controls={controlsFor(
          [option({ ref: 'anthropic:x', displayName: LONG_NAME })],
          'anthropic:x'
        )}
        variant="chip"
      />
    )
    const trigger = screen.getByLabelText(i18n.t('chat.composer.model'))
    expect(trigger.className).toContain('min-w-0')
    const textSpan = trigger.querySelector('span')
    expect(textSpan?.className).toContain('min-w-0')
    expect(textSpan?.className).toContain('truncate')
    expect(textSpan?.className).toMatch(/max-w-\[\d+px\]/)
    // 文案本身不截断（截断是 CSS ellipsis 的活，不是把字符串砍短）。
    expect(trigger.textContent).toContain(LONG_NAME)
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

/** 图标资产的比对基准：直接渲染那个 render 函数，比 `<svg>` 的 innerHTML（路径数据）。
 *  🔴 有意不硬编码 path d —— 换一版资产时基准跟着变，测试不会假红。 */
function iconMarkup(icon: ProviderIconRender): string {
  const { container, unmount } = render(icon({}))
  const html = container.querySelector('svg')?.innerHTML ?? ''
  unmount()
  return html
}

function svgOf(el: Element | null | undefined): string {
  return el?.querySelector('svg')?.innerHTML ?? ''
}

describe('ModelPicker — 🔴 厂商 logo 按「模型属于哪一家」，不按 provider 怎么配', () => {
  // owner 的中转：`default`（protocol=anthropic，「Anthropic-crs」）下同时挂 claude 与 gpt-5.x；
  // `gpt`（protocol=openai-compatible）指向同一个中转。改动前 GPT 行打的是 Anthropic 彩标、
  // OpenAI-crs 整组是灰 Cpu —— 错的信息比没有更糟。
  const RELAY: ComposerModelOption[] = [
    option({
      ref: 'default:claude-opus-5',
      providerLabel: 'Anthropic-crs',
      protocol: 'anthropic',
      displayName: 'Claude Opus 5',
      catalogMeta: meta({ catalogProviderId: 'anthropic', catalogProviderName: 'Anthropic' })
    }),
    option({
      ref: 'default:gpt-5.5',
      providerLabel: 'Anthropic-crs',
      protocol: 'anthropic',
      displayName: 'GPT-5.5',
      catalogMeta: meta({ catalogProviderId: 'openai', catalogProviderName: 'OpenAI' })
    }),
    option({
      ref: 'gpt:gpt-5',
      providerLabel: 'OpenAI-crs',
      protocol: 'openai-compatible',
      displayName: 'GPT-5',
      catalogMeta: meta({ catalogProviderId: 'openai', catalogProviderName: 'OpenAI' })
    })
  ]

  const rowNamed = (name: string): Element | undefined =>
    screen.getAllByRole('menuitemradio').find((r) => r.textContent?.includes(name))

  test('protocol=anthropic 的中转下，GPT 行打 OpenAI、claude 行仍打 Anthropic', () => {
    render(<ModelPicker controls={controlsFor(RELAY, 'default:claude-opus-5')} variant="icon" />)
    openMenu('icon')
    expect(svgOf(rowNamed('GPT-5.5'))).toBe(iconMarkup(OpenAiIcon))
    expect(svgOf(rowNamed('GPT-5.5'))).not.toBe(iconMarkup(AnthropicColorIcon))
    expect(svgOf(rowNamed('Claude Opus 5'))).toBe(iconMarkup(AnthropicColorIcon))
  })

  // 🔴 **两个 variant 都验**：两个触发器是各写一遍的 JSX（本文件契约 1 —— 它们漂移过一次），
  // 只验 chip 时把 icon 那份的 catalogProviderId 删掉能一路全绿（实测）。而 icon 恰是邮件面用的。
  test.each(['icon', 'chip'] as const)(
    '%s 触发器上的 logo 跟着当前模型走（不是跟着它挂在哪个 provider 下）',
    (variant) => {
      render(<ModelPicker controls={controlsFor(RELAY, 'default:gpt-5.5')} variant={variant} />)
      const trigger = screen.getByLabelText(i18n.t('chat.composer.model'))
      expect(svgOf(trigger)).toBe(iconMarkup(OpenAiIcon))
      expect(svgOf(trigger)).not.toBe(iconMarkup(AnthropicColorIcon))
    }
  )

  test('组标题：全组同一家才采纳目录厂商；混装组落回 provider 自己的 protocol', () => {
    render(<ModelPicker controls={controlsFor(RELAY, 'default:claude-opus-5')} variant="icon" />)
    openMenu('icon')
    // 「OpenAI-crs」组只有 OpenAI 模型 → 组标题也出 OpenAI（改动前是灰 Cpu，与底下的行自相矛盾）。
    const openaiHeader = screen.getByText('OpenAI-crs').closest('div')
    expect(svgOf(openaiHeader)).toBe(iconMarkup(OpenAiIcon))
    // 「Anthropic-crs」组 claude + gpt 混装 → 没有共识，落回 protocol=anthropic（provider 本身）。
    const relayHeader = screen.getByText('Anthropic-crs').closest('div')
    expect(svgOf(relayHeader)).toBe(iconMarkup(AnthropicColorIcon))
  })

  test('🔴 混装组的共识看**全组**，与组内行序无关', () => {
    // 上一条单独跑不住这个规则：RELAY 里混装组的第一行恰好是 claude，「取第一行」与「全组
    // 一致才采纳」给出的答案**一样**（实测把 every(...) 改成取第一行，上面那条仍全绿）。
    // 故两种行序各渲一遍 —— 无论 claude 在前还是 gpt 在前，混装组标题都必须是 protocol 兜底。
    for (const opts of [RELAY, [RELAY[1], RELAY[0], RELAY[2]]]) {
      render(<ModelPicker controls={controlsFor(opts, 'default:claude-opus-5')} variant="icon" />)
      openMenu('icon')
      const relayHeader = screen.getByText('Anthropic-crs').closest('div')
      expect(svgOf(relayHeader)).toBe(iconMarkup(AnthropicColorIcon))
      expect(svgOf(relayHeader)).not.toBe(iconMarkup(OpenAiIcon))
      cleanup()
    }
  })

  test('🔴 hover 能力卡的头也按目录厂商（第 5 个消费点，别漏传）', () => {
    // `catalogProviderId` 是**可选** prop：哪个消费点漏传都只是静默退回旧的错图标，
    // TS 不报错。这条专盯 ModelDetailCard —— 实测把那一行删掉，其余用例全绿。
    // 卡的页脚就印着「来源：OpenAI」，头上打 Anthropic 标是当场自相矛盾。
    render(<ModelPicker controls={controlsFor(RELAY, 'default:claude-opus-5')} variant="chip" />)
    openMenu('chip')
    fireEvent.mouseEnter(rowNamed('GPT-5.5')!)
    const card = screen.getByTestId('model-detail-card')
    expect(card.textContent).toContain('OpenAI')
    expect(svgOf(card)).toBe(iconMarkup(OpenAiIcon))
    expect(svgOf(card)).not.toBe(iconMarkup(AnthropicColorIcon))
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

// 🔴 08-05 WP-13+16b：本控件搬到工具条**右组**（环 / effort / 模型 / 发送），锚定随之
// left-0 → right-0。红线因此换了一条算式：右缘对齐触发器右缘、向左展开。
describe('ModelPicker — 右组布局红线', () => {
  test('弹层改 right-0 锚定 + 固定 264px（越界闸）', () => {
    render(
      <ModelPicker
        controls={controlsFor(TWO_PROVIDERS, 'anthropic:claude-sonnet-4-6')}
        variant="icon"
      />
    )
    openMenu('icon')
    const menu = screen.getByRole('menu')
    expect(menu.className).toContain('right-0')
    expect(menu.className).not.toContain('left-0')
    expect(menu.className).toContain('w-[264px]')
    // 邮件面 360px：右组自右向左 = 发送(36) / 模型(28) / effort(28) / 环。模型钮右缘
    // ≈ 348 - 36 = 312 → 弹层 [312-264, 312] = [48, 312]，两端都在 [12, 348] 内。
    expect(312 - 264).toBeGreaterThanOrEqual(12)
    expect(312).toBeLessThanOrEqual(360 - 12)
    // 🔴 反向：留在 left-0 时右缘 = 284 + 264 = 548，越界 200px（本闸存在的理由）。
    expect(284 + 264).toBeGreaterThan(360 - 12)
  })

  test('🔴 位置前提：在真的 ThreadComposer 里，模型钮在右组、发送钮之前', async () => {
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
    // 上面那道算式的前提 = 模型钮**贴着发送钮**（右组倒数第二）。有人往它后面插一个钮，
    // 触发器就左移、right-0 弹层的左缘跟着走 —— 这条断言是那个前提的绊线。
    const group = trigger.closest('div.ml-auto')
    expect(group).toBeTruthy()
    const buttons = Array.from(group!.querySelectorAll('button'))
    expect(buttons.indexOf(trigger as HTMLButtonElement)).toBe(buttons.length - 2)
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
