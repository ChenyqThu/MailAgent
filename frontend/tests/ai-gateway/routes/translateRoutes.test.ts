// Wave 4C — translateRoutes.ts unit + HTTP route + disconnect abort tests.
//
// Ports all 10 axes from the retired electron/main/handlers/translate.test.ts
// and verifies HTTP status mapping + client disconnect abort propagation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

const { mockGenerateText, mockResolveProviderModel } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockResolveProviderModel: vi.fn()
}))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: mockGenerateText
  }
})

import type { AiGatewayConfig, TranslateGatewayHooks } from '../../../src/ai-gateway/config'
import {
  abortAllTranslations,
  handleTranslateBatch,
  translateBatchWithConfig
} from '../../../src/ai-gateway/routes/translateRoutes'
import { createAiGatewayServer } from '../../../src/ai-gateway/server'
import { plaintextToHtml } from '../../../src/shared/lib/plaintext_html'

const EMAIL_BODY_HTML_3PARA = `
  <p>Hello team this is a real paragraph one.</p>
  <p>Please review the attached document soon.</p>
  <p>Thanks for your prompt response on this.</p>
`

const fetchMock = vi.fn()

function ok(text: string): { ok: true; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
      model: 'test-model'
    })
  }
}

function htmlParagraphs(count: number, textFor: (idx: number) => string): string {
  return Array.from({ length: count }, (_, i) => `<p>${textFor(i)}</p>`).join('\n')
}

function exactEnglishText(prefix: string, length: number): string {
  let out = prefix
  while (out.length < length) out += 'alpha beta gamma delta '
  out = out.slice(0, length)
  return out.endsWith(' ') ? out.slice(0, -1) + 'x' : out
}

function mockEchoTranslation(calls?: Array<{ count: number; chars: number }>): void {
  fetchMock.mockImplementation((_url, init) => {
    const reqBody = JSON.parse((init as RequestInit).body as string)
    const segs = JSON.parse(reqBody.messages[0].content as string) as Array<{
      id: string
      text: string
    }>
    calls?.push({
      count: segs.length,
      chars: segs.reduce((sum, s) => sum + s.text.length, 0)
    })
    return Promise.resolve(ok(JSON.stringify(segs.map((s, i) => ({ id: s.id, tgt: `译文 ${i}` })))))
  })
}

let bodies: Map<number, string | null>
let isRegistryEnabled: boolean
let hasExplicitProfile: boolean
let apiKeyValue: string | null
let saveTranslationMock: ReturnType<typeof vi.fn>
let logEventMock: ReturnType<typeof vi.fn>
let cfg: AiGatewayConfig

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
  delete process.env.LLM_TRANSLATE_API_KEY
  delete process.env.LLM_TRANSLATE_BASE_URL

  bodies = new Map<number, string | null>([
    [101, EMAIL_BODY_HTML_3PARA],
    [102, '']
  ])
  isRegistryEnabled = false
  hasExplicitProfile = false
  apiKeyValue = 'test-key'

  mockResolveProviderModel.mockResolvedValue({
    providerId: 'default',
    modelId: 'test-model',
    model: { modelId: 'sdk-test-model' },
    protocol: 'anthropic',
    maxOutputTokens: 64_000
  })

  saveTranslationMock = vi.fn().mockResolvedValue({ cacheKept: false, fetchedAt: 1234.5 })
  logEventMock = vi.fn()

  const translateHooks: TranslateGatewayHooks = {
    readBodyHtml: async (internalId) => bodies.get(internalId) ?? null,
    saveTranslation: saveTranslationMock as unknown as TranslateGatewayHooks['saveTranslation'],
    isProviderRegistryEnabled: () => isRegistryEnabled,
    hasExplicitTranslateProfile: vi.fn(async () => hasExplicitProfile),
    getTranslateApiKey: async () => apiKeyValue,
    getTranslateBaseUrl: () => 'https://test.llm',
    getTranslateModel: () => 'test-model'
  }

  cfg = {
    port: 0,
    baseUrl: 'https://test.llm',
    apiKey: 'test-key',
    model: 'test-model',
    providerModelResolver: { resolve: mockResolveProviderModel },
    logEvent: logEventMock as unknown as AiGatewayConfig['logEvent'],
    translate: translateHooks
  }
})

afterEach(() => {
  abortAllTranslations()
  fetchMock.mockReset()
})

describe('translateBatchWithConfig', () => {
  test('flag off preserves the exact legacy Anthropic request wire', async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      const request = init as RequestInit
      const body = JSON.parse(request.body as string) as {
        messages: Array<{ content: string }>
      }
      const inputs = JSON.parse(body.messages[0].content) as Array<{ id: string; text: string }>
      return Promise.resolve(
        ok(JSON.stringify(inputs.map((item) => ({ id: item.id, tgt: `译文 ${item.id}` }))))
      )
    })

    await translateBatchWithConfig({ internalId: 101 }, cfg)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const input = JSON.stringify([
      { id: 'c53385e8', text: 'Hello team this is a real paragraph one.' },
      { id: 'af7b4dd6', text: 'Please review the attached document soon.' },
      { id: '09430846', text: 'Thanks for your prompt response on this.' }
    ])
    expect(url).toBe('https://test.llm/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'
    })
    expect(init.body).toBe(
      JSON.stringify({
        model: 'test-model',
        max_tokens: 64_000,
        system: [
          'You translate email paragraphs into fluent natural Simplified Chinese (mainland usage).',
          'Input is a JSON array of {"id": "...", "text": "..."} — one entry per paragraph.',
          'Output STRICTLY a JSON array of {"id": "...", "tgt": "..."} — one entry per input,',
          'matching by id; same length and same order as the input. Rules:',
          '- Preserve URLs, email addresses, code identifiers, product names, and people names verbatim.',
          '- Translate the FULL meaning of each text into the target language, not literal word-for-word.',
          '- If a paragraph is already in the target language, output it verbatim as tgt.',
          '- **CRITICAL JSON SAFETY**: tgt strings MUST NOT contain raw ASCII double quotes (").',
          '  If you need to quote a phrase, use Chinese 「」 quotes for Chinese tgt, or escape as \\".',
          '  Unescaped " inside tgt breaks JSON parsing and the whole batch is lost.',
          '- Output ONLY the JSON array. No preamble, no commentary, no ```json fence, no trailing prose.'
        ].join('\n'),
        messages: [{ role: 'user', content: input }]
      })
    )
  })

  test('flag on resolves providerRef and uses AI SDK without fetch', async () => {
    isRegistryEnabled = true
    mockResolveProviderModel.mockResolvedValue({
      providerId: 'openai-main',
      modelId: 'gpt-5',
      model: { modelId: 'sdk-gpt-5' },
      protocol: 'openai',
      maxOutputTokens: 8192
    })
    mockGenerateText.mockImplementation(async ({ prompt }) => {
      const inputs = JSON.parse(prompt as string) as Array<{ id: string; text: string }>
      return {
        text: JSON.stringify(inputs.map((item) => ({ id: item.id, tgt: `译文 ${item.id}` }))),
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 }
      }
    })

    const result = await translateBatchWithConfig({ internalId: 101 }, cfg)

    expect(mockResolveProviderModel).toHaveBeenCalledWith('test-model')
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: 'sdk-gpt-5' },
        maxOutputTokens: 8192
      })
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.segments).toHaveLength(3)
    expect(result.model).toBe('gpt-5')
  })

  test('flag on upstream failure logs sanitized error without leaking raw credentials', async () => {
    isRegistryEnabled = true
    mockResolveProviderModel.mockResolvedValue({
      providerId: 'openai-main',
      modelId: 'gpt-5',
      model: { modelId: 'sdk-gpt-5' },
      protocol: 'openai',
      maxOutputTokens: 8192
    })
    mockGenerateText.mockRejectedValue(new Error('401 body echoed Authorization: Bearer sk-live-LEAK'))

    const result = await translateBatchWithConfig({ internalId: 101 }, cfg)

    expect(result.failedBatches).toBe(result.totalBatches)
    const failLog = logEventMock.mock.calls.find((c) => c[0]?.event === 'translate.batch_fetch_failed')
    expect(failLog?.[0]?.error).not.toContain('sk-live-LEAK')
  })

  test('explicit translate profile keeps legacy fetch priority when flag is on', async () => {
    isRegistryEnabled = true
    hasExplicitProfile = true
    mockEchoTranslation()

    await translateBatchWithConfig({ internalId: 101 }, cfg)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockResolveProviderModel).not.toHaveBeenCalled()
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  test('flag off never probes explicit translate profile', async () => {
    isRegistryEnabled = false
    mockEchoTranslation()

    await translateBatchWithConfig({ internalId: 101 }, cfg)

    expect(cfg.translate?.hasExplicitTranslateProfile).not.toHaveBeenCalled()
  })

  test('happy path: returns segments and persists cache via saveTranslation', async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      const reqBody = JSON.parse((init as RequestInit).body as string)
      const segs = JSON.parse(reqBody.messages[0].content as string) as Array<{
        id: string
        text: string
      }>
      const tgts: Record<number, string> = {
        0: '团队你好这是真实段落一。',
        1: '请尽快评审附件文档。',
        2: '感谢你的及时回复。'
      }
      return Promise.resolve(ok(JSON.stringify(segs.map((s, i) => ({ id: s.id, tgt: tgts[i] })))))
    })

    const result = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(result.targetLang).toBe('zh')
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]).toEqual({
      src: 'Hello team this is a real paragraph one.',
      tgt: '团队你好这是真实段落一。'
    })
    expect(result.failedBatches).toBe(0)
    expect(result.totalBatches).toBe(1)
    expect(result.source).toBe('on_demand')
    expect(saveTranslationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        internalId: 101,
        targetLang: 'zh',
        source: 'on_demand'
      })
    )
  })

  test('plaintext fallback converted via plaintextToHtml translates extracted segments', async () => {
    const md =
      'Hello team this is plaintext line one.\nPlease keep this line in the same paragraph.\n\nSecond plaintext paragraph needs translation soon.'
    bodies.set(108, plaintextToHtml(md))
    mockEchoTranslation()

    const result = await translateBatchWithConfig({ internalId: 108 }, cfg)

    expect(result.segments).toEqual([
      {
        src: 'Hello team this is plaintext line one. Please keep this line in the same paragraph.',
        tgt: '译文 0'
      },
      {
        src: 'Second plaintext paragraph needs translation soon.',
        tgt: '译文 1'
      }
    ])
  })

  test('empty or missing body -> E_NO_BODY without fetch', async () => {
    await expect(translateBatchWithConfig({ internalId: 102 }, cfg)).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    await expect(translateBatchWithConfig({ internalId: 99_999 }, cfg)).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('no API key -> E_NO_LLM_KEY without fetch', async () => {
    apiKeyValue = null
    await expect(translateBatchWithConfig({ internalId: 101 }, cfg)).rejects.toMatchObject({
      code: 'E_NO_LLM_KEY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('invalid internalId -> E_INVALID_ARG', async () => {
    await expect(translateBatchWithConfig({ internalId: -1 }, cfg)).rejects.toMatchObject({
      code: 'E_INVALID_ARG'
    })
    await expect(
      translateBatchWithConfig({ internalId: 1.5 as unknown as number }, cfg)
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
  })

  test('non-OK HTTP / network error -> failedBatches=1, empty segments', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'service unavailable'
    })
    const r1 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r1.segments).toEqual([])
    expect(r1.failedBatches).toBe(1)
    expect(r1.totalBatches).toBe(1)

    fetchMock.mockRejectedValueOnce(new TypeError('Network down'))
    const r2 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r2.segments).toEqual([])
    expect(r2.failedBatches).toBe(1)
  })

  test('JSON parse fallback: fenced wrapper and lenient nested unescaped quotes', async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      const segs = JSON.parse(
        JSON.parse((init as RequestInit).body as string).messages[0].content as string
      ) as Array<{ id: string; text: string }>
      const inner = segs.map((s) => ({ id: s.id, tgt: 'tgt' }))
      return Promise.resolve(ok(`Sure:\n\`\`\`json\n${JSON.stringify(inner)}\n\`\`\``))
    })
    const r1 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r1.segments).toHaveLength(3)
    expect(r1.failedBatches).toBe(0)

    fetchMock.mockImplementationOnce((_url, init) => {
      const segs = JSON.parse(
        JSON.parse((init as RequestInit).body as string).messages[0].content as string
      ) as Array<{ id: string; text: string }>
      const parts = segs.map((s, i) =>
        i === 0 ? `{"id":"${s.id}","tgt":""产品" 的中文翻译"}` : `{"id":"${s.id}","tgt":"翻译 ${i}"}`
      )
      return Promise.resolve(ok(`[${parts.join(',')}]`))
    })
    const r2 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r2.segments).toHaveLength(3)
    expect(r2.segments[0]?.tgt).toContain('产品')

    fetchMock.mockResolvedValueOnce(ok('not JSON at all'))
    const r3 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r3.segments).toEqual([])
    expect(r3.failedBatches).toBe(1)
  })

  test('abortAllTranslations during inflight rejects fetch', async () => {
    let captured: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url, init) => {
      captured = (init as RequestInit).signal as AbortSignal | undefined
      return new Promise((_resolve, reject) => {
        captured?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const p = translateBatchWithConfig({ internalId: 101 }, cfg)
    setTimeout(() => abortAllTranslations(), 5)
    const result = await p
    expect(captured?.aborted).toBe(true)
    expect(result.failedBatches).toBeGreaterThan(0)
  })

  test('batch assembly respects count cap (11 -> [10,1]) and char budget (4x800 -> [3,1])', async () => {
    bodies.set(
      103,
      htmlParagraphs(11, (i) => `This is short translatable paragraph number ${i} for batching.`)
    )
    const calls1: Array<{ count: number; chars: number }> = []
    mockEchoTranslation(calls1)
    const r1 = await translateBatchWithConfig({ internalId: 103 }, cfg)
    expect(r1.totalBatches).toBe(2)
    expect(calls1.map((c) => c.count)).toEqual([10, 1])

    bodies.set(104, htmlParagraphs(4, (i) => exactEnglishText(`Long paragraph ${i}. `, 800)))
    const calls2: Array<{ count: number; chars: number }> = []
    mockEchoTranslation(calls2)
    const r2 = await translateBatchWithConfig({ internalId: 104 }, cfg)
    expect(r2.totalBatches).toBe(2)
    expect(calls2.map((c) => c.count)).toEqual([3, 1])
    expect(calls2.map((c) => c.chars)).toEqual([2400, 800])
  })

  test('propagates cacheKept from saveTranslation anti-downgrade guard', async () => {
    saveTranslationMock.mockResolvedValueOnce({ cacheKept: true, fetchedAt: 555 })
    mockEchoTranslation()

    const r1 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r1.cacheKept).toBe(true)
    expect(r1.fetchedAt).toBe(555)

    saveTranslationMock.mockResolvedValueOnce({ cacheKept: false, fetchedAt: 777 })
    mockEchoTranslation()
    const r2 = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r2.cacheKept).toBeUndefined()
    expect(r2.fetchedAt).toBe(777)
  })

  test('marks cacheWriteFailed and fetchedAt=null when saveTranslation rejects', async () => {
    saveTranslationMock.mockRejectedValueOnce(new Error('db busy'))
    mockEchoTranslation()

    const r = await translateBatchWithConfig({ internalId: 101 }, cfg)
    expect(r.segments.length).toBeGreaterThan(0)
    expect(r.cacheWriteFailed).toBe(true)
    expect(r.fetchedAt).toBeNull()
    expect(r.cacheKept).toBeUndefined()
  })
})

describe('handleTranslateBatch HTTP contract', () => {
  test('serves POST /api/ai/translate/batch via createAiGatewayServer and maps status codes', async () => {
    mockEchoTranslation()
    const server = createAiGatewayServer(cfg)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`

    // Use node:http directly because global fetch is mocked for LLM calls in this test file.
    const post = (payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
      import('node:http').then(
        ({ request }) =>
          new Promise((resolve, reject) => {
            const raw = JSON.stringify(payload)
            const r = request(
              `${base}/api/ai/translate/batch`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'content-length': String(Buffer.byteLength(raw))
                }
              },
              (resp) => {
                let data = ''
                resp.on('data', (c) => {
                  data += c
                })
                resp.on('end', () => {
                  resolve({ status: resp.statusCode ?? 0, body: JSON.parse(data) })
                })
              }
            )
            r.on('error', reject)
            r.write(raw)
            r.end()
          })
      )

    try {
      const okRes = await post({ internalId: 101, targetLang: 'zh' })
      expect(okRes.status).toBe(200)
      expect((okRes.body.segments as unknown[]).length).toBe(3)

      const badRes = await post({ internalId: -5 })
      expect(badRes.status).toBe(400)
      expect(badRes.body.error).toBe('E_INVALID_ARG')

      const missRes = await post({ internalId: 99_999 })
      expect(missRes.status).toBe(404)
      expect(missRes.body.error).toBe('E_NO_BODY')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('client disconnect aborts inflight upstream LLM fetch', async () => {
    let capturedSignal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url, init) => {
      capturedSignal = (init as RequestInit).signal as AbortSignal | undefined
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          const e = new Error('aborted') as Error & { name: string }
          e.name = 'AbortError'
          reject(e)
        })
      })
    })

    const req = new EventEmitter() as IncomingMessage & EventEmitter
    req.setEncoding = vi.fn()
    let writtenStatus = 0
    const fakeRes = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writableFinished: false,
      writeHead: (status: number) => {
        writtenStatus = status
      },
      end: vi.fn(() => {
        fakeRes.writableEnded = true
      })
    })
    const res = fakeRes as unknown as ServerResponse

    const promise = handleTranslateBatch(req, res, cfg)
    const payload = JSON.stringify({ internalId: 101, targetLang: 'zh' })
    req.emit('data', payload)
    req.emit('end')

    await vi.waitFor(() => {
      expect(capturedSignal).toBeDefined()
    })
    fakeRes.emit('close')
    await promise

    expect(capturedSignal?.aborted).toBe(true)
    expect(writtenStatus).toBe(499)
  })
})
