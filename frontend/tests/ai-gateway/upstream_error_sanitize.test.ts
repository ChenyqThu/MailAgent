// 发版终审 M3（codex）/ M-1（fable）— gateway 两入口（/api/ai/title、search-agent loop）的
// 上游错误脱敏分叉：registry flag ON 时 hint / SSE result message 走
// sanitizedUpstreamErrorMessage 固定形状（上游错误正文可能回显凭证）；flag OFF 保持既有
// message 形状（字节级纪律 pin）。模型注入走 cfg.createModel 缝（工厂内同步 throw →
// 不经 provider、不触发 AI SDK retry）。（W6 起 /api/ai/followups 端点已删——追问建议改
// 回合内 suggest_followups 工具；其 APICallError 形状覆盖搬到 title 入口，同一代码路径。）

import { afterEach, describe, expect, test, vi } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import { runHeadlessSearchAgent } from '../../src/ai-gateway/searchAgentRun'
import { runHeadlessAgent } from '../../src/ai-gateway/agentRun'
import { sanitizedUpstreamErrorMessage, unwrapUpstreamError } from '../../src/ai-gateway/upstreamError'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import type { AgentRunSpec } from '../../src/shared/api/types'

const LEAKY = 'upstream echoed Authorization: Bearer sk-live-LEAK and X-Gw-Sign: s3cr3t'

const leakyApiCallError = (): APICallError =>
  new APICallError({
    message: LEAKY,
    url: 'https://relay.example/v1/messages',
    requestBodyValues: {},
    statusCode: 401,
    responseBody: LEAKY
  })

const handles: AiGatewayHandle[] = []
async function withServer(
  cfg: Partial<AiGatewayConfig>,
  run: (base: string) => Promise<void>
): Promise<void> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model',
    ...cfg
  })
  handles.push(handle)
  await run(`http://127.0.0.1:${handle.port}`)
}
afterEach(async () => {
  vi.restoreAllMocks()
  while (handles.length) await handles.pop()!.close()
})

/** title 的持久化 hook 桩（端点 501 gate 需要它们在场）。 */
const titleHooks = {
  getTitleContext: () => ({ title: null, firstUserText: 'hello' }),
  saveSessionTitle: vi.fn()
}

const throwingModel = (err: unknown): Partial<AiGatewayConfig> => ({
  createModel: () => {
    throw err
  }
})

const post = (base: string, path: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 1 })
  })

describe('/api/ai/title upstream error hint', () => {
  test('flag ON → fixed-shape sanitized hint, no leaked credentials in hint or log', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await withServer(
      { providerRegistryEnabled: true, ...titleHooks, ...throwingModel(new Error(LEAKY)) },
      async (base) => {
        const res = await post(base, '/api/ai/title')
        expect(res.status).toBe(502)
        const body = (await res.json()) as { error: string; hint: string }
        expect(body.error).toBe('E_UPSTREAM')
        expect(body.hint).toBe('Error: upstream LLM call failed')
        expect(body.hint).not.toContain('sk-live-LEAK')
        const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
        expect(logged).not.toContain('sk-live-LEAK')
      }
    )
  })

  test('flag OFF pins the legacy raw-message hint (byte-identical discipline)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await withServer({ ...titleHooks, ...throwingModel(new Error(LEAKY)) }, async (base) => {
      const res = await post(base, '/api/ai/title')
      expect(res.status).toBe(502)
      const body = (await res.json()) as { hint: string }
      expect(body.hint).toBe(LEAKY)
    })
  })
})

describe('/api/ai/title upstream APICallError hint (前 followups 覆盖，同一代码路径)', () => {
  test('flag ON → fixed-shape sanitized hint for an APICallError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await withServer(
      { providerRegistryEnabled: true, ...titleHooks, ...throwingModel(leakyApiCallError()) },
      async (base) => {
        const res = await post(base, '/api/ai/title')
        expect(res.status).toBe(502)
        const body = (await res.json()) as { hint: string }
        expect(body.hint).toBe('HTTP 401 AI_APICallError')
        expect(body.hint).not.toContain('sk-live-LEAK')
      }
    )
  })
})

describe('search-agent loop error message', () => {
  const baseCfg: AiGatewayConfig = {
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model'
  }
  const run = (cfg: AiGatewayConfig): ReturnType<typeof runHeadlessSearchAgent> =>
    runHeadlessSearchAgent(cfg, { userContent: 'find x' }, new AbortController().signal)

  test('flag ON: APICallError → E_UPSTREAM with the sanitized fixed shape', async () => {
    const result = await run({
      ...baseCfg,
      providerRegistryEnabled: true,
      ...throwingModel(leakyApiCallError())
    })
    expect(result.ok).toBe(false)
    expect(result.error).toEqual({ code: 'E_UPSTREAM', message: 'HTTP 401 AI_APICallError' })
  })

  test('flag ON: generic loop error → E_AGENT with the sanitized fixed shape', async () => {
    const result = await run({
      ...baseCfg,
      providerRegistryEnabled: true,
      ...throwingModel(new Error(LEAKY))
    })
    expect(result.error).toEqual({ code: 'E_AGENT', message: 'Error: upstream LLM call failed' })
  })

  test('flag OFF pins the legacy raw message (byte-identical discipline)', async () => {
    const result = await run({ ...baseCfg, ...throwingModel(leakyApiCallError()) })
    expect(result.error).toEqual({ code: 'E_UPSTREAM', message: LEAKY })
  })

  test('RetryError wrapping APICallError(429) unwraps to E_QUOTA and sanitized 429 hint', async () => {
    const quotaErr = new APICallError({
      message: `429 Too Many Requests ${LEAKY}`,
      url: 'https://relay.example/v1/messages',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: LEAKY
    })
    const retryErr = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [quotaErr]
    })
    expect(unwrapUpstreamError(retryErr)).toBe(quotaErr)
    expect(sanitizedUpstreamErrorMessage(retryErr)).toBe('HTTP 429 AI_APICallError')

    const searchResult = await run({
      ...baseCfg,
      providerRegistryEnabled: true,
      ...throwingModel(retryErr)
    })
    expect(searchResult.error).toEqual({ code: 'E_QUOTA', message: 'HTTP 429 AI_APICallError' })

    const spec: AgentRunSpec = {
      jobId: 1,
      agentId: 'a1',
      agentTitle: 'Test',
      trigger: { kind: 'cron', firedAt: new Date().toISOString() },
      prompt: { taskPrompt: 'hi' },
      budget: { maxRunSeconds: 30 },
      sessionTitle: 's1'
    }
    const agentResult = await runHeadlessAgent(
      {
        ...baseCfg,
        providerRegistryEnabled: true,
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => {
              throw retryErr
            }
          })
      },
      { jobId: 1, spec, sessionId: null },
      new AbortController().signal
    )
    expect(agentResult.ok).toBe(false)
    expect(agentResult.error?.code).toBe('E_QUOTA')
    expect(agentResult.error?.message).toContain('429')
  })
})
