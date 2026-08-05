// 模型元数据目录查表（08-05 dogfood-3）。
//
// 这一层是「模型选择器上到底显示什么」的唯一事实来源，且它的失败模式是**静默的**：
// 查错一家 → 屏幕上出现一个看起来很正常、实际差几倍的上下文数字。故本文件盯三件事：
//   1. **有序链**必须赢（同一个 id 在多家出现时不许随便挑一家）；
//   2. **归一化**只在精确全部落空之后才用，且要标 `match:'normalized'`（推断 ≠ 事实）；
//   3. **查不到就是 null**（降级），绝不猜。
//
// ⚠️ 少数用例直接吃 `catalog.json` 真快照（它是 `sync-model-catalog.mjs` 的生成物，会定期
// 覆写）。这些用例**只断言「命中 + 数量级」**，不写死具体数字 —— 上游改一次 context 就红一次
// 的测试没人会维护。真要防的回归（链顺序 / 归一化 / 歧义守卫）全部用不依赖快照的方式表达。

import { describe, expect, test } from 'vitest'

import catalogJson from '@shared/modelCatalog/catalog.json'
import {
  LOCAL_CATALOG_OVERRIDES,
  MODEL_CATALOG_GENERATED_AT,
  PREFERRED_CATALOG_PROVIDERS,
  lookupModelMeta,
  normalizeCatalogModelId,
  resetModelCatalogCaches
} from '@shared/modelCatalog/lookup'

const catalog = catalogJson as unknown as {
  providers: Record<string, { name: string; models: Record<string, unknown> }>
}

describe('normalizeCatalogModelId', () => {
  test.each([
    ['claude-opus-5[1m]', 'claude-opus-5'],
    ['claude-opus-5[200k]', 'claude-opus-5'],
    ['openai/gpt-4o', 'gpt-4o'],
    ['deepseek/deepseek-chat[1m]', 'deepseek-chat'],
    ['  GPT-4O  ', 'gpt-4o'],
    ['plain-id', 'plain-id']
  ])('%s → %s', (input, expected) => {
    expect(normalizeCatalogModelId(input)).toBe(expected)
  })

  test('方括号只剥**尾部**那一个（id 中间的方括号不是档位标记）', () => {
    expect(normalizeCatalogModelId('a[b]c')).toBe('a[b]c')
  })
})

describe('lookupModelMeta — 命中与降级', () => {
  test('目录里没有的 id → null（静默降级，不猜不编）', () => {
    expect(lookupModelMeta('totally-made-up-model-x9', 'anthropic')).toBeNull()
    expect(lookupModelMeta('totally-made-up-model-x9', null)).toBeNull()
  })

  test('空 id → null（不去撞全局索引里的空键）', () => {
    expect(lookupModelMeta('', 'anthropic')).toBeNull()
    expect(lookupModelMeta('   ', 'anthropic')).toBeNull()
  })

  test('精确命中标 exact，且 matchedModelId 就是传入的 id', () => {
    const m = lookupModelMeta('claude-sonnet-4-6', 'anthropic')
    expect(m?.match).toBe('exact')
    expect(m?.matchedModelId).toBe('claude-sonnet-4-6')
    expect(m?.catalogProviderId).toBe('anthropic')
    expect(m?.contextWindow).toBeGreaterThan(0)
  })

  test('🔴 归一化命中标 normalized（中转把档位写进 id → 拿到的是厂商官方值，不是这家的配额）', () => {
    const m = lookupModelMeta('claude-sonnet-4-6[1m]', 'anthropic')
    expect(m?.match).toBe('normalized')
    expect(m?.matchedModelId).toBe('claude-sonnet-4-6')
  })

  test('OpenRouter 的 `vendor/model` wire id 剥前缀后落到厂商自己那家', () => {
    const m = lookupModelMeta('anthropic/claude-sonnet-4-6', 'openrouter')
    expect(m?.catalogProviderId).toBe('anthropic')
    expect(m?.match).toBe('normalized')
  })
})

describe('lookupModelMeta — 🔴 有序链，不是全局乱查', () => {
  test('protocol 决定先看哪家：同一个 id 在链上靠前那家赢', () => {
    // deepseek 的模型在 alibaba-cn 也有一份（中转转的），protocol=deepseek 必须落到 deepseek。
    expect(catalog.providers['alibaba-cn'].models['deepseek-v4-flash']).toBeTruthy()
    expect(catalog.providers.deepseek.models['deepseek-v4-flash']).toBeTruthy()
    expect(lookupModelMeta('deepseek-v4-flash', 'deepseek')?.catalogProviderId).toBe('deepseek')
    // openai-compatible 的链里 deepseek 排在 alibaba-cn 前面 → 同样落 deepseek。
    expect(lookupModelMeta('deepseek-v4-flash', 'openai-compatible')?.catalogProviderId).toBe(
      'deepseek'
    )
  })

  test('🔴 protocol=null 时只接受全局唯一的 id（有歧义宁可不显示）', () => {
    // 上面那个 id 有两家都有 → 无 protocol 时判为歧义，返回 null。
    expect(lookupModelMeta('deepseek-v4-flash', null)).toBeNull()
    // 只有一家有的 id 才允许全局回退。
    expect(lookupModelMeta('claude-sonnet-4-6', null)?.catalogProviderId).toBe('anthropic')
  })

  test('能逐字命中的 id 必须标 exact（不许无缘无故降级成推断）', () => {
    expect(lookupModelMeta('gpt-4o', 'openai')?.match).toBe('exact')
  })

  test('🔴 全链精确先于全链归一（链上靠前那家的**推断**命中不许盖过靠后那家的**逐字**命中）', () => {
    // 这条是「两遍扫」与「逐级 先精确再归一」唯一分得开的地方，故要构造判别式用例：
    //   链 openai-compatible = [openai(0), anthropic(1), …]
    //   查 `zzz-vendor/zzz-probe`：openai 只有归一后的 `zzz-probe`，anthropic 有逐字那个。
    // 两遍扫 → anthropic / exact（逐字是事实）。逐级 → openai / normalized（把推断说成结论，
    // 且落到了错误的一家）。用覆盖表构造而不是挑快照里的真 id：快照是生成物会被覆写。
    LOCAL_CATALOG_OVERRIDES.openai = {
      name: 'OpenAI',
      models: { 'zzz-probe': { name: '归一命中（靠前那家）', context: 1000 } }
    }
    LOCAL_CATALOG_OVERRIDES.anthropic = {
      name: 'Anthropic',
      models: { 'zzz-vendor/zzz-probe': { name: '逐字命中（靠后那家）', context: 2000 } }
    }
    resetModelCatalogCaches()
    try {
      const m = lookupModelMeta('zzz-vendor/zzz-probe', 'openai-compatible')
      expect(m?.catalogProviderId).toBe('anthropic')
      expect(m?.match).toBe('exact')
      expect(m?.contextWindow).toBe(2000)
    } finally {
      delete LOCAL_CATALOG_OVERRIDES.openai
      delete LOCAL_CATALOG_OVERRIDES.anthropic
      resetModelCatalogCaches()
    }
  })

  test('链里列到的 provider 必须真的在快照里（漏收一家 = 整条链静默失效）', () => {
    const referenced = new Set(Object.values(PREFERRED_CATALOG_PROVIDERS).flat())
    // openrouter 是有意不收的聚合器，它的链里也就没有它自己。
    expect(referenced.has('openrouter')).toBe(false)
    for (const pid of referenced) {
      expect(catalog.providers[pid], `链里引用了快照里没有的 provider: ${pid}`).toBeTruthy()
    }
  })
})

describe('lookupModelMeta — owner 机器上启用中的 10 个模型（命中率闸）', () => {
  // 来自 08-05 只读调研对 owner `agent_config.db` 的实测：3 家 provider（全是中转）× 10 个
  // 启用中的模型。这是「引入目录到底解决了多少」的唯一硬指标 —— 首版 W8 在这台机器上
  // capabilities/display_name 是 90 行全 NULL，一个 badge 都渲染不出来。
  const OWNER_MODELS: Array<[string, 'anthropic' | 'deepseek' | 'openai-compatible']> = [
    ['deepseek-v4-flash', 'deepseek'],
    ['deepseek-v4-pro', 'deepseek'],
    ['claude-fable-5[1m]', 'anthropic'],
    ['claude-haiku-4-5-20251001', 'anthropic'],
    ['claude-opus-4-6', 'anthropic'],
    ['claude-opus-5[1m]', 'anthropic'],
    ['claude-sonnet-5[1m]', 'anthropic'],
    ['gpt-5.6-luna', 'openai-compatible'],
    ['gpt-5.6-sol', 'openai-compatible'],
    ['gpt-5.6-terra', 'openai-compatible']
  ]

  test.each(OWNER_MODELS)('%s (%s) 命中且带全套展示字段', (modelId, protocol) => {
    const m = lookupModelMeta(modelId, protocol)
    expect(m, `${modelId} 未命中 —— 命中率闸破了`).not.toBeNull()
    expect(m!.displayName.length).toBeGreaterThan(0)
    // 只断量级不断具体值：上游改一次数字就红一次的测试没人维护。
    expect(m!.contextWindow).toBeGreaterThan(100_000)
    expect(m!.maxOutput).toBeGreaterThan(1000)
    expect(m!.capabilities?.tools).toBe(true)
  })

  test('三家中转的 protocol 都能落到 canonical 厂商（不是落到某个中转商）', () => {
    expect(lookupModelMeta('gpt-5.6-sol', 'openai-compatible')?.catalogProviderId).toBe('openai')
    expect(lookupModelMeta('claude-opus-5[1m]', 'anthropic')?.catalogProviderId).toBe('anthropic')
    expect(lookupModelMeta('deepseek-v4-pro', 'deepseek')?.catalogProviderId).toBe('deepseek')
  })
})

describe('LOCAL_CATALOG_OVERRIDES — 覆盖表扩展位', () => {
  test('覆盖表叠在快照之上（同 provider 同 id 时它赢），并参与有序链', () => {
    LOCAL_CATALOG_OVERRIDES.anthropic = {
      name: 'Anthropic',
      models: { 'claude-sonnet-4-6': { name: '我覆盖的名字', context: 42 } }
    }
    resetModelCatalogCaches()
    try {
      const m = lookupModelMeta('claude-sonnet-4-6', 'anthropic')
      expect(m?.displayName).toBe('我覆盖的名字')
      expect(m?.contextWindow).toBe(42)
    } finally {
      delete LOCAL_CATALOG_OVERRIDES.anthropic
      resetModelCatalogCaches()
    }
  })

  test('覆盖表可以补快照里根本没有的家（已知缺口：豆包/火山）', () => {
    LOCAL_CATALOG_OVERRIDES.doubao = {
      name: '豆包',
      models: { 'doubao-pro-x': { name: 'Doubao Pro X', context: 256_000 } }
    }
    resetModelCatalogCaches()
    try {
      const m = lookupModelMeta('doubao-pro-x', null)
      expect(m?.catalogProviderName).toBe('豆包')
      expect(m?.contextWindow).toBe(256_000)
    } finally {
      delete LOCAL_CATALOG_OVERRIDES.doubao
      resetModelCatalogCaches()
    }
  })

  test('默认是空的（有东西了说明有人往生成物旁边塞了私货而没写清理由）', () => {
    expect(Object.keys(LOCAL_CATALOG_OVERRIDES)).toEqual([])
  })
})

describe('catalog.json 快照本身', () => {
  test('🔴 一家中转/聚合器都不收（收了就会出现「同 id 不同值」的随机命中）', () => {
    for (const aggregator of ['openrouter', 'nano-gpt', 'aihubmix', 'vercel', 'opencode']) {
      expect(catalog.providers[aggregator], `快照收了聚合器 ${aggregator}`).toBeUndefined()
    }
  })

  test('规模在预期量级（异常缩水 = sync 脚本挂了但产物还在，静默丢元数据）', () => {
    const rows = Object.values(catalog.providers).reduce(
      (n, p) => n + Object.keys(p.models).length,
      0
    )
    expect(Object.keys(catalog.providers).length).toBeGreaterThanOrEqual(15)
    expect(rows).toBeGreaterThan(300)
  })

  test('带生成日期（NOTICE 要求：快照必须能说清自己是哪天的）', () => {
    expect(MODEL_CATALOG_GENERATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
