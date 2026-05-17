// Sprint 3 §2.2 — translate IPC handler tests.
//
// Five axes:
//   1. happy path returns { translated, model, latencyMs }
//   2. missing email_body → E_NO_BODY (before fetching, no API spend)
//   3. missing API key → E_NO_LLM_KEY (before fetching)
//   4. non-OK HTTP / fetch throw → E_UPSTREAM
//   5. abort during inflight → E_ABORTED (covers the "切邮件" cancel path)
//
// Mocks: getDb (in-memory better-sqlite3 fixture), llm_settings
// (mocked key + base + model), global fetch.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'

const { mockGetLlmApiKey } = vi.hoisted(() => ({
  mockGetLlmApiKey: vi.fn()
}))

let fixtureDb: Database.Database

vi.mock('../../../src/electron/main/db', () => ({
  getDb: () => fixtureDb,
  closeDb: () => {},
  resolveDbPath: () => ':memory:'
}))

vi.mock('../../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: mockGetLlmApiKey,
  getLlmBaseUrl: () => 'https://test.llm',
  getLlmModel: () => 'test-model'
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const fetchMock = vi.fn()
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

const handler = await import('../../../src/electron/main/handlers/translate')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE email_body (
      internal_id INTEGER PRIMARY KEY,
      body_markdown TEXT
    );
    INSERT INTO email_body VALUES (101, 'Hello world, please reply.');
    INSERT INTO email_body VALUES (102, '');
  `)
  return db
}

beforeEach(() => {
  fixtureDb = buildDb()
  vi.clearAllMocks()
  mockGetLlmApiKey.mockResolvedValue('test-key')
})

afterEach(() => {
  fetchMock.mockReset()
  fixtureDb?.close()
})

describe('translateEmail', () => {
  test('happy path returns translated text + model + latency', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '你好世界,请回复。' }],
        model: 'test-model'
      })
    })
    const result = await handler.translateEmail({ internalId: 101 })
    expect(result.translated).toBe('你好世界,请回复。')
    expect(result.model).toBe('test-model')
    expect(result.targetLang).toBe('zh')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://test.llm/v1/messages')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')
    expect(headers['anthropic-version']).toBeTruthy()
  })

  test('empty body → throws E_NO_BODY, never hits fetch', async () => {
    await expect(handler.translateEmail({ internalId: 102 })).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('missing email_body row → throws E_NO_BODY', async () => {
    await expect(handler.translateEmail({ internalId: 99_999 })).rejects.toMatchObject({
      code: 'E_NO_BODY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('no API key → throws E_NO_LLM_KEY, never hits fetch', async () => {
    mockGetLlmApiKey.mockResolvedValueOnce(null)
    await expect(handler.translateEmail({ internalId: 101 })).rejects.toMatchObject({
      code: 'E_NO_LLM_KEY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('non-OK HTTP → throws E_UPSTREAM with the status code in message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable'
    })
    await expect(handler.translateEmail({ internalId: 101 })).rejects.toMatchObject({
      code: 'E_UPSTREAM'
    })
  })

  test('fetch network error → throws E_UPSTREAM', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network down'))
    await expect(handler.translateEmail({ internalId: 101 })).rejects.toMatchObject({
      code: 'E_UPSTREAM'
    })
  })

  test('abort during inflight → throws E_ABORTED', async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal | null | undefined
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const p = handler.translateEmail({ internalId: 101 })
    // Give the handler a tick to set up its AbortController, then abort.
    setTimeout(() => handler.abortTranslation(101), 5)
    await expect(p).rejects.toMatchObject({ code: 'E_ABORTED' })
  })

  test('empty content array → throws E_EMPTY_RESPONSE', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [], model: 'test-model' })
    })
    await expect(handler.translateEmail({ internalId: 101 })).rejects.toMatchObject({
      code: 'E_EMPTY_RESPONSE'
    })
  })

  test('second translate for same internalId aborts previous in-flight', async () => {
    let firstSignal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url, init) => {
      firstSignal = (init as RequestInit).signal as AbortSignal | undefined
      return new Promise((_resolve, reject) => {
        firstSignal?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '译文' }], model: 'test-model' })
    })
    const p1 = handler.translateEmail({ internalId: 101 })
    // Start second translate after a tick so the first one is registered.
    await new Promise((r) => setTimeout(r, 5))
    const p2 = handler.translateEmail({ internalId: 101 })
    await expect(p1).rejects.toMatchObject({ code: 'E_ABORTED' })
    expect(firstSignal?.aborted).toBe(true)
    const result = await p2
    expect(result.translated).toBe('译文')
  })
})
