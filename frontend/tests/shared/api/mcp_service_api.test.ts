// @vitest-environment node
//
// 设置 →「MCP 服务」数据层 mock-fetch 单测（`createMcpServiceApi`）。
// 只测三件容易静默错的事：路径 / method / body 的 wire 形状；外层信封
// （{keys} / {tools} / {entries} / {key}）解包；错误抛出且 code 透传（设置页靠
// E_NETWORK 判 serve-api 没在跑，吞错会把「没在跑」显示成「没有密钥」）。

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createMcpServiceApi } from '@shared/api/mcp_service_api'

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

const api = createMcpServiceApi('/api')

function call(i = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit | undefined]
  const raw = init?.body
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    body: raw == null ? undefined : JSON.parse(String(raw))
  }
}

test('status → GET /api/mcp-service/status', async () => {
  const data = { local_url: 'http://127.0.0.1:8200/mcp', public_url: null, active_key_count: 0 }
  fetchMock.mockResolvedValue(envelopeResponse(data))
  await expect(api.status()).resolves.toEqual(data)
  expect(call()).toMatchObject({ url: '/api/mcp-service/status', method: 'GET' })
})

test('listKeys 解 {keys}；tools 解 {tools}；audit 解 {entries} 并带 limit', async () => {
  fetchMock.mockResolvedValueOnce(envelopeResponse({ keys: [{ id: 'k1' }] }))
  await expect(api.listKeys()).resolves.toEqual([{ id: 'k1' }])
  fetchMock.mockResolvedValueOnce(envelopeResponse({ tools: [{ name: 't' }] }))
  await expect(api.tools()).resolves.toEqual([{ name: 't' }])
  fetchMock.mockResolvedValueOnce(envelopeResponse({ entries: [{ id: 1 }] }))
  await expect(api.audit(20)).resolves.toEqual([{ id: 1 }])
  expect(call(0).url).toBe('/api/mcp-service/keys')
  expect(call(1).url).toBe('/api/mcp-service/tools')
  expect(call(2).url).toBe('/api/mcp-service/audit?limit=20')
})

test('getScopeOptions → GET /api/mcp-service/scope-options（不解包）', async () => {
  const data = {
    bases: [{ id: 'readonly', scopes: ['email:read'] }],
    extras: [{ scope: 'email:draft', risk: 'low' }]
  }
  fetchMock.mockResolvedValue(envelopeResponse(data))
  await expect(api.getScopeOptions()).resolves.toEqual(data)
  expect(call()).toMatchObject({ url: '/api/mcp-service/scope-options', method: 'GET' })
})

test('updateKeyScopes → PATCH /keys/{id}/scopes，body {base, extra}，解 {key}', async () => {
  fetchMock.mockResolvedValue(envelopeResponse({ key: { id: 'a/b', base: 'handoff' } }))
  await expect(api.updateKeyScopes('a/b', 'handoff', ['email:draft'])).resolves.toEqual({
    id: 'a/b',
    base: 'handoff'
  })
  expect(call()).toEqual({
    url: '/api/mcp-service/keys/a%2Fb/scopes',
    method: 'PATCH',
    body: { base: 'handoff', extra: ['email:draft'] }
  })
})

test('createKey / rotateKey / revokeKey / probe 的 wire 形状', async () => {
  const withPlain = { key: { id: 'a/b' }, plaintext: 'mak_x' }
  fetchMock.mockResolvedValueOnce(envelopeResponse(withPlain))
  await expect(api.createKey('Notion', 'handoff', ['email:draft'])).resolves.toEqual(withPlain)
  fetchMock.mockResolvedValueOnce(envelopeResponse(withPlain))
  await api.rotateKey('a/b')
  fetchMock.mockResolvedValueOnce(envelopeResponse({ key: { id: 'a/b', active: false } }))
  await expect(api.revokeKey('a/b')).resolves.toEqual({ id: 'a/b', active: false })
  fetchMock.mockResolvedValueOnce(envelopeResponse({ result: 'reachable', detail: '405' }))
  await api.probe('https://mcp.example.test/mcp')

  expect(call(0)).toEqual({
    url: '/api/mcp-service/keys',
    method: 'POST',
    body: { label: 'Notion', base: 'handoff', extra: ['email:draft'] }
  })
  expect(call(1)).toMatchObject({ url: '/api/mcp-service/keys/a%2Fb/rotate', method: 'POST' })
  expect(call(2)).toMatchObject({ url: '/api/mcp-service/keys/a%2Fb/revoke', method: 'POST' })
  expect(call(3)).toEqual({
    url: '/api/mcp-service/probe',
    method: 'POST',
    body: { url: 'https://mcp.example.test/mcp' }
  })
})

test('传输失败抛 E_NETWORK，不降级成空', async () => {
  fetchMock.mockRejectedValue(new TypeError('fetch failed'))
  await expect(api.listKeys()).rejects.toMatchObject({ code: 'E_NETWORK' })
})
