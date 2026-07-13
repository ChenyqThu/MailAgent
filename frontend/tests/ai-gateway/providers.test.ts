import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const makeProviderFactory = () =>
    vi.fn((options: unknown) => {
      const provider = vi.fn((modelId: string) => ({ modelId }))
      return Object.assign(provider, {
        options,
        languageModel: vi.fn((modelId: string) => ({ modelId }))
      })
    })

  return {
    createAnthropic: makeProviderFactory(),
    createOpenAI: makeProviderFactory(),
    createOpenAICompatible: makeProviderFactory(),
    createDeepSeek: makeProviderFactory(),
    createGoogleGenerativeAI: makeProviderFactory(),
    createOpenRouter: makeProviderFactory(),
    createProviderRegistry: vi.fn(
      (providers: Record<string, { languageModel(modelId: string): unknown }>) => ({
        languageModel(ref: string) {
          const separatorIndex = ref.indexOf(':')
          return providers[ref.slice(0, separatorIndex)]!.languageModel(
            ref.slice(separatorIndex + 1)
          )
        }
      })
    ),
    defaultSettingsMiddleware: vi.fn((options: unknown) => ({ options })),
    wrapLanguageModel: vi.fn(({ model, middleware }: { model: unknown; middleware: unknown }) => ({
      model,
      middleware
    }))
  }
})

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible
}))
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: mocks.createDeepSeek }))
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: mocks.createGoogleGenerativeAI
}))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: mocks.createOpenRouter }))
vi.mock('ai', () => ({
  createProviderRegistry: mocks.createProviderRegistry,
  defaultSettingsMiddleware: mocks.defaultSettingsMiddleware,
  wrapLanguageModel: mocks.wrapLanguageModel
}))

import {
  buildProviderRegistry,
  createProviderModelResolver,
  isProviderCredentialsError,
  parseProviderRef,
  resolveProviderModel,
  type ProviderSnapshot,
  type ProviderSnapshotProvider
} from '../../src/ai-gateway/providers'

function provider(
  id: string,
  protocol: string,
  overrides: Partial<ProviderSnapshotProvider> = {}
): ProviderSnapshotProvider {
  return {
    id,
    protocol,
    displayName: id,
    baseUrl: `https://${id}.example.test`,
    apiKey: `${id}-key`,
    headers: { 'x-provider': id },
    enabled: true,
    models: [],
    ...overrides
  }
}

function snapshot(version: number, providers: ProviderSnapshotProvider[]): ProviderSnapshot {
  return { version, providers }
}

describe('parseProviderRef', () => {
  it.each([
    ['claude-sonnet-4-6', { providerId: 'default', modelId: 'claude-sonnet-4-6' }],
    ['default:claude-sonnet-4-6', { providerId: 'default', modelId: 'claude-sonnet-4-6' }],
    ['ollama:qwen2:7b', { providerId: 'ollama', modelId: 'qwen2:7b' }],
    [':model', { providerId: '', modelId: 'model' }],
    ['provider:', { providerId: 'provider', modelId: '' }]
  ])('parses %s at the first colon', (ref, expected) => {
    expect(parseProviderRef(ref)).toEqual(expected)
  })
})

describe('buildProviderRegistry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatches every supported protocol with the snapshot settings', () => {
    const providers = [
      provider('anthropic-id', 'anthropic', { baseUrl: 'https://anthropic.test/api' }),
      provider('openai-id', 'openai'),
      provider('compat-id', 'openai-compatible'),
      provider('deepseek-id', 'deepseek'),
      provider('google-id', 'google'),
      provider('openrouter-id', 'openrouter')
    ]

    buildProviderRegistry(snapshot(1, providers))

    // HIGH-2 URL 契约：anthropic = canonical_root + '/v1'；openai 家族 = canonical_api_base
    // （无 /vN 结尾则补 /v1）；google 非空原样。
    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-id-key',
      baseURL: 'https://anthropic.test/api/v1',
      headers: { 'x-provider': 'anthropic-id' }
    })
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'openai-id-key',
      baseURL: 'https://openai-id.example.test/v1',
      headers: { 'x-provider': 'openai-id' }
    })
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      apiKey: 'compat-id-key',
      baseURL: 'https://compat-id.example.test/v1',
      headers: { 'x-provider': 'compat-id' },
      name: 'compat-id',
      includeUsage: true
    })
    expect(mocks.createDeepSeek).toHaveBeenCalledWith({
      apiKey: 'deepseek-id-key',
      baseURL: 'https://deepseek-id.example.test/v1',
      headers: { 'x-provider': 'deepseek-id' }
    })
    expect(mocks.createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'google-id-key',
      baseURL: 'https://google-id.example.test',
      headers: { 'x-provider': 'google-id' }
    })
    expect(mocks.createOpenRouter).toHaveBeenCalledWith({
      apiKey: 'openrouter-id-key',
      baseURL: 'https://openrouter-id.example.test/v1',
      headers: { 'x-provider': 'openrouter-id' }
    })
  })

  it('HIGH-2 — a base already ending in /v1 and its bare root produce the SAME final URL', () => {
    buildProviderRegistry(
      snapshot(1, [
        provider('anthropic-v1', 'anthropic', { baseUrl: 'https://anthropic.test/api/v1' }),
        provider('anthropic-root', 'anthropic', { baseUrl: 'https://anthropic.test/api' }),
        provider('dashscope', 'openai-compatible', {
          baseUrl: 'https://dashscope.test/compatible-mode/v1'
        }),
        provider('dashscope-bare', 'openai-compatible', {
          baseUrl: 'https://dashscope.test/compatible-mode'
        })
      ])
    )

    const anthropicBases = mocks.createAnthropic.mock.calls.map(
      (c) => (c[0] as { baseURL?: string }).baseURL
    )
    expect(anthropicBases).toEqual([
      'https://anthropic.test/api/v1',
      'https://anthropic.test/api/v1'
    ])
    const compatBases = mocks.createOpenAICompatible.mock.calls.map(
      (c) => (c[0] as { baseURL?: string }).baseURL
    )
    expect(compatBases).toEqual([
      'https://dashscope.test/compatible-mode/v1',
      'https://dashscope.test/compatible-mode/v1'
    ])
  })

  it('skips disabled and unsupported providers without failing the registry', () => {
    const warn = vi.fn()
    const built = buildProviderRegistry(
      snapshot(1, [
        provider('disabled', 'anthropic', { enabled: false }),
        provider('unknown', 'future-protocol'),
        provider('default', 'anthropic')
      ]),
      { warn }
    )

    expect([...built.providers.keys()]).toEqual(['default'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '[ai-gateway] skipping unsupported LLM provider protocol: future-protocol'
    )
  })

  it('omits empty baseURL for official providers so their defaults apply', () => {
    buildProviderRegistry(
      snapshot(1, [
        provider('anthropic-default', 'anthropic', { baseUrl: '   ' }),
        provider('openai-default', 'openai', { baseUrl: '' })
      ])
    )

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-default-key',
      headers: { 'x-provider': 'anthropic-default' }
    })
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'openai-default-key',
      headers: { 'x-provider': 'openai-default' }
    })
  })

  it('skips openai-compatible providers without a required baseUrl', () => {
    const warn = vi.fn()
    const built = buildProviderRegistry(
      snapshot(1, [provider('compat-empty', 'openai-compatible', { baseUrl: '  ' })]),
      { warn }
    )

    expect(built.providers.size).toBe(0)
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '[ai-gateway] skipping openai-compatible LLM provider without baseUrl: compat-empty'
    )
  })

  it('preserves colons inside model ids and clamps configured maxOutput to 64000', () => {
    const built = buildProviderRegistry(
      snapshot(1, [
        provider('ollama', 'openai-compatible', {
          models: [
            {
              id: 'qwen2:7b',
              displayName: null,
              enabled: true,
              capabilities: { tools: true, vision: false, reasoning: false },
              maxOutput: 100_000,
              source: 'manual'
            }
          ]
        })
      ])
    )

    const resolved = resolveProviderModel(built, 'ollama:qwen2:7b')

    expect(resolved).toMatchObject({
      providerId: 'ollama',
      modelId: 'qwen2:7b',
      protocol: 'openai-compatible'
    })
    expect(mocks.defaultSettingsMiddleware).toHaveBeenCalledWith({
      settings: { maxOutputTokens: 64_000 }
    })
    expect(mocks.wrapLanguageModel).toHaveBeenCalledOnce()
  })

  it('does not set maxOutputTokens when the model row has no maxOutput', () => {
    const built = buildProviderRegistry(snapshot(1, [provider('default', 'anthropic')]))

    resolveProviderModel(built, 'legacy-model')

    expect(mocks.defaultSettingsMiddleware).not.toHaveBeenCalled()
    expect(mocks.wrapLanguageModel).not.toHaveBeenCalled()
  })

  it('HIGH-1 — a key-requiring provider row with no key fails typed at resolve time', () => {
    const built = buildProviderRegistry(
      snapshot(1, [provider('dashscope', 'anthropic', { apiKey: '' })])
    )

    let thrown: unknown
    try {
      resolveProviderModel(built, 'dashscope:qwen-max')
    } catch (e) {
      thrown = e
    }
    expect(isProviderCredentialsError(thrown)).toBe(true)
    expect((thrown as Error).message).toContain('dashscope')
  })

  it('HIGH-1 — openai-compatible rows may run keyless (local unauthenticated services)', () => {
    const built = buildProviderRegistry(
      snapshot(1, [provider('local', 'openai-compatible', { apiKey: '' })])
    )

    const resolved = resolveProviderModel(built, 'local:qwen3')

    expect(resolved.protocol).toBe('openai-compatible')
  })
})

describe('createProviderModelResolver', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reuses the built registry while the version is unchanged after TTL refresh', async () => {
    let now = 0
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot(7, [provider('default', 'anthropic')]))
    const resolver = createProviderModelResolver({
      fetchSnapshot,
      legacy: { apiKey: 'legacy-key', baseUrl: 'https://legacy.test/api' },
      now: () => now
    })

    await resolver.resolve('first-model')
    now = 30_001
    await resolver.resolve('second-model')

    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(mocks.createProviderRegistry).toHaveBeenCalledOnce()
  })

  it('uses a stale registry and warns once when refresh fails', async () => {
    let now = 0
    const warn = vi.fn()
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1, [provider('default', 'anthropic')]))
      .mockRejectedValue(new Error('offline'))
    const resolver = createProviderModelResolver({
      fetchSnapshot,
      legacy: { apiKey: 'legacy-key', baseUrl: 'https://legacy.test/api' },
      logger: { warn },
      now: () => now
    })

    await resolver.resolve('first-model')
    now = 30_001
    const stale = await resolver.resolve('second-model')
    now = 60_002
    await resolver.resolve('third-model')

    expect(stale.protocol).toBe('anthropic')
    expect(fetchSnapshot).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('fails open to the legacy Anthropic provider on a cold-start fetch failure', async () => {
    const warn = vi.fn()
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error('offline'))
    const resolver = createProviderModelResolver({
      fetchSnapshot,
      legacy: { apiKey: 'legacy-key', baseUrl: 'https://legacy.test/api' },
      logger: { warn }
    })

    const resolved = await resolver.resolve('default:claude-legacy')
    await resolver.resolve('default:claude-legacy-2')

    expect(resolved).toMatchObject({
      providerId: 'default',
      modelId: 'claude-legacy',
      protocol: 'anthropic'
    })
    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'legacy-key',
      baseURL: 'https://legacy.test/api/v1'
    })
    expect(fetchSnapshot).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('HIGH-1 — the fail-open legacy leg with an EMPTY legacy key fails typed, not keyless', async () => {
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error('offline'))
    const resolver = createProviderModelResolver({
      fetchSnapshot,
      legacy: { apiKey: null, baseUrl: 'https://legacy.test/api' },
      logger: { warn: vi.fn() }
    })

    await expect(resolver.resolve('claude-legacy')).rejects.toSatisfy(isProviderCredentialsError)
    expect(mocks.createAnthropic).not.toHaveBeenCalled()
  })
})
