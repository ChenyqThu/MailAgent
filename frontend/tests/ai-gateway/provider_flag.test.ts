import { beforeEach, describe, expect, it, vi } from 'vitest'

const anthropicMocks = vi.hoisted(() => ({
  model: vi.fn((modelId: string) => ({ provider: 'legacy-anthropic', modelId })),
  createAnthropic: vi.fn()
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: anthropicMocks.createAnthropic
}))

import {
  llmCredentialsMissing,
  prepareChatRun,
  resolveModelFactory
} from '../../src/ai-gateway/chatRun'
import { ProviderCredentialsError } from '../../src/ai-gateway/providerRef'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'

function config(overrides: Partial<AiGatewayConfig> = {}): AiGatewayConfig {
  return {
    baseUrl: 'https://legacy.test/api',
    apiKey: 'legacy-key',
    model: 'claude-sonnet-4-6',
    ...overrides
  }
}

describe('resolveModelFactory provider registry flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    anthropicMocks.createAnthropic.mockReturnValue(anthropicMocks.model)
  })

  it('keeps the flag-off path byte-equivalent to the legacy Anthropic factory', async () => {
    const providerModelResolver = { resolve: vi.fn() }
    const resolve = resolveModelFactory(
      config({ providerRegistryEnabled: false, providerModelResolver })
    )

    const resolved = await resolve('claude-sonnet-4-6')

    expect(anthropicMocks.createAnthropic).toHaveBeenCalledOnce()
    expect(anthropicMocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: 'legacy-key',
      baseURL: 'https://legacy.test/api/v1'
    })
    expect(anthropicMocks.model).toHaveBeenCalledWith('claude-sonnet-4-6')
    expect(providerModelResolver.resolve).not.toHaveBeenCalled()
    expect(resolved.model).toEqual({
      provider: 'legacy-anthropic',
      modelId: 'claude-sonnet-4-6'
    })
  })

  it('keeps cfg.createModel as the highest-priority injection seam', async () => {
    const createModel = vi.fn((modelId: string) => ({ injected: modelId }))
    const providerModelResolver = { resolve: vi.fn() }
    const resolve = resolveModelFactory(
      config({ createModel, providerRegistryEnabled: true, providerModelResolver })
    )

    const resolved = await resolve('provider:model')

    expect(createModel).toHaveBeenCalledWith('provider:model')
    expect(providerModelResolver.resolve).not.toHaveBeenCalled()
    expect(anthropicMocks.createAnthropic).not.toHaveBeenCalled()
    expect(resolved.model).toEqual({ injected: 'provider:model' })
  })

  it('uses providerRef resolution only when the flag is on', async () => {
    const expected = {
      providerId: 'default',
      modelId: 'legacy-model',
      protocol: 'openai-compatible' as const,
      model: { provider: 'registry', modelId: 'legacy-model' }
    }
    const providerModelResolver = { resolve: vi.fn().mockResolvedValue(expected) }

    const resolved = await resolveModelFactory(
      config({ providerRegistryEnabled: true, providerModelResolver })
    )('legacy-model')

    expect(providerModelResolver.resolve).toHaveBeenCalledWith('legacy-model')
    expect(resolved).toBe(expected)
    expect(anthropicMocks.createAnthropic).not.toHaveBeenCalled()
  })
})

describe('llmCredentialsMissing credential pre-gate (HIGH-1)', () => {
  it('flag OFF keeps the legacy global-key gate (empty key → missing)', () => {
    expect(llmCredentialsMissing(config({ apiKey: null }))).toBe(true)
    expect(llmCredentialsMissing(config({ apiKey: '' }))).toBe(true)
    expect(llmCredentialsMissing(config())).toBe(false)
  })

  it('registry path (flag + resolver) skips the global gate — provider rows are the authority', () => {
    const providerModelResolver = { resolve: vi.fn() }
    expect(
      llmCredentialsMissing(
        config({ apiKey: null, providerRegistryEnabled: true, providerModelResolver })
      )
    ).toBe(false)
  })

  it('flag on WITHOUT a resolver still gates on the legacy key (mirrors resolveModelFactory)', () => {
    expect(llmCredentialsMissing(config({ apiKey: null, providerRegistryEnabled: true }))).toBe(
      true
    )
  })
})

describe('prepareChatRun registry credential failure mapping (HIGH-1)', () => {
  it('maps the resolver ProviderCredentialsError to 503 E_NO_LLM_KEY with the readable hint', async () => {
    const providerModelResolver = {
      resolve: vi
        .fn()
        .mockRejectedValue(new ProviderCredentialsError('LLM provider dashscope 缺少 API key'))
    }
    const cfg = config({ apiKey: null, providerRegistryEnabled: true, providerModelResolver })
    const body = {
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    }

    const outcome = await prepareChatRun(body, cfg, new AbortController().signal, 'manual_chat')

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(503)
      expect(outcome.body.error).toBe('E_NO_LLM_KEY')
      expect(outcome.body.hint).toContain('dashscope')
    }
    expect(providerModelResolver.resolve).toHaveBeenCalledWith('claude-sonnet-4-6')
  })
})
