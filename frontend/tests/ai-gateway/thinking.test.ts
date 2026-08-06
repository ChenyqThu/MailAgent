// chat-panel P4 composer-parity C1-① — gateway extended-thinking provider options.
// Pins the model-family matrix (mirror of legacy custom_api.ts): sonnet/older → manual budget,
// opus-4-7/4-8/fable → adaptive + effort (manual budget would 400). enabled=false → undefined so
// the caller omits providerOptions entirely (byte-identical to the no-thinking streamText call).
//
// WP-16a — effortCallOptions 的每协议 wire 形状也钉在这里（与旧布尔路径并存，互不改判）：
// anthropic 沿现有二分（manual 族 budgetTokens 数值映射 / adaptive 族 effort 枚举），openai
// reasoningEffort 逐字，deepseek thinking+reasoningEffort，openai-compatible 走协议通用键
// 'openaiCompatible'，openrouter reasoning.effort（max clamp 到 xhigh），google 走 ai@7 统一
// reasoning 参数（不出 providerOptions）。

import { describe, expect, test } from 'vitest'

import {
  effortCallOptions,
  effortTierFromBody,
  MANUAL_THINKING_BUDGET_TOKENS,
  thinkingProviderOptions
} from '../../src/ai-gateway/thinking'

describe('thinkingProviderOptions', () => {
  test('enabled=false → undefined (providerOptions omitted, byte-identical to no-thinking)', () => {
    expect(thinkingProviderOptions('claude-sonnet-4-6', false)).toBeUndefined()
    expect(thinkingProviderOptions('claude-opus-4-8', false)).toBeUndefined()
    expect(thinkingProviderOptions('gpt-5.5', false)).toBeUndefined()
  })

  test('sonnet / older Claude → manual { type: enabled, budgetTokens }', () => {
    expect(thinkingProviderOptions('claude-sonnet-4-6', true)).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 16_000 } }
    })
  })

  test('opus-4-7 / opus-4-8 / fable → adaptive + effort (manual budget would HTTP 400)', () => {
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5']) {
      expect(thinkingProviderOptions(model, true)).toEqual({
        anthropic: { thinking: { type: 'adaptive' }, effort: 'high' }
      })
    }
  })

  test('model matching is case-insensitive', () => {
    expect(thinkingProviderOptions('CLAUDE-OPUS-4-8', true)).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' }
    })
    expect(thinkingProviderOptions('Claude-Sonnet-4-6', true)).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 16_000 } }
    })
  })

  test.each(['openai', 'openai-compatible', 'deepseek', 'google', 'openrouter'] as const)(
    '%s protocol → undefined (Anthropic providerOptions omitted)',
    (protocol) => {
      expect(thinkingProviderOptions('any-model', true, protocol)).toBeUndefined()
    }
  )
})

describe('effortTierFromBody（请求体窄化：缺席/垃圾 → null → 旧布尔路径）', () => {
  test('合法档位字符串 → 原样', () => {
    expect(effortTierFromBody('none')).toBe('none')
    expect(effortTierFromBody('medium')).toBe('medium')
    expect(effortTierFromBody('max')).toBe('max')
  })

  test('缺席 / 布尔 / 非法字符串 → null（恶意 body 不能造出新 wire 形状）', () => {
    expect(effortTierFromBody(undefined)).toBeNull()
    expect(effortTierFromBody(null)).toBeNull()
    expect(effortTierFromBody(true)).toBeNull()
    expect(effortTierFromBody('EXTRA')).toBeNull()
    expect(effortTierFromBody('minimal')).toBeNull()
  })
})

describe('effortCallOptions — anthropic（沿现有二分）', () => {
  test('manual 族（sonnet-4-6）→ budgetTokens 数值映射（验收项：逐档钉死）', () => {
    const expected = { low: 4_000, medium: 16_000, high: 32_000, xhigh: 48_000, max: 60_000 }
    for (const [tier, budget] of Object.entries(expected) as [keyof typeof expected, number][]) {
      expect(effortCallOptions('claude-sonnet-4-6', tier, 'anthropic')).toEqual({
        providerOptions: {
          anthropic: { thinking: { type: 'enabled', budgetTokens: budget } }
        }
      })
    }
    expect(MANUAL_THINKING_BUDGET_TOKENS).toEqual(expected)
  })

  test('manual 族 medium ≡ 旧 Brain 布尔开（16k）—— 观感连续契约', () => {
    expect(effortCallOptions('claude-sonnet-4-6', 'medium', 'anthropic')?.providerOptions).toEqual(
      thinkingProviderOptions('claude-sonnet-4-6', true)
    )
  })

  test('adaptive 族（opus-4-7 / opus-4-8 / fable）→ adaptive + effort 档位逐字（manual budget 会 400）', () => {
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5']) {
      for (const tier of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
        expect(effortCallOptions(model, tier, 'anthropic')).toEqual({
          providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: tier } }
        })
      }
    }
  })

  test('none → undefined（与 Brain 关字节一致：不发任何 thinking 配置）', () => {
    expect(effortCallOptions('claude-sonnet-4-6', 'none', 'anthropic')).toBeUndefined()
    expect(effortCallOptions('claude-fable-5', 'none', 'anthropic')).toBeUndefined()
  })
})

describe('effortCallOptions — 其余协议', () => {
  test('openai → reasoningEffort 逐字（含显式 none —— gpt-5.1+ 的合法关断值）', () => {
    for (const tier of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(effortCallOptions('gpt-5.6-sol', tier, 'openai')).toEqual({
        providerOptions: { openai: { reasoningEffort: tier } }
      })
    }
  })

  test('deepseek → none 关 thinking；档位 = thinking enabled + reasoningEffort', () => {
    expect(effortCallOptions('deepseek-v4-pro', 'none', 'deepseek')).toEqual({
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } }
    })
    for (const tier of ['low', 'high', 'max'] as const) {
      expect(effortCallOptions('deepseek-v4-pro', tier, 'deepseek')).toEqual({
        providerOptions: {
          deepseek: { thinking: { type: 'enabled' }, reasoningEffort: tier }
        }
      })
    }
  })

  test('openai-compatible → 协议通用键 openaiCompatible（与 provider 行 id 解耦）；none → 不发', () => {
    expect(effortCallOptions('gpt-5.6-sol', 'high', 'openai-compatible')).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: 'high' } }
    })
    expect(effortCallOptions('gpt-5.6-sol', 'max', 'openai-compatible')).toEqual({
      providerOptions: { openaiCompatible: { reasoningEffort: 'max' } }
    })
    expect(effortCallOptions('gpt-5.6-sol', 'none', 'openai-compatible')).toBeUndefined()
  })

  test('openrouter → reasoning.effort；max clamp 到 xhigh（其枚举无 max）', () => {
    expect(effortCallOptions('gpt-5.6-sol', 'high', 'openrouter')).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: 'high' } } }
    })
    expect(effortCallOptions('gpt-5.6-sol', 'max', 'openrouter')).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: 'xhigh' } } }
    })
    expect(effortCallOptions('gpt-5.6-sol', 'none', 'openrouter')).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: 'none' } } }
    })
  })

  test('google → ai@7 统一 reasoning 参数（无 providerOptions；SDK 按模型代分流 level/budget）；max clamp xhigh', () => {
    expect(effortCallOptions('gemini-2.5-pro', 'medium', 'google')).toEqual({
      reasoning: 'medium'
    })
    expect(effortCallOptions('gemini-2.5-pro', 'max', 'google')).toEqual({ reasoning: 'xhigh' })
    expect(effortCallOptions('gemini-2.5-pro', 'none', 'google')).toEqual({ reasoning: 'none' })
    expect(effortCallOptions('gemini-2.5-pro', 'high', 'google')?.providerOptions).toBeUndefined()
  })
})
