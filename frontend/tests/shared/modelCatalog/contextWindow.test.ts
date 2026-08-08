import { describe, expect, test } from 'vitest'

import { resolveContextWindow } from '../../../src/shared/modelCatalog/contextWindow'

describe('resolveContextWindow', () => {
  test('DB snapshot row outranks protocol-scoped catalog metadata', () => {
    expect(
      resolveContextWindow({
        providerId: 'anthropic-main',
        modelId: 'claude-sonnet-4-6',
        protocol: 'anthropic',
        snapshotModel: { contextWindow: 321_000 }
      })
    ).toBe(321_000)
  })

  test('catalog fallback obeys protocol and unknown models degrade to null', () => {
    expect(
      resolveContextWindow({
        providerId: 'anthropic-main',
        modelId: 'claude-sonnet-4-6',
        protocol: 'anthropic',
        snapshotModel: { contextWindow: null }
      })
    ).toBeGreaterThan(0)
    expect(
      resolveContextWindow({
        providerId: 'custom',
        modelId: 'definitely-not-a-real-model',
        protocol: 'openai-compatible',
        snapshotModel: null
      })
    ).toBeNull()
  })
})
