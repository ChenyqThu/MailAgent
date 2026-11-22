// @vitest-environment happy-dom
//
// 同步历史邮件 API 层 (task 09-11)：HttpApi 与 ElectronApi 的 historySync 三个方法。
//   - HttpApi：method / 路径 / body 与 design §5 契约一致，envelope 解包，错误带 code 抛出
//   - ElectronApi：invoke 的 channel 与参数，WriteEnvelope unwrap，错误带 code 抛出
// fetch 与 window.electron.ipcRenderer 全部 stub。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ElectronApi } from '@shared/api/ElectronApi'
import { HttpApi } from '@shared/api/HttpApi'
import type { HistorySyncState } from '@shared/api/types'

const STATE: HistorySyncState = {
  supported: true,
  unsupported_reason: null,
  backend: 'davmail',
  defaults: { since: '2026-08-28', until: '2026-09-11' },
  max_days: 365,
  notion_enabled: false,
  notion_floor: null,
  job: null
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function errorEnvelope(code: string, status: number): Response {
  return new Response(
    JSON.stringify({
      status: 'error',
      schema_version: 1,
      data: null,
      error: { code, message: 'x' }
    }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}

let fetchMock: ReturnType<typeof vi.fn>
let invokeMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  invokeMock = vi.fn()
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: invokeMock, send: vi.fn(), on: vi.fn(() => () => undefined) }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { electron?: unknown }).electron
})

function fetchCall(): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
  return {
    url: String(url),
    method: String(init?.method ?? 'GET'),
    body: init?.body != null ? JSON.parse(String(init.body)) : undefined
  }
}

describe('HttpApi.historySync', () => {
  const api = new HttpApi('/api')

  test('get → GET /api/history-sync，解包状态', async () => {
    fetchMock.mockResolvedValue(envelope(STATE))
    const out = await api.historySync.get()
    const call = fetchCall()
    expect(call.method).toBe('GET')
    expect(call.url).toMatch(/\/api\/history-sync$/)
    expect(out).toEqual(STATE)
  })

  test('start → POST /api/history-sync {since, until}', async () => {
    fetchMock.mockResolvedValue(envelope({ job_id: 7, was_created: true }))
    const out = await api.historySync.start({ since: '2026-08-01', until: '2026-08-31' })
    const call = fetchCall()
    expect(call.method).toBe('POST')
    expect(call.url).toMatch(/\/api\/history-sync$/)
    expect(call.body).toEqual({ since: '2026-08-01', until: '2026-08-31' })
    expect(out).toEqual({ job_id: 7, was_created: true })
  })

  test('cancel → POST /api/history-sync/cancel', async () => {
    fetchMock.mockResolvedValue(envelope({ job_id: 7, cancel_requested: true }))
    const out = await api.historySync.cancel()
    const call = fetchCall()
    expect(call.method).toBe('POST')
    expect(call.url).toMatch(/\/api\/history-sync\/cancel$/)
    expect(out).toEqual({ job_id: 7, cancel_requested: true })
  })

  test('没有进行中的任务时取消 → 抛 E_NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(errorEnvelope('E_NOT_FOUND', 404))
    await expect(api.historySync.cancel()).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })
})

describe('ElectronApi.historySync', () => {
  test('get → loopback GET http://127.0.0.1:8200/api/history-sync，零 IPC', async () => {
    fetchMock.mockResolvedValue(envelope(STATE))
    const out = await new ElectronApi().historySync.get()
    const call = fetchCall()
    expect(call.method).toBe('GET')
    expect(call.url).toBe('http://127.0.0.1:8200/api/history-sync')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(out).toEqual(STATE)
  })

  test('start → loopback POST /api/history-sync 带 {since, until}，零 IPC', async () => {
    fetchMock.mockResolvedValue(envelope({ job_id: 8, was_created: false }))
    const out = await new ElectronApi().historySync.start({
      since: '2026-08-01',
      until: '2026-08-31'
    })
    const call = fetchCall()
    expect(call.method).toBe('POST')
    expect(call.url).toBe('http://127.0.0.1:8200/api/history-sync')
    expect(call.body).toEqual({ since: '2026-08-01', until: '2026-08-31' })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(out).toEqual({ job_id: 8, was_created: false })
  })

  test('cancel → loopback POST /api/history-sync/cancel，零 IPC', async () => {
    fetchMock.mockResolvedValue(envelope({ job_id: 8, cancel_requested: true }))
    const out = await new ElectronApi().historySync.cancel()
    const call = fetchCall()
    expect(call.method).toBe('POST')
    expect(call.url).toBe('http://127.0.0.1:8200/api/history-sync/cancel')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(out).toEqual({ job_id: 8, cancel_requested: true })
  })

  test('错误 envelope → 抛带 code 的 Error', async () => {
    fetchMock.mockResolvedValue(errorEnvelope('E_INVALID_ARG', 400))
    await expect(
      new ElectronApi().historySync.start({ since: '2026-09-02', until: '2026-09-01' })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG', message: 'x' })
  })
})
