// V2.1 阶段 3 3b-1 — electron 侧 ChatModelPlatform.llmFetch 契约（codex review note）。
//
// custom_api 下沉 shared 后，HTTP fetch（注入 key/baseUrl/UA）落在 electronChatPlatform.llmFetch。
// shared 单测覆盖「注入后的 Response/throw 如何被 shared 处理」，但 electron 实现侧的 protocol
// 路由（endpoint 选择）+ key/header 注入 + key 缺失 throw 契约此前无测。本文件钉死它，关闭
// 「字节级零回归」的剩余风险。mock llm_settings（key/baseUrl/model）+ global.fetch。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: vi.fn(async () => 'cr_TEST_KEY'),
  getLlmBaseUrl: () => 'https://crs.example.com/api',
  getLlmModel: () => 'claude-sonnet-4-6'
}))

import { electronChatPlatform } from '../../../src/electron/main/chat/electron_platform'
import { getLlmApiKey } from '../../../src/electron/main/llm_settings'

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = global.fetch
  vi.mocked(getLlmApiKey).mockResolvedValue('cr_TEST_KEY')
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

interface Captured {
  url: string
  init: RequestInit
}

function captureFetch(): { get: () => Captured | null } {
  let captured: Captured | null = null
  global.fetch = vi.fn(async (url: unknown, init: unknown) => {
    captured = { url: String(url), init: (init ?? {}) as RequestInit }
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
  return { get: () => captured }
}

describe('electronChatPlatform.llmFetch — protocol 路由 + key 注入', () => {
  test('anthropic → /v1/messages + x-api-key + anthropic-version + UA（key 不进 body）', async () => {
    const cap = captureFetch()
    const signal = new AbortController().signal
    await electronChatPlatform.llmFetch({
      protocol: 'anthropic',
      body: { model: 'claude-sonnet-4-6', messages: [] },
      signal
    })
    const c = cap.get()!
    expect(c.url).toBe('https://crs.example.com/api/v1/messages')
    const headers = c.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('cr_TEST_KEY')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['user-agent']).toContain('Mozilla/5.0')
    expect(c.init.signal).toBe(signal)
    // key 注入在 header，绝不进 body（REVIEW-LOG C-04）。
    expect(c.init.body as string).not.toContain('cr_TEST_KEY')
  })

  test('openai → /v1/chat/completions + Bearer（无 x-api-key）', async () => {
    const cap = captureFetch()
    await electronChatPlatform.llmFetch({
      protocol: 'openai',
      body: { model: 'gpt-5.4', messages: [] },
      signal: new AbortController().signal
    })
    const c = cap.get()!
    expect(c.url).toBe('https://crs.example.com/api/v1/chat/completions')
    const headers = c.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer cr_TEST_KEY')
    expect(headers['x-api-key']).toBeUndefined()
  })

  test('key 缺失 → throw Error & {code:E_NO_LLM_KEY}（不打 fetch）', async () => {
    vi.mocked(getLlmApiKey).mockResolvedValue(null)
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    await expect(
      electronChatPlatform.llmFetch({
        protocol: 'anthropic',
        body: {},
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'E_NO_LLM_KEY' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
