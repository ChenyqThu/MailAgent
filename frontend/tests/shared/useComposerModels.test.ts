// useComposerModels 的纯函数面（W8 / task 08-04 WP2）—— 富元数据合成与分组。
//
// 覆盖的是「元数据缺失时不许退化成空洞或谎话」这条：provider 表拉不到 / 某个 model 行不存在，
// 选择器仍必须显示得出这个模型（退回今天扁平列表那份信息：ref + 去前缀 id），而不是空白行。
// 另外钉住 providerRef 的切分口径与 Settings/抽屉的 groupModelRefs 一致（default 恒最前、
// 组内保持 enabledModels 原顺序），否则两处列表顺序会莫名不同。

import { describe, expect, test } from 'vitest'

import {
  buildComposerModelOption,
  groupComposerModels,
  type ComposerModelMeta,
  type ComposerModelOption,
  type ComposerProviderMeta
} from '@shared/hooks/useComposerModels'
// 切分规则的单源在 useLlmProviders（与 Settings 的 groupModelRefs 同一个函数）——composer
// 侧只是复用，故这里也从单源 import，防有人日后在 composer 侧又抄一份。
import { refProviderId } from '@shared/hooks/useLlmProviders'

const NO_PROVIDERS: ComposerProviderMeta = new Map()
const NO_MODELS: ComposerModelMeta = new Map()

function modelMeta(
  rows: Array<[string, string, Partial<{ displayName: string | null; maxOutput: number | null }>]>
): ComposerModelMeta {
  const m: ComposerModelMeta = new Map()
  for (const [providerId, modelId, over] of rows) {
    let bucket = m.get(providerId)
    if (!bucket) {
      bucket = new Map()
      m.set(providerId, bucket)
    }
    bucket.set(modelId, { displayName: null, capabilities: null, maxOutput: null, ...over })
  }
  return m
}

describe('refProviderId — providerRef 切分', () => {
  test('第一个冒号之前是 providerId', () => {
    expect(refProviderId('anthropic:claude-sonnet-4-6')).toBe('anthropic')
  })
  test('OpenRouter 那种带斜杠的 wire id 不影响切分', () => {
    expect(refProviderId('openrouter:openai/gpt-4o')).toBe('openrouter')
  })
  test('裸 legacy id → default', () => {
    expect(refProviderId('claude-sonnet-4-6')).toBe('default')
  })
  test('冒号开头（畸形值）不当成空 provider', () => {
    expect(refProviderId(':weird')).toBe('default')
  })
})

describe('buildComposerModelOption — 元数据缺失时的退化', () => {
  test('provider / model 行都查不到 → 仍给出可显示的行（ref + 去前缀 id）', () => {
    const o = buildComposerModelOption('anthropic:claude-sonnet-4-6', NO_PROVIDERS, NO_MODELS)
    expect(o).toMatchObject({
      ref: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
      providerLabel: null,
      protocol: null,
      modelId: 'claude-sonnet-4-6',
      displayName: 'claude-sonnet-4-6',
      capabilities: null,
      maxOutput: null
    })
  })

  test('有 provider + model 行 → 富元数据全带上', () => {
    const providers: ComposerProviderMeta = new Map([
      ['anthropic', { displayName: 'Anthropic', protocol: 'anthropic' }]
    ])
    const models: ComposerModelMeta = new Map([
      [
        'anthropic',
        new Map([
          [
            'claude-sonnet-4-6',
            {
              displayName: 'Claude Sonnet 4.6',
              capabilities: { tools: true, vision: true },
              maxOutput: 64000
            }
          ]
        ])
      ]
    ])
    const o = buildComposerModelOption('anthropic:claude-sonnet-4-6', providers, models)
    expect(o.providerLabel).toBe('Anthropic')
    expect(o.protocol).toBe('anthropic')
    expect(o.displayName).toBe('Claude Sonnet 4.6')
    expect(o.capabilities).toEqual({ tools: true, vision: true })
    expect(o.maxOutput).toBe(64000)
  })

  test('displayName 为空串 / 空白 → 回落 modelId（不渲染一行空白）', () => {
    const models = modelMeta([['default', 'm', { displayName: '   ' }]])
    expect(buildComposerModelOption('m', NO_PROVIDERS, models).displayName).toBe('m')
  })

  test('同名 model id 分属不同 provider 时互不串味（嵌套 Map 按 provider 分桶）', () => {
    const models = modelMeta([
      ['a', 'gpt-4o', { displayName: 'A 家的 GPT-4o' }],
      ['b', 'gpt-4o', { displayName: 'B 家的 GPT-4o', maxOutput: 8000 }]
    ])
    expect(buildComposerModelOption('a:gpt-4o', NO_PROVIDERS, models).displayName).toBe(
      'A 家的 GPT-4o'
    )
    expect(buildComposerModelOption('b:gpt-4o', NO_PROVIDERS, models).maxOutput).toBe(8000)
  })

  test('🔴 含 "/" 的 wire id（OpenRouter）查得到 —— 这正是不用复合字符串 key 的理由', () => {
    const models = modelMeta([['openrouter', 'openai/gpt-4o', { displayName: 'GPT-4o (OR)' }]])
    expect(
      buildComposerModelOption('openrouter:openai/gpt-4o', NO_PROVIDERS, models).displayName
    ).toBe('GPT-4o (OR)')
  })
})

function opt(ref: string, providerLabel: string | null = null): ComposerModelOption {
  return { ...buildComposerModelOption(ref, NO_PROVIDERS, NO_MODELS), providerLabel }
}

describe('groupComposerModels — 与 groupModelRefs 同一排序契约', () => {
  test('default 组恒排最前，其余按首现顺序', () => {
    const groups = groupComposerModels([
      opt('zhipu:glm-4.6'),
      opt('bare-legacy-id'),
      opt('anthropic:claude-sonnet-4-6'),
      opt('zhipu:glm-4.5')
    ])
    expect(groups.map((g) => g.providerId)).toEqual(['default', 'zhipu', 'anthropic'])
  })

  test('组内保持传入顺序（enabledModels 的顺序就是用户在 Settings 里的顺序）', () => {
    const groups = groupComposerModels([opt('zhipu:b'), opt('zhipu:a')])
    expect(groups[0].options.map((o) => o.ref)).toEqual(['zhipu:b', 'zhipu:a'])
  })

  test('组 label 取组内第一个选项的 providerLabel', () => {
    const groups = groupComposerModels([opt('zhipu:a', '智谱 GLM'), opt('zhipu:b', '智谱 GLM')])
    expect(groups[0].providerLabel).toBe('智谱 GLM')
  })

  test('空输入 → 空分组（选择器据此整个不渲染）', () => {
    expect(groupComposerModels([])).toEqual([])
  })
})
