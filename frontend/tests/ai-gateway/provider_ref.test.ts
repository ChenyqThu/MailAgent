// HIGH-2 (batch1 review) — URL canonicalization contract tests. The rules mirror the shared
// two-lane contract (Python provider_routing carries the same text): DB stores the raw value;
// anthropic consumes canonical_root (+ '/v1' on the TS side), the openai family consumes
// canonical_api_base. providerRef.ts is the SDK-free home of these functions.

import { describe, expect, it } from 'vitest'

import {
  canonicalApiBase,
  canonicalRoot,
  isProviderCredentialsError,
  ProviderCredentialsError
} from '../../src/ai-gateway/providerRef'

describe('canonicalRoot (anthropic 协议消费)', () => {
  it.each([
    // 用户填 /v1 结尾与裸 root 两种形态 → 同一 canonical_root
    ['https://host/api/v1', 'https://host/api'],
    ['https://host/api', 'https://host/api'],
    ['https://host/api/', 'https://host/api'],
    ['https://host/api/v1/', 'https://host/api'],
    // 只剥一段尾部 /vN；非尾部 /vN 不动
    ['https://host/v2', 'https://host'],
    ['https://host/v1/extra', 'https://host/v1/extra'],
    // /vN 必须是纯数字段
    ['https://host/api/v1beta', 'https://host/api/v1beta'],
    ['  https://host/api/v1  ', 'https://host/api'],
    ['', '']
  ])('%s → %s', (raw, expected) => {
    expect(canonicalRoot(raw)).toBe(expected)
  })
})

describe('canonicalApiBase (openai / deepseek / openai-compatible / openrouter 消费)', () => {
  it.each([
    // 已以 /vN 结尾 → 原样（保 /v2 等非默认版本）
    ['https://dashscope.test/compatible-mode/v1', 'https://dashscope.test/compatible-mode/v1'],
    ['https://host/v2', 'https://host/v2'],
    // 无 /vN 结尾 → 补 /v1
    ['https://dashscope.test/compatible-mode', 'https://dashscope.test/compatible-mode/v1'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
    // 尾部斜杠 / 空白归一
    ['https://host/api/', 'https://host/api/v1'],
    ['  https://host/v1/  ', 'https://host/v1'],
    // /v1beta 不算 /vN 段 → 仍补 /v1（google 不走本函数，其非空值原样）
    ['https://host/v1beta', 'https://host/v1beta/v1'],
    ['', '']
  ])('%s → %s', (raw, expected) => {
    expect(canonicalApiBase(raw)).toBe(expected)
  })
})

describe('ProviderCredentialsError (HIGH-1)', () => {
  it('carries the E_NO_LLM_KEY code and is detected by the guard', () => {
    const err = new ProviderCredentialsError('provider x 缺少 API key')
    expect(err.code).toBe('E_NO_LLM_KEY')
    expect(isProviderCredentialsError(err)).toBe(true)
  })

  it('rejects non-credential errors', () => {
    expect(isProviderCredentialsError(new Error('boom'))).toBe(false)
    expect(isProviderCredentialsError('E_NO_LLM_KEY')).toBe(false)
    expect(isProviderCredentialsError(null)).toBe(false)
  })
})
