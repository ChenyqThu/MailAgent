// OpenCode 会话头：provider 级进程兜底 + 解析结果标记（chatRun 据此按会话覆盖）。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createOpenAICompatible = vi.hoisted(() =>
  vi.fn((options: unknown) =>
    Object.assign(vi.fn(), { options, languageModel: vi.fn((modelId: string) => ({ modelId })) })
  )
)
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }))

import { opencodeSessionId } from '../../src/ai-gateway/opencodeSessionId'
import {
  buildProviderRegistry,
  resolveProviderModel,
  type ProviderSnapshotProvider
} from '../../src/ai-gateway/providers'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function opencode(overrides: Partial<ProviderSnapshotProvider> = {}): ProviderSnapshotProvider {
  return {
    id: 'opencode',
    protocol: 'openai-compatible',
    displayName: 'Opencode',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'k',
    headers: {},
    enabled: true,
    models: [],
    ...overrides
  }
}

function sentHeaders(): Record<string, string> {
  return (createOpenAICompatible.mock.calls[0]![0] as { headers: Record<string, string> }).headers
}

describe('OpenCode 会话头', () => {
  beforeEach(() => createOpenAICompatible.mockClear())

  it('用户没配 → provider 级挂进程兜底值，解析结果标记 opencodeSession', () => {
    const built = buildProviderRegistry({ version: 1, providers: [opencode()] })
    expect(sentHeaders()['x-opencode-session']).toMatch(UUID)
    expect(resolveProviderModel(built, 'opencode:deepseek-v4.1-flash').opencodeSession).toBe(true)
  })

  it('用户自己配了（大小写不敏感）→ 原样使用，不再自动附加', () => {
    const built = buildProviderRegistry({
      version: 1,
      providers: [opencode({ headers: { 'X-OpenCode-Session': 'mine' } })]
    })
    expect(sentHeaders()).toEqual({ 'X-OpenCode-Session': 'mine' })
    expect(resolveProviderModel(built, 'opencode:m').opencodeSession).toBeUndefined()
  })

  it('非 OpenCode provider 不受影响', () => {
    const built = buildProviderRegistry({
      version: 1,
      providers: [opencode({ id: 'other', baseUrl: 'https://api.example.test/v1' })]
    })
    expect(sentHeaders()).toEqual({})
    expect(resolveProviderModel(built, 'other:m').opencodeSession).toBeUndefined()
  })

  it('opencodeSessionId：同一会话恒定、不同会话不同、UUID 形状', () => {
    expect(opencodeSessionId(42)).toBe(opencodeSessionId(42))
    expect(opencodeSessionId(42)).not.toBe(opencodeSessionId(43))
    expect(opencodeSessionId(42)).toMatch(UUID)
    expect(opencodeSessionId(null)).toMatch(UUID)
  })
})
