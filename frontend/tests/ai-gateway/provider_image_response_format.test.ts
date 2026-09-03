// 0903 dogfood — 「图像模型恒用原生 openai 腿构造」的行为证明。本文件**不 mock 任何 SDK**：
// 用注入的 globalThis.fetch 假实现捕获实际发出的请求体，直接看 `response_format` 在不在。
//
// 两条断言一起才成立：
//   · gpt-image-2（命中原生 SDK 的 hasDefaultResponseFormat）请求体**不含** response_format
//     —— 这一族恒返 b64_json，带上该字段官方直接 400；
//   · dall-e-3（不命中）请求体**含**该字段 —— 证明是判据在起作用，而不是「这条路径压根不拼」。
// 缺任一条，@ai-sdk/openai-compatible 那条无条件拼 response_format 的老腿也能骗过测试。
//
// 🔴 零真实网络、零真实 key：fetch 假实现拦在最外层，provider 行填的是 .test 合成域。

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildProviderRegistry,
  resolveImageModel,
  type ProviderSnapshotProvider
} from '../../src/ai-gateway/providers'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function row(protocol: 'openai' | 'openai-compatible'): ProviderSnapshotProvider {
  return {
    id: 'img',
    protocol,
    displayName: 'img',
    baseUrl: 'https://gateway.test/api',
    apiKey: 'row-key',
    headers: {},
    enabled: true,
    models: []
  }
}

/** 解析一个图像模型并跑一次 doGenerate，返回假 fetch 捕获到的 URL + 请求体。 */
async function captureGenerateRequest(
  protocol: 'openai' | 'openai-compatible',
  modelId: string
): Promise<{ url: string; body: Record<string, unknown> }> {
  const seen: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    return new Response(JSON.stringify({ created: 0, data: [{ b64_json: 'AAAA' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof globalThis.fetch

  const built = buildProviderRegistry({ version: 1, providers: [row(protocol)] })
  // ImageModel 是 `string | ImageModelV2|V3|V4` 的联合，这里只需要 doGenerate 这一面。
  const model = resolveImageModel(built, `img:${modelId}`) as unknown as {
    doGenerate(options: Record<string, unknown>): Promise<unknown>
  }
  await model.doGenerate({
    prompt: 'a red apple',
    n: 1,
    size: undefined,
    aspectRatio: undefined,
    seed: undefined,
    providerOptions: {}
  })

  expect(seen).toHaveLength(1)
  return seen[0]!
}

describe('图像模型请求体：response_format 由原生 SDK 的模型判据决定', () => {
  it.each(['openai', 'openai-compatible'] as const)(
    '%s 行的 gpt-image-2 请求体不含 response_format',
    async (protocol) => {
      const { url, body } = await captureGenerateRequest(protocol, 'gpt-image-2')

      expect(body).not.toHaveProperty('response_format')
      expect(body).toMatchObject({ model: 'gpt-image-2', prompt: 'a red apple', n: 1 })
      // baseURL 与该 provider 的 chat 腿同源：canonicalApiBase('…/api') → '…/api/v1'
      expect(url).toBe('https://gateway.test/api/v1/images/generations')
    }
  )

  it.each(['openai', 'openai-compatible'] as const)(
    '%s 行的非 gpt-image 模型仍带 response_format（判据确实在生效）',
    async (protocol) => {
      const { body } = await captureGenerateRequest(protocol, 'dall-e-3')

      expect(body).toHaveProperty('response_format', 'b64_json')
    }
  )
})
