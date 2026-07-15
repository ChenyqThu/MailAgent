// 批 2 review HIGH-3 — onboarding provider 模板单源的不变式。
// main（handlers/onboarding llmProviderSave）与 renderer（onboarding/steps StepAiModel）
// 共用本表；这里钉死安全承重的形状约束。

import { describe, expect, it } from 'vitest'

import {
  findOnboardingLlmTemplate,
  invalidCustomBaseUrlReason,
  ONBOARDING_LLM_TEMPLATES
} from '../../src/shared/onboarding/llmProviderTemplates'

describe('ONBOARDING_LLM_TEMPLATES invariants', () => {
  it('only the two custom templates accept a user baseUrl', () => {
    const custom = ONBOARDING_LLM_TEMPLATES.filter((t) => t.allowCustomBaseUrl)
    expect(custom.map((t) => t.key).sort()).toEqual(['custom-anthropic', 'custom-openai'])
  })

  it('every key is a valid server provider-id slug (llm_providers.py _PROVIDER_ID_RE)', () => {
    for (const t of ONBOARDING_LLM_TEMPLATES) {
      expect(t.key).toMatch(/^[a-z][a-z0-9_-]{0,40}$/)
    }
  })

  it('preset (non-custom) templates pin protocol + baseUrl; findOnboardingLlmTemplate resolves by key', () => {
    const dash = findOnboardingLlmTemplate('dashscope')
    expect(dash?.protocol).toBe('openai-compatible')
    expect(dash?.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(findOnboardingLlmTemplate('nope')).toBeUndefined()
  })
})

describe('invalidCustomBaseUrlReason', () => {
  it('accepts plain http/https URLs', () => {
    expect(invalidCustomBaseUrlReason('https://relay.example/v1')).toBeNull()
    expect(invalidCustomBaseUrlReason('http://10.0.0.5:3000')).toBeNull()
  })

  it.each([
    ['not a url'],
    ['ftp://relay.example/v1'],
    ['file:///etc/passwd'],
    ['https://user:pass@relay.example/v1'],
    ['https://:pass@relay.example/v1']
  ])('rejects %s', (raw) => {
    expect(invalidCustomBaseUrlReason(raw)).not.toBeNull()
  })
})
