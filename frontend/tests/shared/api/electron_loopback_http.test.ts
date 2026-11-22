// @vitest-environment happy-dom
//
// Wave 1A loopback HTTP unification tests:
//   - HttpApi({ retryNetworkOnce: true }) cold-start GET retry + write/business non-retry
//   - llm.stats / kos.stats days clamping & report.createAgent description forwarding
//   - ElectronApi loopback HTTP routing across 9 domains + preserved native/legacy IPC overrides
//   - onboarding/ipc.ts discoverFolders / setFolderWhitelist via loopback HTTP

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ElectronApi, loopbackBaseUrl } from '@shared/api/ElectronApi'
import { HttpApi } from '@shared/api/HttpApi'
import { discoverFolders, setFolderWhitelist } from '../../../src/electron/renderer/onboarding/ipc'

function setSearch(search: string): void {
  window.history.replaceState({}, '', `${window.location.pathname}${search}`)
}

function okEnvelope(data: unknown, meta?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ status: 'success', schema_version: 1, data, ...(meta ? { meta } : {}) }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

function errEnvelope(code: string, status: number, message = 'err'): Response {
  return new Response(
    JSON.stringify({ status: 'error', schema_version: 1, data: null, error: { code, message } }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}

let fetchMock: ReturnType<typeof vi.fn>
let invokeMock: ReturnType<typeof vi.fn>
let sendMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  setSearch('')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  invokeMock = vi.fn()
  sendMock = vi.fn()
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: invokeMock, send: sendMock, on: vi.fn(() => () => undefined) }
  }
})

afterEach(() => {
  setSearch('')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as unknown as { electron?: unknown }).electron
})

describe('HttpApi loopback resilience & parity options', () => {
  test('retryNetworkOnce: GET retries once after 250ms on E_NETWORK then succeeds', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okEnvelope({ healthy: true }))

    const api = new HttpApi('http://127.0.0.1:8200/api', { retryNetworkOnce: true })
    const promise = api.llm.selftest()

    await vi.advanceTimersByTimeAsync(250)
    await expect(promise).resolves.toEqual({ healthy: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('retryNetworkOnce: GET does not retry more than once', async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValue(new TypeError('connect ECONNREFUSED'))

    const api = new HttpApi('http://127.0.0.1:8200/api', { retryNetworkOnce: true })
    const promise = api.kos.stats(7)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'E_NETWORK' })

    await vi.advanceTimersByTimeAsync(250)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('retryNetworkOnce: GET does NOT retry on business or HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(errEnvelope('E_INVALID_ARG', 400))
    const api = new HttpApi('http://127.0.0.1:8200/api', { retryNetworkOnce: true })
    await expect(api.folder.discover()).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500, statusText: 'Err' }))
    await expect(api.admin.stats()).rejects.toMatchObject({ code: 'E_INTERNAL' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('retryNetworkOnce: writes (POST/PUT/PATCH/DELETE) NEVER retry on E_NETWORK', async () => {
    fetchMock.mockRejectedValue(new TypeError('ECONNREFUSED'))
    const api = new HttpApi('http://127.0.0.1:8200/api', { retryNetworkOnce: true })

    await expect(api.today.dismiss([1])).rejects.toMatchObject({ code: 'E_NETWORK' })
    await expect(api.folder.setWhitelist(['Sent'])).rejects.toMatchObject({ code: 'E_NETWORK' })
    await expect(api.folder.renameFolder('Old', 'New')).rejects.toMatchObject({ code: 'E_NETWORK' })
    await expect(api.report.delete('rep-1')).rejects.toMatchObject({ code: 'E_NETWORK' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  test('default HttpApi without retryNetworkOnce does NOT retry GET on E_NETWORK', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
    const api = new HttpApi('/api')
    await expect(api.llm.selftest()).rejects.toMatchObject({ code: 'E_NETWORK' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('llm.stats & kos.stats clamp days into [1, 365] and fallback NaN → 7', async () => {
    fetchMock.mockImplementation(async () => okEnvelope({}))
    const api = new HttpApi('/api')

    await api.llm.stats(0)
    await api.llm.stats(999)
    await api.kos.stats(Number.NaN)
    await api.kos.stats(-5)

    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual([
      '/api/llm/stats?days=1',
      '/api/llm/stats?days=365',
      '/api/kos/stats?days=7',
      '/api/kos/stats?days=1'
    ])
  })

  test('report.createAgent forwards description only when defined', async () => {
    fetchMock.mockImplementation(async () => okEnvelope({ id: 'a1' }))
    const api = new HttpApi('/api')

    await api.report.createAgent({ id: 'a1', title: 'T', description: 'Agent desc' })
    await api.report.createAgent({ id: 'a2', title: 'T2' })

    const body1 = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<
      string,
      unknown
    >
    const body2 = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as Record<
      string,
      unknown
    >
    expect(body1.description).toBe('Agent desc')
    expect('description' in body2).toBe(false)
  })
})

describe('ElectronApi loopback HTTP routing across 9 domains', () => {
  test('loopbackBaseUrl injects ?apiPort=N and defaults to 8200', () => {
    setSearch('')
    expect(loopbackBaseUrl()).toBe('http://127.0.0.1:8200/api')
    setSearch('?apiPort=9321')
    expect(loopbackBaseUrl()).toBe('http://127.0.0.1:9321/api')
  })

  test('all migrated domains hit loopback serve-api with zero IPC invoke calls', async () => {
    setSearch('?apiPort=9321')
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/email/contacts')) return okEnvelope({ items: [{ email: 'a@b.com', score: 1 }] })
      if (url.includes('/reports?') || url.endsWith('/reports')) {
        return okEnvelope([{ id: 'r1' }], { total: 1 })
      }
      return okEnvelope({})
    })

    const api = new ElectronApi()
    await api.today.get({ tz: 'Asia/Shanghai', replyLimit: 5 })
    await api.folder.setWhitelist(['Work'])
    await api.kos.stats(14)
    await api.jobs.get(42)
    await api.llm.selftest()
    await api.llm.run(7, { force: true })
    const contacts = await api.email.contactSuggest('ali', 5, ['me@b.com'])
    const reports = await api.report.list({ limit: 10 })
    await api.calendar.eventsList({ calendarName: 'Work' })
    await api.calendar.eventCreate({
      summary: 'Sync',
      startIso: '2026-11-22T09:00:00Z',
      endIso: '2026-11-22T10:00:00Z'
    })
    await api.admin.deadLetterList({ limit: 20 })
    await api.admin.davmailHealth()
    await api.admin.systemAlerts()

    expect(contacts).toEqual([{ email: 'a@b.com', score: 1 }])
    expect(reports).toEqual({ items: [{ id: 'r1' }], total: 1 })
    expect(invokeMock).not.toHaveBeenCalled()

    const calls = fetchMock.mock.calls.map(([u, init]) => [
      String((init as RequestInit | undefined)?.method ?? 'GET'),
      String(u)
    ])
    expect(calls).toEqual([
      ['GET', 'http://127.0.0.1:9321/api/today?tz=Asia%2FShanghai&replyLimit=5'],
      ['PUT', 'http://127.0.0.1:9321/api/folder/whitelist'],
      ['GET', 'http://127.0.0.1:9321/api/kos/stats?days=14'],
      ['GET', 'http://127.0.0.1:9321/api/jobs/42'],
      ['GET', 'http://127.0.0.1:9321/api/llm/selftest'],
      ['POST', 'http://127.0.0.1:9321/api/llm/run/7?force=true'],
      ['GET', 'http://127.0.0.1:9321/api/email/contacts?q=ali&limit=5&exclude=me%40b.com'],
      ['GET', 'http://127.0.0.1:9321/api/reports?limit=10'],
      ['GET', 'http://127.0.0.1:9321/api/calendar/events?calendarName=Work'],
      ['POST', 'http://127.0.0.1:9321/api/calendar/events'],
      ['GET', 'http://127.0.0.1:9321/api/admin/dead-letter?limit=20'],
      ['GET', 'http://127.0.0.1:9321/api/admin/davmail-health'],
      ['GET', 'http://127.0.0.1:9321/api/admin/system-alerts']
    ])
  })

  test('preserves native/legacy IPC overrides for admin, report.openDetached, and legacy calendar ops', async () => {
    setSearch('?apiPort=9321')
    fetchMock.mockImplementation(async () => okEnvelope({ healthy: true }))
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'admin:dbPath') return '/Users/me/sync_store.db'
      if (channel === 'admin:exportDiagnostics') return { saved: true, path: '/tmp/diag.zip' }
      if (channel === 'calendar:recurringDiscover') return []
      return { ok: true, data: { replayed: 1 } }
    })

    const api = new ElectronApi()
    const health = await api.admin.health()
    expect(health).toEqual({ healthy: true, db_path: '/Users/me/sync_store.db' })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9321/api/admin/health', expect.anything())

    const exported = await api.admin.exportDiagnostics?.()
    expect(exported).toEqual({ saved: true, path: '/tmp/diag.zip' })

    api.report.openDetached('rep-42')
    expect(sendMock).toHaveBeenCalledWith('window:openDetached', 'report', 'rep-42')

    await api.calendar.recurringDiscover({ since: '2026-10-01' })
    await api.calendar.recurringReplay({ internalId: 12 })
    await api.calendar.expand({ dryRun: true })

    expect(invokeMock.mock.calls).toEqual([
      ['admin:dbPath'],
      ['admin:exportDiagnostics'],
      ['calendar:recurringDiscover', { since: '2026-10-01' }],
      ['calendar:recurringReplay', { internalId: 12 }],
      ['calendar:expand', { dryRun: true }]
    ])
  })

  test('Wave 1B: 11 migrated email write/compose methods hit loopback HTTP with zero IPC calls', async () => {
    setSearch('?apiPort=9321')
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pin')) {
        return okEnvelope({ internal_id: 7, is_pinned: true, changed: true, dry_run: false })
      }
      if (url.includes('/compose-attachment')) {
        return okEnvelope({ stage_id: 's1', filename: 'a.pdf', size: 3, mime: 'application/pdf' })
      }
      return okEnvelope({ ok: true })
    })

    const api = new ElectronApi()
    await api.email.resync(7, { replaceExisting: true })
    const pinned = await api.email.pin(7, true)
    await api.email.archive(7)
    await api.email.flag(7, { isFlagged: true, processingStatus: '' })
    await api.email.flag(null, { ids: [1, 2], isRead: true })
    await api.email.batchResync([1, 2])
    await api.email.draft({ internalId: 7, mode: 'reply', bodyHtml: '<p>hi</p>' })
    await api.email.deleteDraft(7)
    await api.email.send({ internalId: 7, mode: 'reply', bodyHtml: '<p>go</p>' })
    await api.email.draftPlan({ internalId: 7, mode: 'reply' })
    await api.email.setReplySuggestion({ internalId: 7, body: 'Thanks!' })
    await api.email.uploadComposeAttachment({
      filename: 'a.pdf',
      mime: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]).buffer
    })

    expect(pinned).toBe(true)
    expect(invokeMock).not.toHaveBeenCalled()

    const calls = fetchMock.mock.calls.map(([u, init]) => [
      String((init as RequestInit | undefined)?.method ?? 'GET'),
      String(u)
    ])
    expect(calls).toEqual([
      ['POST', 'http://127.0.0.1:9321/api/email/7/resync'],
      ['POST', 'http://127.0.0.1:9321/api/email/7/pin'],
      ['POST', 'http://127.0.0.1:9321/api/email/7/archive'],
      ['POST', 'http://127.0.0.1:9321/api/email/7/flag'],
      ['POST', 'http://127.0.0.1:9321/api/email/0/flag'],
      ['POST', 'http://127.0.0.1:9321/api/jobs'],
      ['POST', 'http://127.0.0.1:9321/api/email/draft'],
      ['DELETE', 'http://127.0.0.1:9321/api/email/draft/7'],
      ['POST', 'http://127.0.0.1:9321/api/email/send'],
      ['POST', 'http://127.0.0.1:9321/api/email/7/draft-plan'],
      ['POST', 'http://127.0.0.1:9321/api/email/7/reply-suggestion'],
      ['PUT', 'http://127.0.0.1:9321/api/email/compose-attachment?filename=a.pdf&mime=application%2Fpdf']
    ])

    // Single flag omits empty processingStatus
    const singleFlagBody = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body)) as Record<
      string,
      unknown
    >
    expect(singleFlagBody).toEqual({ isFlagged: true })

    // Upload sends raw octet-stream bytes
    const uploadInit = fetchMock.mock.calls[11][1] as RequestInit
    expect((uploadInit.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream'
    )
    expect(uploadInit.body).toBeInstanceOf(Uint8Array)

    // pin returns null on E_NOT_FOUND
    fetchMock.mockResolvedValueOnce(errEnvelope('E_NOT_FOUND', 404, 'missing'))
    await expect(api.email.pin(999, true)).resolves.toBeNull()
  })

  test('Wave 1B: preserves email.createDraft AppleScript IPC fallback & routes prompts to loopback HTTP', async () => {
    setSearch('?apiPort=9321')
    invokeMock.mockResolvedValueOnce({
      ok: true,
      data: { internalId: 7, mailbox: '收件箱', accountName: null, draftId: 'reply_all' }
    })
    fetchMock
      .mockResolvedValueOnce(okEnvelope({ slot: 'inbox', path: '/p', exists: true, content: '# hi' }))
      .mockResolvedValueOnce(okEnvelope({ slot: 'inbox', path: '/p', exists: true }))
      .mockResolvedValueOnce(errEnvelope('E_PATH_ESCAPE', 400, 'outside root'))

    const api = new ElectronApi()
    const created = await api.email.createDraft({ internalId: 7, body: 'Hello' })
    expect(created).toEqual({
      internalId: 7,
      mailbox: '收件箱',
      accountName: null,
      draftId: 'reply_all'
    })
    expect(invokeMock).toHaveBeenCalledWith('email:createDraft', { internalId: 7, body: 'Hello' })

    const readRes = await api.prompts.read('inbox')
    expect(readRes).toEqual({ slot: 'inbox', path: '/p', exists: true, content: '# hi' })

    const writeOk = await api.prompts.write('inbox', '# x')
    expect(writeOk).toEqual({ ok: true, info: { slot: 'inbox', path: '/p', exists: true } })

    const writeErr = await api.prompts.write('inbox', '# x')
    expect(writeErr).toEqual({ ok: false, code: 'E_PATH_ESCAPE', message: 'outside root' })

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map((c) => [String((c[1] as RequestInit).method), String(c[0])])).toEqual([
      ['GET', 'http://127.0.0.1:9321/api/prompts/inbox'],
      ['PUT', 'http://127.0.0.1:9321/api/prompts/inbox'],
      ['PUT', 'http://127.0.0.1:9321/api/prompts/inbox']
    ])
  })
})

describe('onboarding/ipc folder functions via loopback HTTP', () => {
  test('discoverFolders & setFolderWhitelist route through loopback HttpApi and propagate ApiError.code', async () => {
    setSearch('?apiPort=9321')
    fetchMock
      .mockResolvedValueOnce(okEnvelope({ backend: 'davmail', folders: [], tree: [], cached: false }))
      .mockResolvedValueOnce(okEnvelope({ folders: ['Work'], restart_required: true }))
      .mockResolvedValueOnce(errEnvelope('E_INVALID_ARG', 400, 'davmail only'))

    const discovered = await discoverFolders(false)
    expect(discovered).toEqual({ backend: 'davmail', folders: [], tree: [], cached: false })

    const saved = await setFolderWhitelist(['Work'])
    expect(saved).toEqual({ folders: ['Work'], restart_required: true })

    await expect(discoverFolders(false)).rejects.toMatchObject({
      code: 'E_INVALID_ARG',
      message: 'davmail only'
    })

    expect(invokeMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://127.0.0.1:9321/api/folder/discover?counts=false&refresh=false'
    )
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://127.0.0.1:9321/api/folder/whitelist')
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT')
  })
})
