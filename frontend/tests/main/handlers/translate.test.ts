// Sprint Immersive-Translate — translate.ts handler tests.
//
// 覆盖 10 个轴:
//   1. happy path: extractBlocks → batched LLM → returns segments + writes cache
//   2. empty body_html/body_markdown → E_NO_BODY (before fetch, no API spend)
//   3. missing API key → E_NO_LLM_KEY (before fetch)
//   4. non-OK HTTP for a single batch → failedBatches++ (NOT thrown)
//   5. abort via abortAllTranslations → in-flight batches reject
//   6. JSON parse failure in one batch → that batch failed, others continue
//   7. cache get / delete roundtrip
//   8. batch assembly: count cap + char budget
//   9. cache anti-downgrade guard
//  10. no existing cache still writes normally
//
// Mocks: getDb + resolveDbPath (in-memory better-sqlite3 fixture),
// llm_settings (mocked key + base + model), global fetch.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  mockGenerateText,
  mockGetLlmProviderModelResolver,
  mockGetLlmTranslateApiKey,
  mockIsLlmProviderRegistryEnabled,
  mockResolveProviderModel,
  mockSanitizedUpstreamErrorMessage
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGetLlmProviderModelResolver: vi.fn(),
  mockGetLlmTranslateApiKey: vi.fn(),
  mockIsLlmProviderRegistryEnabled: vi.fn(),
  mockResolveProviderModel: vi.fn(),
  mockSanitizedUpstreamErrorMessage: vi.fn(() => 'HTTP 401 APICallError')
}))

let fixtureDb: Database.Database
let dbDir: string
let dbPath: string

// resolveDbPath drives writeDb()'s new Database(path) inside translate.ts.
// We can't pass `:memory:` because writeDb opens its own connection — distinct
// :memory: databases don't share state. Point both conns at the same on-disk
// file so the test can SELECT what writeDb INSERTed.
vi.mock('../../../src/electron/main/db', () => ({
  getDb: () => fixtureDb,
  closeDb: () => {},
  resolveDbPath: () => dbPath
}))

vi.mock('../../../src/electron/main/llm_settings', () => ({
  getLlmTranslateApiKey: mockGetLlmTranslateApiKey,
  getLlmTranslateBaseUrl: () => 'https://test.llm',
  getLlmTranslateModel: () => 'test-model'
}))

vi.mock('../../../src/electron/main/llm_provider_resolver', () => ({
  getLlmProviderModelResolver: mockGetLlmProviderModelResolver,
  isLlmProviderRegistryEnabled: mockIsLlmProviderRegistryEnabled,
  sanitizedUpstreamErrorMessage: mockSanitizedUpstreamErrorMessage
}))

vi.mock('ai', () => ({
  generateText: mockGenerateText
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp/mailagent-test-logs' }
}))

const fetchMock = vi.fn()
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

const handler = await import('../../../src/electron/main/handlers/translate')

const EMAIL_BODY_HTML_3PARA = `
  <p>Hello team this is a real paragraph one.</p>
  <p>Please review the attached document soon.</p>
  <p>Thanks for your prompt response on this.</p>
`

function buildDb(): Database.Database {
  const db = new Database(dbPath)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE email_metadata (
      internal_id INTEGER PRIMARY KEY,
      message_id TEXT,
      sync_status TEXT,
      created_at REAL,
      updated_at REAL
    );
    CREATE TABLE email_body (
      internal_id INTEGER PRIMARY KEY,
      body_html TEXT,
      body_markdown TEXT
    );
    CREATE TABLE email_translation (
      internal_id INTEGER PRIMARY KEY,
      target_lang TEXT NOT NULL DEFAULT 'zh',
      segments_json TEXT NOT NULL,
      model TEXT,
      source TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      CHECK (source IN ('llm_agent','on_demand')),
      FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
    );
  `)
  db.prepare('INSERT INTO email_metadata VALUES (?,?,?,?,?)').run(101, 'm101@x', 'pending', 1, 1)
  db.prepare('INSERT INTO email_metadata VALUES (?,?,?,?,?)').run(102, 'm102@x', 'pending', 1, 1)
  db.prepare('INSERT INTO email_body VALUES (?,?,?)').run(101, EMAIL_BODY_HTML_3PARA, '')
  db.prepare('INSERT INTO email_body VALUES (?,?,?)').run(102, '', '')
  return db
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'mailagent-translate-test-'))
  dbPath = join(dbDir, 'sync_store.db')
  fixtureDb = buildDb()
  vi.clearAllMocks()
  delete process.env.LLM_TRANSLATE_API_KEY
  delete process.env.LLM_TRANSLATE_BASE_URL
  mockGetLlmTranslateApiKey.mockResolvedValue('test-key')
  mockIsLlmProviderRegistryEnabled.mockReturnValue(false)
  mockResolveProviderModel.mockResolvedValue({
    providerId: 'default',
    modelId: 'test-model',
    model: { modelId: 'sdk-test-model' },
    protocol: 'anthropic',
    maxOutputTokens: 64_000
  })
  mockGetLlmProviderModelResolver.mockResolvedValue({ resolve: mockResolveProviderModel })
})

afterEach(() => {
  fetchMock.mockReset()
  // Drop the writable cache conn too (singleton would otherwise leak across
  // tests pointing at a stale db file).
  handler.closeTranslateDb()
  fixtureDb?.close()
  rmSync(dbDir, { recursive: true, force: true })
})

function ok(text: string): { ok: true; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
      model: 'test-model'
    })
  }
}

function insertEmail(
  internalId: number,
  bodyHtml: string | null,
  bodyMarkdown: string | null = ''
): void {
  fixtureDb
    .prepare('INSERT INTO email_metadata VALUES (?,?,?,?,?)')
    .run(internalId, `m${internalId}@x`, 'pending', 1, 1)
  fixtureDb.prepare('INSERT INTO email_body VALUES (?,?,?)').run(internalId, bodyHtml, bodyMarkdown)
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

function seedTranslationCache(internalId: number, count: number): void {
  const oldSegments = Array.from({ length: count }, (_, i) => ({
    src: `old src ${i}`,
    tgt: `old tgt ${i}`
  }))
  fixtureDb
    .prepare(
      `INSERT INTO email_translation
         (internal_id, target_lang, segments_json, model, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(internalId, 'zh', JSON.stringify(oldSegments), 'old-model', 'llm_agent', 1, 1)
}

function cachedSegmentCount(internalId: number): number {
  const row = fixtureDb
    .prepare('SELECT segments_json FROM email_translation WHERE internal_id = ?')
    .get(internalId) as { segments_json: string } | undefined
  if (!row) return 0
  return (JSON.parse(row.segments_json) as unknown[]).length
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

describe('translateBatch', () => {
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

    await handler.translateBatch({ internalId: 101 })

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
    mockIsLlmProviderRegistryEnabled.mockReturnValue(true)
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
        finishReason: 'stop'
      }
    })

    const result = await handler.translateBatch({ internalId: 101 })

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

  test('flag on upstream failure logs via the sanitizer, never the raw message (MEDIUM-4)', async () => {
    mockIsLlmProviderRegistryEnabled.mockReturnValue(true)
    mockResolveProviderModel.mockResolvedValue({
      providerId: 'openai-main',
      modelId: 'gpt-5',
      model: { modelId: 'sdk-gpt-5' },
      protocol: 'openai',
      maxOutputTokens: 8192
    })
    const leaky = new Error('401 body echoed Authorization: Bearer sk-live-LEAK')
    mockGenerateText.mockRejectedValue(leaky)

    const result = await handler.translateBatch({ internalId: 101 })

    expect(result.failedBatches).toBe(result.totalBatches)
    expect(mockSanitizedUpstreamErrorMessage).toHaveBeenCalledWith(leaky)
  })

  test('explicit translate profile keeps legacy fetch priority when flag is on', async () => {
    mockIsLlmProviderRegistryEnabled.mockReturnValue(true)
    process.env.LLM_TRANSLATE_BASE_URL = 'https://translate-only.example'
    mockEchoTranslation()

    await handler.translateBatch({ internalId: 101 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockGetLlmProviderModelResolver).not.toHaveBeenCalled()
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  test('happy path: returns segments matching extracted blocks + writes cache', async () => {
    // The handler builds the user JSON [{id, text}, ...]; the LLM must echo
    // ids back. We capture the request to recover the ids it generated.
    fetchMock.mockImplementationOnce((_url, init) => {
      const reqBody = JSON.parse((init as RequestInit).body as string)
      const userContent = reqBody.messages[0].content
      const segs = JSON.parse(userContent) as Array<{ id: string; text: string }>
      const tgts: Record<number, string> = {
        0: '团队你好这是真实段落一。',
        1: '请尽快评审附件文档。',
        2: '感谢你的及时回复。'
      }
      const out = segs.map((s, i) => ({ id: s.id, tgt: tgts[i] ?? `tgt-${i}` }))
      return Promise.resolve(ok(JSON.stringify(out)))
    })

    const result = await handler.translateBatch({ internalId: 101 })
    expect(result.targetLang).toBe('zh')
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]).toEqual({
      src: 'Hello team this is a real paragraph one.',
      tgt: '团队你好这是真实段落一。'
    })
    expect(result.failedBatches).toBe(0)
    expect(result.totalBatches).toBe(1)
    expect(result.source).toBe('on_demand')
    // Cache written
    const cached = fixtureDb
      .prepare('SELECT segments_json, source FROM email_translation WHERE internal_id = ?')
      .get(101) as { segments_json: string; source: string }
    expect(cached.source).toBe('on_demand')
    expect(JSON.parse(cached.segments_json)).toHaveLength(3)
  })

  test('empty body_html/body_markdown → E_NO_BODY, never hits fetch', async () => {
    await expect(handler.translateBatch({ internalId: 102 })).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('body_html NULL + body_markdown plaintext → translates extracted segments', async () => {
    insertEmail(
      108,
      null,
      'Hello team this is plaintext line one.\nPlease keep this line in the same paragraph.\n\nSecond plaintext paragraph needs translation soon.'
    )
    mockEchoTranslation()

    const result = await handler.translateBatch({ internalId: 108 })

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
    expect(result.failedBatches).toBe(0)
    expect(result.totalBatches).toBe(1)
  })

  test('body_html NULL + body_markdown NULL → E_NO_BODY, never hits fetch', async () => {
    insertEmail(109, null, null)

    await expect(handler.translateBatch({ internalId: 109 })).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('missing email_body row → E_NO_BODY', async () => {
    await expect(handler.translateBatch({ internalId: 99_999 })).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('no API key → E_NO_LLM_KEY, never hits fetch', async () => {
    mockGetLlmTranslateApiKey.mockResolvedValueOnce(null)
    await expect(handler.translateBatch({ internalId: 101 })).rejects.toMatchObject({
      code: 'E_NO_LLM_KEY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('invalid internalId → E_INVALID_ARG', async () => {
    await expect(handler.translateBatch({ internalId: -1 })).rejects.toMatchObject({
      code: 'E_INVALID_ARG'
    })
    await expect(
      handler.translateBatch({ internalId: 1.5 as unknown as number })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
  })

  test('non-OK HTTP for the single batch → failedBatches=1, empty segments', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable'
    })
    const result = await handler.translateBatch({ internalId: 101 })
    expect(result.segments).toEqual([])
    expect(result.failedBatches).toBe(1)
    expect(result.totalBatches).toBe(1)
  })

  test('fetch network error → batch fails silently, returns empty segments', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network down'))
    const result = await handler.translateBatch({ internalId: 101 })
    expect(result.segments).toEqual([])
    expect(result.failedBatches).toBe(1)
  })

  test('JSON parse fallback: malformed wrapper text recovers the inner [...]', async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      const segs = JSON.parse(
        JSON.parse((init as RequestInit).body as string).messages[0].content as string
      ) as Array<{ id: string; text: string }>
      const inner = segs.map((s) => ({ id: s.id, tgt: 'tgt' }))
      // Wrap in chatter that JSON.parse cannot eat — regex fallback must recover.
      return Promise.resolve(
        ok(`Sure! Here is the JSON:\n\`\`\`json\n${JSON.stringify(inner)}\n\`\`\``)
      )
    })
    const result = await handler.translateBatch({ internalId: 101 })
    expect(result.segments).toHaveLength(3)
    expect(result.failedBatches).toBe(0)
  })

  test('truly unparseable output → batch fails, returns empty segments', async () => {
    fetchMock.mockResolvedValue(ok('this is not JSON at all and has no brackets'))
    const result = await handler.translateBatch({ internalId: 101 })
    expect(result.segments).toEqual([])
    expect(result.failedBatches).toBe(1)
  })

  test('lenient rescue: tgt with unescaped nested quotes still parses (real-world LLM bug)', async () => {
    // Real LLM output captured 2026-05-22 (translate.log internalId=54094):
    // LLM emitted `""思科 PCI 合规解决方案""` with unescaped quotes inside tgt,
    // crashing strict JSON.parse and dumping a 10-segment batch. Lenient
    // parser must rescue id-anchored items.
    fetchMock.mockImplementationOnce((_url, init) => {
      const reqBody = JSON.parse((init as RequestInit).body as string)
      const userContent = reqBody.messages[0].content as string
      const segs = JSON.parse(userContent) as Array<{ id: string; text: string }>
      // Build a malformed response — first tgt has unescaped quotes, others
      // are fine. Strict JSON.parse will fail on the whole thing; lenient
      // rescue must still get the segments back.
      const parts = segs.map((s, i) => {
        if (i === 0) return `{"id":"${s.id}","tgt":""产品" 的中文翻译"}`
        return `{"id":"${s.id}","tgt":"翻译 ${i}"}`
      })
      return Promise.resolve(ok(`[${parts.join(',')}]`))
    })
    const result = await handler.translateBatch({ internalId: 101 })
    // 3 segments extracted from EMAIL_BODY_HTML_3PARA. Lenient parser
    // recovers all 3 ids despite the JSON syntax error on the first.
    expect(result.segments).toHaveLength(3)
    expect(result.failedBatches).toBe(0)
    // First segment's tgt contains the rescued content (quotes preserved
    // since we trim escape syntax, not the content itself).
    expect(result.segments[0]?.tgt).toContain('产品')
  })

  test('abortAllTranslations during inflight → batches reject', async () => {
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
    const p = handler.translateBatch({ internalId: 101 })
    setTimeout(() => handler.abortAllTranslations(), 5)
    const result = await p
    // Aborted batches show up as failures; segments empty.
    expect(captured?.aborted).toBe(true)
    expect(result.failedBatches).toBeGreaterThan(0)
  })

  test('batch assembly respects count cap: 11 short blocks → 2 batches', async () => {
    insertEmail(
      103,
      htmlParagraphs(11, (i) => `This is short translatable paragraph number ${i} for batching.`)
    )
    const calls: Array<{ count: number; chars: number }> = []
    mockEchoTranslation(calls)

    const result = await handler.translateBatch({ internalId: 103 })

    expect(result.totalBatches).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calls.map((c) => c.count)).toEqual([10, 1])
  })

  test('batch assembly respects char budget: 4 x 800-char blocks → 2 batches (3 + 1)', async () => {
    insertEmail(
      104,
      htmlParagraphs(4, (i) => exactEnglishText(`Long paragraph ${i}. `, 800))
    )
    const calls: Array<{ count: number; chars: number }> = []
    mockEchoTranslation(calls)

    const result = await handler.translateBatch({ internalId: 104 })

    expect(result.totalBatches).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calls.map((c) => c.count)).toEqual([3, 1])
    expect(calls.map((c) => c.chars)).toEqual([2400, 800])
  })

  test('cache guard keeps old row when fresh result has fewer segments', async () => {
    insertEmail(
      105,
      htmlParagraphs(2, (i) => `This downgrade test paragraph ${i} should translate.`)
    )
    seedTranslationCache(105, 5)
    mockEchoTranslation()

    const result = await handler.translateBatch({ internalId: 105 })

    expect(result.segments).toHaveLength(2)
    expect(result.cacheKept).toBe(true)
    expect(cachedSegmentCount(105)).toBe(5)
  })

  test('cache guard overwrites old row when fresh result has more segments', async () => {
    insertEmail(
      106,
      htmlParagraphs(8, (i) => `This upgrade test paragraph ${i} should translate.`)
    )
    seedTranslationCache(106, 5)
    mockEchoTranslation()

    const result = await handler.translateBatch({ internalId: 106 })

    expect(result.segments).toHaveLength(8)
    expect(result.cacheKept).toBeUndefined()
    expect(cachedSegmentCount(106)).toBe(8)
  })

  test('cache guard writes normally when no old row exists', async () => {
    insertEmail(
      107,
      htmlParagraphs(2, (i) => `This fresh cache paragraph ${i} should translate.`)
    )
    mockEchoTranslation()

    const result = await handler.translateBatch({ internalId: 107 })

    expect(result.segments).toHaveLength(2)
    expect(result.cacheKept).toBeUndefined()
    expect(cachedSegmentCount(107)).toBe(2)
  })
})
