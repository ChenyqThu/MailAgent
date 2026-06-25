// chat-panel P4 composer-parity C1-① — gateway extended-thinking provider options.
// Pins the model-family matrix (mirror of legacy custom_api.ts): sonnet/older → manual budget,
// opus-4-7/4-8/fable → adaptive + effort (manual budget would 400). enabled=false → undefined so
// the caller omits providerOptions entirely (byte-identical to the no-thinking streamText call).

import { describe, expect, test } from 'vitest'

import { thinkingProviderOptions } from '../../src/ai-gateway/thinking'

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
})
