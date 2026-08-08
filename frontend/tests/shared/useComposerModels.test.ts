// useComposerModels 的纯函数面（W8 / task 08-04 WP2）—— 富元数据合成与分组。
//
// 覆盖的是「元数据缺失时不许退化成空洞或谎话」这条：provider 表拉不到 / 某个 model 行不存在，
// 选择器仍必须显示得出这个模型，而不是空白行。另外钉住 providerRef 的切分口径与 Settings/
// 抽屉的 groupModelRefs 一致（default 恒最前、组内保持 enabledModels 原顺序），否则两处列表
// 顺序会莫名不同。
//
// 🔴 08-05 起多了一层 models.dev 目录兜底，本文件因此分两组断言：
//   - **注入桩 lookup** 的用例测「行 vs 目录」的优先级与降级 —— 桩让断言不跟着快照内容漂移
//     （catalog.json 是生成物，`sync-model-catalog.mjs` 会定期覆写它）。
//   - **真快照** 的用例只在 modelCatalog/lookup.test.ts 里，且只断言「命中 + 数量级合理」。

import { describe, expect, test, vi } from 'vitest'

import {
  buildComposerModelOption,
  composeComposerModelOption,
  groupComposerModels,
  type ComposerModelMeta,
  type ComposerModelOption,
  type ComposerProviderMeta,
  type ModelCatalogLookup
} from '@shared/hooks/useComposerModels'
// 切分规则的单源在 useLlmProviders（与 Settings 的 groupModelRefs 同一个函数）——composer
// 侧只是复用，故这里也从单源 import，防有人日后在 composer 侧又抄一份。
import { refProviderId } from '@shared/hooks/useLlmProviders'
import type { CatalogModelMeta } from '@shared/modelCatalog/lookup'

const NO_PROVIDERS: ComposerProviderMeta = new Map()
const NO_MODELS: ComposerModelMeta = new Map()

/** 目录恒未命中（= 引入目录之前的世界）。 */
const NO_CATALOG: ModelCatalogLookup = () => null

function catalogMeta(over: Partial<CatalogModelMeta> = {}): CatalogModelMeta {
  return {
    displayName: '目录全名',
    description: null,
    contextWindow: 200_000,
    maxOutput: 8000,
    capabilities: { tools: true },
    cost: null,
    releasedAt: null,
    knowledgeCutoff: null,
    deprecated: false,
    catalogProviderId: 'anthropic',
    catalogProviderName: 'Anthropic',
    match: 'exact',
    matchedModelId: 'x',
    ...over
  }
}

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
  test('行查不到 + 目录也未命中 → 退回裸 id 一行（与引入目录之前逐字一样）', () => {
    const o = buildComposerModelOption(
      'anthropic:claude-sonnet-4-6',
      NO_PROVIDERS,
      NO_MODELS,
      NO_CATALOG
    )
    expect(o).toMatchObject({
      ref: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
      providerLabel: null,
      protocol: null,
      modelId: 'claude-sonnet-4-6',
      displayName: 'claude-sonnet-4-6',
      capabilities: null,
      maxOutput: null,
      contextWindow: null,
      catalogMeta: null
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
    expect(buildComposerModelOption('m', NO_PROVIDERS, models, NO_CATALOG).displayName).toBe('m')
  })

  test('同名 model id 分属不同 provider 时互不串味（嵌套 Map 按 provider 分桶）', () => {
    const models = modelMeta([
      ['a', 'gpt-4o', { displayName: 'A 家的 GPT-4o' }],
      ['b', 'gpt-4o', { displayName: 'B 家的 GPT-4o', maxOutput: 8000 }]
    ])
    expect(buildComposerModelOption('a:gpt-4o', NO_PROVIDERS, models, NO_CATALOG).displayName).toBe(
      'A 家的 GPT-4o'
    )
    expect(buildComposerModelOption('b:gpt-4o', NO_PROVIDERS, models, NO_CATALOG).maxOutput).toBe(
      8000
    )
  })

  test('🔴 含 "/" 的 wire id（OpenRouter）查得到 —— 这正是不用复合字符串 key 的理由', () => {
    const models = modelMeta([['openrouter', 'openai/gpt-4o', { displayName: 'GPT-4o (OR)' }]])
    expect(
      buildComposerModelOption('openrouter:openai/gpt-4o', NO_PROVIDERS, models, NO_CATALOG)
        .displayName
    ).toBe('GPT-4o (OR)')
  })
})

describe('composeComposerModelOption — 🔴 DB 行权威、目录兜底', () => {
  const base = {
    ref: 'anthropic:x',
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    protocol: 'anthropic' as const,
    modelId: 'x',
    rowDisplayName: null,
    rowCapabilities: null,
    rowMaxOutput: null,
    rowContextWindow: null
  }

  test('行留白 → 目录填上（这正是 owner 机器上 90 行全 NULL 的那个场景）', () => {
    const o = composeComposerModelOption(base, () => catalogMeta())
    expect(o.displayName).toBe('目录全名')
    expect(o.capabilities).toEqual({ tools: true })
    expect(o.maxOutput).toBe(8000)
    expect(o.contextWindow).toBe(200_000)
  })

  test('🔴 行里手填过的值恒赢目录（否则「在 Settings 改了没用」）', () => {
    const o = composeComposerModelOption(
      {
        ...base,
        rowDisplayName: '我改的名',
        rowCapabilities: { vision: true },
        rowMaxOutput: 4096
      },
      () => catalogMeta()
    )
    expect(o.displayName).toBe('我改的名')
    expect(o.maxOutput).toBe(4096)
    // 整体二选一，不逐键合并 —— 目录的 tools:true 不许渗进来（未知/false/true 三态要分得清）。
    expect(o.capabilities).toEqual({ vision: true })
  })

  test('contextWindow 由 DB 行优先，目录只作兜底', () => {
    expect(composeComposerModelOption(base, NO_CATALOG).contextWindow).toBeNull()
    expect(composeComposerModelOption(base, () => catalogMeta()).contextWindow).toBe(200_000)
    expect(
      composeComposerModelOption({ ...base, rowContextWindow: 131_072 }, () => catalogMeta())
        .contextWindow
    ).toBe(131_072)
  })

  test('目录未命中 → catalogMeta=null（hover 卡据此整个不挂）', () => {
    expect(composeComposerModelOption(base, NO_CATALOG).catalogMeta).toBeNull()
  })

  test('查表用的是「裸 modelId + protocol」，不是完整 ref（ref 里的 providerId 是用户 slug）', () => {
    const spy = vi.fn(() => null)
    composeComposerModelOption({ ...base, modelId: 'x', ref: 'my-relay:x' }, spy)
    expect(spy).toHaveBeenCalledWith('x', 'anthropic')
  })
})

function opt(ref: string, providerLabel: string | null = null): ComposerModelOption {
  return { ...buildComposerModelOption(ref, NO_PROVIDERS, NO_MODELS, NO_CATALOG), providerLabel }
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
