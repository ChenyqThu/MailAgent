// L4 群聊 g1 — costUsdFor：modelCatalog 快照的 CatalogCost（$/M）× usage；查不到恒 null。

import { describe, expect, test } from 'vitest'

import { costUsdFor } from '../../src/ai-gateway/modelCost'
import { lookupModelMeta } from '../../src/shared/modelCatalog/lookup'

describe('costUsdFor', () => {
  test('已知模型（anthropic 链逐字命中）按 $/百万 token 算', () => {
    const cost = lookupModelMeta('claude-sonnet-4-5', 'anthropic')?.cost
    // 目录快照自证：本用例依赖它有价，否则下面的期望值无从推导。
    expect(cost?.input).toBeTypeOf('number')
    expect(cost?.output).toBeTypeOf('number')
    const usd = costUsdFor(
      'claude-sonnet-4-5',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'anthropic'
    )
    expect(usd).toBeCloseTo(cost!.input! + cost!.output!, 9)
    // 只有输入 token 时只算输入价。
    expect(
      costUsdFor('claude-sonnet-4-5', { inputTokens: 2_000_000, outputTokens: 0 }, 'anthropic')
    ).toBeCloseTo(2 * cost!.input!, 9)
  })

  test('归一化命中：中转把档位写进 id（[1m]）/ vendor 前缀 也能查到价', () => {
    const plain = costUsdFor(
      'claude-sonnet-4-5',
      { inputTokens: 1000, outputTokens: 1000 },
      'anthropic'
    )
    expect(plain).not.toBeNull()
    expect(
      costUsdFor('claude-sonnet-4-5[1m]', { inputTokens: 1000, outputTokens: 1000 }, 'anthropic')
    ).toBe(plain)
    expect(
      costUsdFor(
        'anthropic/claude-sonnet-4-5',
        { inputTokens: 1000, outputTokens: 1000 },
        'openrouter'
      )
    ).toBe(plain)
  })

  test('未知模型 / 无 usage / 零 token / 空 id → null（落库 NULL，tokens 地板兜底）', () => {
    expect(
      costUsdFor('no-such-model-xyz', { inputTokens: 10, outputTokens: 10 }, 'anthropic')
    ).toBeNull()
    expect(costUsdFor('claude-sonnet-4-5', null, 'anthropic')).toBeNull()
    expect(
      costUsdFor('claude-sonnet-4-5', { inputTokens: 0, outputTokens: 0 }, 'anthropic')
    ).toBeNull()
    expect(
      costUsdFor('claude-sonnet-4-5', { inputTokens: null, outputTokens: null }, 'anthropic')
    ).toBeNull()
    expect(costUsdFor(null, { inputTokens: 10, outputTokens: 10 }, 'anthropic')).toBeNull()
    expect(costUsdFor('', { inputTokens: 10, outputTokens: 10 }, 'anthropic')).toBeNull()
  })
})
