// 批 2 review MEDIUM-4 — sanitizedUpstreamErrorMessage 单元测试（真 APICallError）。
//
// nl_search.test / translate.test 里 llm_provider_resolver 整体被 mock（wiring 测试），
// 这里单独加载真模块验证 helper 本体：任何分支都不得把 err.message 原文（可能含
// 上游回显的 Authorization / 自定义 header 值）带进输出。

import { describe, expect, test, vi } from 'vitest'
import { APICallError } from 'ai'

// llm_provider_resolver 顶层 import daemon_api（local token 链）+ llm_settings（keytar
// native 模块）—— helper 是纯函数，这两个依赖 mock 掉即可安全加载真模块。
vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRequest: vi.fn() }))
vi.mock('../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: vi.fn(),
  getLlmBaseUrl: vi.fn(() => 'https://test.llm')
}))

const { sanitizedUpstreamErrorMessage } =
  await import('../../src/electron/main/llm_provider_resolver')

const LEAKY = 'upstream echoed Authorization: Bearer sk-live-LEAK and X-Gw-Sign: s3cr3t'

describe('sanitizedUpstreamErrorMessage', () => {
  test('APICallError with status → fixed "HTTP <status> <name>" shape, message dropped', () => {
    const err = new APICallError({
      message: LEAKY,
      url: 'https://relay.example/v1/messages',
      requestBodyValues: {},
      statusCode: 401,
      responseBody: LEAKY
    })
    const out = sanitizedUpstreamErrorMessage(err)
    // AISDKError 系错误 name 带 AI_ 前缀（AI_APICallError）。
    expect(out).toBe('HTTP 401 AI_APICallError')
    expect(out).not.toContain('sk-live-LEAK')
    expect(out).not.toContain('s3cr3t')
  })

  test('APICallError without status → name + fixed copy, message dropped', () => {
    const err = new APICallError({
      message: LEAKY,
      url: 'https://relay.example/v1/messages',
      requestBodyValues: {}
    })
    const out = sanitizedUpstreamErrorMessage(err)
    expect(out).toBe('AI_APICallError: upstream LLM call failed')
    expect(out).not.toContain('sk-live-LEAK')
  })

  test('generic Error → class name + fixed copy, message dropped', () => {
    class WeirdUpstreamError extends Error {
      constructor() {
        super(LEAKY)
        this.name = 'WeirdUpstreamError'
      }
    }
    expect(sanitizedUpstreamErrorMessage(new WeirdUpstreamError())).toBe(
      'WeirdUpstreamError: upstream LLM call failed'
    )
  })

  test('non-Error throwable → fixed copy (string 本身也可能含敏感串)', () => {
    expect(sanitizedUpstreamErrorMessage(LEAKY)).toBe('unknown upstream LLM error')
  })
})
