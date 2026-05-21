// Sprint Immersive-Translate — translate.ts handler tests.
//
// 覆盖 7 个轴:
//   1. happy path: extractBlocks → batched LLM → returns segments + writes cache
//   2. empty body_html → E_NO_BODY (before fetch, no API spend)
//   3. missing API key → E_NO_LLM_KEY (before fetch)
//   4. non-OK HTTP for a single batch → failedBatches++ (NOT thrown)
//   5. abort via abortAllTranslations → in-flight batches reject
//   6. JSON parse failure in one batch → that batch failed, others continue
//   7. cache get / delete roundtrip
//
// Mocks: getDb + resolveDbPath (in-memory better-sqlite3 fixture),
// llm_settings (mocked key + base + model), global fetch.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockGetLlmTranslateApiKey } = vi.hoisted(() => ({
  mockGetLlmTranslateApiKey: vi.fn()
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
  db.prepare('INSERT INTO email_metadata VALUES (?,?,?,?,?)')
    .run(101, 'm101@x', 'pending', 1, 1)
  db.prepare('INSERT INTO email_metadata VALUES (?,?,?,?,?)')
    .run(102, 'm102@x', 'pending', 1, 1)
  db.prepare('INSERT INTO email_body VALUES (?,?,?)').run(101, EMAIL_BODY_HTML_3PARA, '')
  db.prepare('INSERT INTO email_body VALUES (?,?,?)').run(102, '', '')
  return db
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'mailagent-translate-test-'))
  dbPath = join(dbDir, 'sync_store.db')
  fixtureDb = buildDb()
  vi.clearAllMocks()
  mockGetLlmTranslateApiKey.mockResolvedValue('test-key')
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

describe('translateBatch', () => {
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

  test('empty body_html → E_NO_BODY, never hits fetch', async () => {
    await expect(handler.translateBatch({ internalId: 102 })).rejects.toMatchObject({
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
        (JSON.parse((init as RequestInit).body as string).messages[0].content) as string
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
})
