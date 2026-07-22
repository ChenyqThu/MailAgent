// D1 — http_client.request() 的 opts.headers 注入契约 (daemon_api 据此带本地 token)。
//
// mock global fetch, 验证 opts.headers 合并进请求头且不破坏 Accept / Content-Type /
// credentials —— web 默认路径 (无 opts.headers) 行为零变化。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { request, requestWithMeta } from '../../src/shared/api/http_client'

let fetchMock: ReturnType<typeof vi.fn>
let origFetch: typeof globalThis.fetch

beforeEach(() => {
  origFetch = globalThis.fetch
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: 'success', data: { ok: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

function lastInit(): RequestInit {
  return fetchMock.mock.calls[0][1] as RequestInit
}

describe('http_client.request — opts.headers 合并', () => {
  test('opts.headers 合并进 fetch headers, 保留 Accept', async () => {
    await request('http://h/api', 'GET', '/x', { headers: { 'X-Token': 'abc' } })
    const headers = lastInit().headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['X-Token']).toBe('abc')
  })

  test('body 存在时 Content-Type 不被 opts.headers 覆盖 (最后设)', async () => {
    await request('http://h/api', 'POST', '/x', {
      body: { a: 1 },
      headers: { 'Content-Type': 'text/evil', 'X-Token': 'abc' }
    })
    const headers = lastInit().headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Token']).toBe('abc')
  })

  test('无 opts.headers 时只有 Accept (web 默认路径不变)', async () => {
    await request('http://h/api', 'GET', '/x')
    const headers = lastInit().headers as Record<string, string>
    expect(headers).toEqual({ Accept: 'application/json' })
  })

  test('credentials: include 仍带 (CF Access cookie 路径不变)', async () => {
    await request('http://h/api', 'GET', '/x', { headers: { 'X-Token': 'abc' } })
    expect(lastInit().credentials).toBe('include')
  })
})

// task 07-21 — requestWithMeta 分页信封：request() 是它的薄封装（丢弃 meta），
// requestWithMeta() 把 meta（total/limit/offset）一并带出。
describe('http_client.requestWithMeta — 分页 meta 透传', () => {
  test('success envelope 的 meta 一并返回（request() 只返回 data 的对照组）', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'success',
          data: [{ id: 1 }],
          meta: { total: 52, limit: 50, offset: 0, count: 1 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const { data, meta } = await requestWithMeta('http://h/api', 'GET', '/reports')
    expect(data).toEqual([{ id: 1 }])
    expect(meta).toEqual({ total: 52, limit: 50, offset: 0, count: 1 })
  })

  test('meta 缺失时返回空对象（不 throw / 不 undefined）', async () => {
    // beforeEach 的默认 mock 响应无 meta 字段。
    const { meta } = await requestWithMeta('http://h/api', 'GET', '/x')
    expect(meta).toEqual({})
  })

  test('error envelope 仍 throw（与 request() 行为一致）', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: 'error', error: { code: 'E_NOT_FOUND', message: 'nope' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    )
    await expect(requestWithMeta('http://h/api', 'GET', '/x')).rejects.toMatchObject({
      code: 'E_NOT_FOUND'
    })
  })
})
