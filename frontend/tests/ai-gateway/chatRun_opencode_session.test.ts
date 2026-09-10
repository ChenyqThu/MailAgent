// chatRun × OpenCode 会话头：解析结果带 opencodeSession 时，对话请求按会话附加稳定的
// x-opencode-session（真 streamText + MockLanguageModelV3，断言落到模型收到的请求头）。
import { describe, expect, it, vi } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'

// 流 chunk 类型从 mock 的构造参数反推（测试侧拿不到 @ai-sdk/provider），给字面量上下文类型。
type DoStream = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream'],
  (...args: never[]) => unknown
>
type StreamPart =
  Awaited<ReturnType<DoStream>>['stream'] extends ReadableStream<infer P> ? P : never

function textModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream<StreamPart>({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 }
            }
          }
        ]
      })
    })
  })
}

async function sentHeaders(
  opencodeSession: boolean,
  sessionId: number
): Promise<Record<string, string | undefined>> {
  const model = textModel()
  const providerModelResolver = {
    resolve: vi.fn().mockResolvedValue({
      providerId: 'opencode',
      modelId: 'deepseek-v4.1-flash',
      protocol: 'openai-compatible',
      model,
      ...(opencodeSession ? { opencodeSession: true } : {})
    })
  }
  const cfg: AiGatewayConfig = {
    port: 0,
    baseUrl: 'https://legacy.test/api',
    apiKey: null,
    model: 'opencode:deepseek-v4.1-flash',
    providerRegistryEnabled: true,
    providerModelResolver
  }
  const body = {
    sessionId,
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
  }
  const outcome = await prepareChatRun(body, cfg, new AbortController().signal, 'manual_chat')
  if (!outcome.ok) throw new Error(`prepareChatRun failed: ${JSON.stringify(outcome.body)}`)
  await outcome.run.result.consumeStream()
  return model.doStreamCalls[0]!.headers ?? {}
}

describe('chatRun × OpenCode 会话头', () => {
  it('OpenCode 模型：同一会话恒定、不同会话不同', async () => {
    const first = (await sentHeaders(true, 42))['x-opencode-session']
    expect(first).toBeTruthy()
    expect((await sentHeaders(true, 42))['x-opencode-session']).toBe(first)
    expect((await sentHeaders(true, 43))['x-opencode-session']).not.toBe(first)
  })

  it('其余模型不带该头', async () => {
    expect((await sentHeaders(false, 42))['x-opencode-session']).toBeUndefined()
  })
})
