// WP-16a effort 内核 —— 档位词表 / 每协议子集 / 家族阶梯查询（16b composer 菜单的数据源）。
//
// 盯四件事：
//   1. **每个协议只暴露自己的可表达子集**（google/openrouter 无 max —— 验收项，逐协议钉死）；
//   2. **阶梯归属按 catalog 厂商家族、不按 protocol**（ae53df4c 教训：owner 的中转一个
//      provider 混装多家 —— claude-* 挂在 openai-compatible 上也必须给 Claude 阶梯）；
//   3. **无 reasoning cap → 仅 ['none']**；catalog 未标注 = unknown（null）≠ false，不灰死；
//   4. 覆写位走「DB 行权威、目录兜底」（布尔覆写赢，null/缺席落回 catalog）。
//
// ⚠️ 家族判定用例吃 catalog.json 真快照（定期覆写的生成物）——只挑长寿命 id
// （claude-sonnet-4-6 / gpt-4o / gemini-2.5-pro / deepseek-chat），只断言家族与档位集合，
// 不断言快照里的易变字段。

import { afterEach, describe, expect, test } from 'vitest'

import {
  effortOptionsForModel,
  EFFORT_PREF_KEY,
  readEffortPref,
  writeEffortPref
} from '@shared/modelCatalog/effort'
import {
  clampEffortToProtocol,
  EFFORT_TIERS,
  effortTierIndex,
  isEffortTier,
  PROTOCOL_EFFORT_TIERS
} from '@shared/modelCatalog/effortTiers'

describe('effort 词表（canonical 有序枚举）', () => {
  test('none < low < medium < high < xhigh < max（owner 拍板的 canonical 序）', () => {
    expect(EFFORT_TIERS).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortTierIndex('none')).toBe(0)
    expect(effortTierIndex('max')).toBe(5)
  })

  test('isEffortTier 只认 canonical 值（大小写敏感，垃圾值/布尔全拒）', () => {
    for (const t of EFFORT_TIERS) expect(isEffortTier(t)).toBe(true)
    expect(isEffortTier('Medium')).toBe(false)
    expect(isEffortTier('extra')).toBe(false) // owner 口中的 extra = xhigh，wire 上不存在 extra
    expect(isEffortTier('minimal')).toBe(false) // ai@7 统一枚举有它，我们的阶梯没有
    expect(isEffortTier(true)).toBe(false)
    expect(isEffortTier(undefined)).toBe(false)
    expect(isEffortTier(null)).toBe(false)
  })
})

describe('每协议可表达子集（验收项：逐协议钉死）', () => {
  test('anthropic / openai / deepseek / openai-compatible → 全 6 档', () => {
    for (const p of ['anthropic', 'openai', 'deepseek', 'openai-compatible'] as const) {
      expect(PROTOCOL_EFFORT_TIERS[p]).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    }
  })

  test('google / openrouter → 无 max（统一 reasoning 参数 / openrouter effort 枚举到 xhigh 为止）', () => {
    for (const p of ['google', 'openrouter'] as const) {
      expect(PROTOCOL_EFFORT_TIERS[p]).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    }
  })

  test('clamp：不可表达的档向下取最近可表达档（max→xhigh），可表达的原样', () => {
    expect(clampEffortToProtocol('max', 'google')).toBe('xhigh')
    expect(clampEffortToProtocol('max', 'openrouter')).toBe('xhigh')
    expect(clampEffortToProtocol('max', 'anthropic')).toBe('max')
    expect(clampEffortToProtocol('none', 'google')).toBe('none')
    expect(clampEffortToProtocol('high', null)).toBe('high')
  })
})

describe('effortOptionsForModel — 家族阶梯 ∩ 协议子集', () => {
  test('Claude manual 族（sonnet-4-6）@ anthropic → none/low/medium/high，默认 medium（S2 拍板：无 xhigh/max）', () => {
    const r = effortOptionsForModel('claude-sonnet-4-6', 'anthropic')
    expect(r).toEqual({
      options: ['none', 'low', 'medium', 'high'],
      applicable: true,
      defaultTier: 'medium',
      family: 'anthropic',
      reasoningCapable: true,
      passthroughUnknown: false // ③ 厂商已知（anthropic）且方言即协议原生：同族直通
    })
  })

  test('Claude adaptive 族（opus-4-7/4-8/opus-5/fable）@ anthropic → low..max，默认 medium，无 none（服务端自适应）', () => {
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-fable-5']) {
      const r = effortOptionsForModel(id, 'anthropic')
      expect(r.options, id).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(r.defaultTier, id).toBe('medium')
      expect(r.family, id).toBe('anthropic')
    }
  })

  test('OpenAI GPT @ openai-compatible（owner 的 gpt-crs 腿）→ 全 6 档，默认 medium，同方言不告警', () => {
    const r = effortOptionsForModel('gpt-5.6-sol', 'openai-compatible')
    expect(r.options).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(r.defaultTier).toBe('medium')
    expect(r.family).toBe('openai')
    expect(r.passthroughUnknown).toBe(false)
  })

  test('OpenAI GPT @ openrouter → max 被协议子集裁掉（映射不到的档不出现）', () => {
    const r = effortOptionsForModel('gpt-5.6-sol', 'openrouter')
    expect(r.options).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(r.defaultTier).toBe('medium')
  })

  test('claude-*[1m] 挂 openai-compatible 中转 → 归一化命中 anthropic 家族（阶梯按厂商不按协议）+ 方言错配诚实告警', () => {
    const r = effortOptionsForModel('claude-opus-5[1m]', 'openai-compatible')
    expect(r.family).toBe('anthropic')
    expect(r.options).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(r.passthroughUnknown).toBe(true) // anthropic 家族 ≠ openai 方言：中转必须翻译，不可知
  })

  test('Gemini @ google → low/medium/high，默认 low', () => {
    const r = effortOptionsForModel('gemini-2.5-pro', 'google')
    expect(r.options).toEqual(['low', 'medium', 'high'])
    expect(r.defaultTier).toBe('low')
    expect(r.family).toBe('google')
  })

  test('Deepseek @ deepseek → none/low/high/max，默认 low', () => {
    const r = effortOptionsForModel('deepseek-v4-pro', 'deepseek')
    expect(r.options).toEqual(['none', 'low', 'high', 'max'])
    expect(r.defaultTier).toBe('low')
    expect(r.family).toBe('deepseek')
  })

  test('未知厂商（catalog 全 miss）→ other 阶梯 none/low/medium/high/max，默认 medium，unknown 能力位', () => {
    const r = effortOptionsForModel('mystery-relay-model-z9', 'openai-compatible')
    expect(r).toEqual({
      options: ['none', 'low', 'medium', 'high', 'max'],
      applicable: true,
      defaultTier: 'medium',
      family: 'other',
      reasoningCapable: null,
      passthroughUnknown: true // ① 目录未命中：不知道对面是谁，谈不上「透传已知」
    })
  })

  test('三段式②：厂商已知但方言不可判（qwen/alibaba）@ openai-compatible → passthroughUnknown 诚实置 true', () => {
    // 复核收紧前的旧判据（family !== 'other'）把这类「目录命中但非四大方言家族」当成透传已知 ——
    // 结论碰巧对不了：我们并不知道 alibaba 的原生 reasoning 方言是什么、上游拿到 reasoning_effort
    // 会怎么处理。阶梯照给（other 家族），只有诚实位翻 true。
    const r = effortOptionsForModel('qwen-plus', 'openai-compatible')
    expect(r.family).toBe('other')
    expect(r.reasoningCapable).toBe(true) // alibaba/qwen-plus 在目录里带 reasoning cap
    expect(r.options).toEqual(['none', 'low', 'medium', 'high', 'max'])
    expect(r.passthroughUnknown).toBe(true)
  })

  test('openrouter carve-out：四大家族 → false（文档承诺归一）；目录 miss 仍走① → true', () => {
    expect(effortOptionsForModel('gpt-5.6-sol', 'openrouter').passthroughUnknown).toBe(false)
    expect(effortOptionsForModel('claude-sonnet-4-6', 'openrouter').passthroughUnknown).toBe(false)
    expect(effortOptionsForModel('mystery-relay-model-z9', 'openrouter').passthroughUnknown).toBe(
      true
    )
  })

  test('验收项：无 reasoning cap（catalog 标注了 caps 但不含 reasoning）→ 仅 [none] 且 applicable=false', () => {
    for (const [id, protocol] of [
      ['gpt-4o', 'openai'],
      ['gpt-image-2', 'openai'],
      ['deepseek-chat', 'deepseek']
    ] as const) {
      const r = effortOptionsForModel(id, protocol)
      expect(r.options, id).toEqual(['none'])
      // 16b 硬契约：applicable=false ⇒ 请求体不带 effort 键（连 'none' 也不塞）——
      // openai chat-completions 分支会无条件下发 reasoning_effort，deepseek 会多发
      // thinking:{type:'disabled'}，结构性挡在查询接口这一层。
      expect(r.applicable, id).toBe(false)
      expect(r.defaultTier, id).toBe('none')
      expect(r.reasoningCapable, id).toBe(false)
    }
  })

  test('applicable 与「options 退化成 [none]」严格互锁（能力在 → true，能力灭 → false）', () => {
    expect(effortOptionsForModel('claude-sonnet-4-6', 'anthropic').applicable).toBe(true)
    expect(effortOptionsForModel('deepseek-v4-pro', 'deepseek').applicable).toBe(true)
    // unknown 能力位（null）不灭控件（unknown ≠ false）
    expect(effortOptionsForModel('claude-3-haiku-20240307', 'anthropic').applicable).toBe(true)
    expect(
      effortOptionsForModel('claude-sonnet-4-6', 'anthropic', { reasoningCapable: false })
        .applicable
    ).toBe(false)
  })

  test('catalog 有模型但无 caps 标注 → reasoningCapable null（unknown ≠ false），阶梯照给（haiku = manual 族）', () => {
    const r = effortOptionsForModel('claude-3-haiku-20240307', 'anthropic')
    expect(r.reasoningCapable).toBeNull()
    expect(r.options).toEqual(['none', 'low', 'medium', 'high'])
  })

  test('覆写位（DB 行权威）：布尔覆写赢 catalog；null/缺席落回 catalog', () => {
    // 行说 reasoning=false → catalog 的 true 被压掉
    expect(
      effortOptionsForModel('claude-sonnet-4-6', 'anthropic', { reasoningCapable: false }).options
    ).toEqual(['none'])
    // 行说 reasoning=true → catalog 的 false 被压掉
    expect(effortOptionsForModel('gpt-4o', 'openai', { reasoningCapable: true }).options).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    // 行未标注（null）→ 落回 catalog（false → ['none']）
    expect(effortOptionsForModel('gpt-4o', 'openai', { reasoningCapable: null }).options).toEqual([
      'none'
    ])
  })

  test('不变式：暴露给用户的档恒 ∈ 协议可表达子集（clamp 只该发生在 wire 层，UI 里不该出现会被降档的档）', () => {
    // 🔴 S2 后 anthropic 是**双梯**，两族都要在这张表里（否则不变式只覆盖一半）：
    // sonnet-4-6 = manual 梯（none/low/medium/high）；opus-4-8 与 opus-5[1m] = adaptive 梯
    // （low..max，后者还顺带覆盖带档位后缀的中转 id）。
    const models = [
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-opus-5[1m]',
      'gpt-5.6-sol',
      'gpt-4o',
      'gemini-2.5-pro',
      'deepseek-v4-pro',
      'mystery-relay-model-z9'
    ] as const
    for (const protocol of Object.keys(PROTOCOL_EFFORT_TIERS) as Array<
      keyof typeof PROTOCOL_EFFORT_TIERS
    >) {
      for (const id of models) {
        for (const tier of effortOptionsForModel(id, protocol).options) {
          expect(PROTOCOL_EFFORT_TIERS[protocol], `${id}@${protocol}`).toContain(tier)
          // clamp 对已暴露的档必须是恒等（否则 UI 显示的档与实际发出的档不一致 = 撒谎）
          expect(clampEffortToProtocol(tier, protocol), `${id}@${protocol}:${tier}`).toBe(tier)
        }
      }
    }
  })

  test('defaultTier 恒 ∈ options（契约：16b 直接拿去当选中态）', () => {
    for (const [id, protocol] of [
      ['claude-sonnet-4-6', 'anthropic'],
      ['gpt-5.6-sol', 'openrouter'],
      ['gemini-2.5-pro', 'google'],
      ['deepseek-v4-pro', 'deepseek'],
      ['gpt-4o', 'openai'],
      ['mystery-relay-model-z9', null]
    ] as const) {
      const r = effortOptionsForModel(id, protocol)
      expect(r.options, id).toContain(r.defaultTier)
    }
  })
})

describe('effort 持久化（照抄 Brain 布尔的 localStorage 机制）', () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage
    } else {
      ;(globalThis as { localStorage?: Storage }).localStorage = original
    }
  })

  function stubStorage(): Map<string, string> {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    }
    return store
  }

  test('round-trip：写档位 → 读回；写 null → 键删除 → 读 null', () => {
    const store = stubStorage()
    writeEffortPref('xhigh')
    expect(store.get(EFFORT_PREF_KEY)).toBe('xhigh')
    expect(readEffortPref()).toBe('xhigh')
    writeEffortPref(null)
    expect(store.has(EFFORT_PREF_KEY)).toBe(false)
    expect(readEffortPref()).toBeNull()
  })

  test('存量垃圾值 → null（不把非法字符串放进请求体）', () => {
    const store = stubStorage()
    store.set(EFFORT_PREF_KEY, 'turbo-max-plus')
    expect(readEffortPref()).toBeNull()
  })

  test('无 localStorage 环境（node / 隐私模式）→ 读 null 写 no-op，不抛', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    expect(readEffortPref()).toBeNull()
    expect(() => writeEffortPref('high')).not.toThrow()
  })
})
