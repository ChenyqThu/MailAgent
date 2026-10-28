// @vitest-environment node
//
// DavMail 自助重新认证数据层 mock-fetch 单测（`createDavMailApi`）。
// 测 wire 形状（路径 / method / body 的 snake_case 键）、envelope 解包、错误抛出且 code 透传
// （非 davmail 后端是 409 E_INVALID_STATE，弹窗靠 message 展示原因）。

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createDavMailApi } from '@shared/api/davmail_api'

let fetchMock: ReturnType<typeof vi.fn>
let origFetch: typeof globalThis.fetch

function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

beforeEach(() => {
  origFetch = globalThis.fetch
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

const api = createDavMailApi('/api')

function call(i = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit | undefined]
  const raw = init?.body
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    body: raw == null ? undefined : JSON.parse(String(raw))
  }
}

test('startReauth → POST /api/davmail/reauth/start，原样返回 data', async () => {
  const data = {
    session_id: 's1',
    authorize_url: 'https://login.microsoftonline.com/common/oauth2/authorize?x=1',
    expires_at: 1793000000
  }
  fetchMock.mockResolvedValue(envelopeResponse(data))
  await expect(api.startReauth()).resolves.toEqual(data)
  expect(call()).toEqual({ url: '/api/davmail/reauth/start', method: 'POST', body: undefined })
})

test('completeReauth → POST /complete，body 用 session_id / callback', async () => {
  const data = { ok: false, stage: 'exchange', code: 'AADSTS70008', message: '授权码已过期' }
  fetchMock.mockResolvedValue(envelopeResponse(data))
  await expect(api.completeReauth('s1', ' urn:ietf:wg:oauth:2.0:oob?code=abc ')).resolves.toEqual(
    data
  )
  expect(call()).toEqual({
    url: '/api/davmail/reauth/complete',
    method: 'POST',
    body: { session_id: 's1', callback: ' urn:ietf:wg:oauth:2.0:oob?code=abc ' }
  })
})

test('错误 envelope → 抛错且 code 透传', async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'error',
        schema_version: 1,
        error: { code: 'E_INVALID_STATE', message: '当前邮件后端不是 DavMail，不需要重新认证' }
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    )
  )
  await expect(api.startReauth()).rejects.toMatchObject({ code: 'E_INVALID_STATE' })
})
