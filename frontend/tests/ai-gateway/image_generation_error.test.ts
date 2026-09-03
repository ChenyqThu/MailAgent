// 0903 dogfood — 图像生成失败的正文要能自诊断：HTTP 状态码 + 请求打到的端点；404 再追一句
// 「这台 provider 没有 OpenAI 图像端点」（owner 的中转 crs 就是这样：同一 base 上
// /v1/chat/completions 返 401 而 /v1/images/generations 返 404）。
//
// 脱敏基线一并钉住：上游 message / responseBody（可能回显 Authorization）一个字不许出去，
// URL 的查询串（有 provider 把密钥放这儿）也要掐掉。真 APICallError 对拍，范式同
// tests/main/llm_provider_sanitize.test.ts。

import { describe, expect, test } from 'vitest'
import { APICallError } from 'ai'

import { imageGenerationFailureMessage } from '../../src/ai-gateway/tools/image'

const LEAKY = 'upstream echoed Authorization: Bearer sk-live-LEAK'
const ENDPOINT = 'https://crs.chenge.ink/api/v1/images/generations'

function upstreamError(statusCode: number): APICallError {
  return new APICallError({
    message: LEAKY,
    url: `${ENDPOINT}?key=sk-live-LEAK`,
    requestBodyValues: {},
    statusCode,
    responseBody: LEAKY
  })
}

describe('imageGenerationFailureMessage', () => {
  test('404 → 状态码 + 端点 + 「该 provider 没有图像端点」的判断', () => {
    const out = imageGenerationFailureMessage(upstreamError(404))
    expect(out).toContain('HTTP 404')
    expect(out).toContain(ENDPOINT)
    expect(out).toContain('该 provider 未提供 OpenAI 图像端点')
    expect(out).toContain('设置 → AI')
  })

  test('凭证不外泄：上游正文与 URL 查询串都不带出去', () => {
    const out = imageGenerationFailureMessage(upstreamError(404))
    expect(out).not.toContain('sk-live-LEAK')
    expect(out).not.toContain('key=')
  })

  test('非 404（401）→ 只补端点，不下「没有图像端点」的结论', () => {
    const out = imageGenerationFailureMessage(upstreamError(401))
    expect(out).toContain('HTTP 401')
    expect(out).toContain(ENDPOINT)
    expect(out).not.toContain('未提供 OpenAI 图像端点')
  })

  test('非 APICallError → 退回脱敏基线（没有端点可报）', () => {
    expect(imageGenerationFailureMessage(new Error('boom'))).toBe('Error: upstream LLM call failed')
  })
})
