// @vitest-environment node
//
// 08-01 阶段 1 PR4 — connector 数据层 mock-fetch 单测（`createConnectorApi`）。
//
// 这一层没有业务逻辑，只有三件容易静默错的事，所以只测这三件：
//   ① 路径 / method / body 的 wire 形状（含 `mode: null` 清覆盖与工具名 encode）；
//   ② 信封解包（list/tools 外面还套一层 {connectors} / {tools}）；
//   ③ 错误**抛出**且 code 透传 —— 设置面靠 code 区分「flag 关」「未连接」「网络炸」，
//      任何一处吞错降级成空数组都会把「关着」显示成「没有连接器」。

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createConnectorApi } from '@shared/api/connector_api'

let fetchMock: ReturnType<typeof vi.fn>
let origFetch: typeof globalThis.fetch

function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function errorResponse(code: string, message: string, httpStatus: number): Response {
  return new Response(JSON.stringify({ status: 'error', error: { code, message } }), {
    status: httpStatus,
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

const api = createConnectorApi('/api')

function calledUrl(): string {
  return String(fetchMock.mock.calls[0][0])
}

function calledInit(): RequestInit {
  return (fetchMock.mock.calls[0][1] ?? {}) as RequestInit
}

function calledBody(): unknown {
  const raw = calledInit().body
  return raw == null ? undefined : JSON.parse(String(raw))
}

test('list → GET /api/connector，解 {connectors} 信封', async () => {
  const row = { connector_id: 'notion', display_name: 'Notion', enabled: true }
  fetchMock.mockResolvedValue(envelopeResponse({ connectors: [row] }))
  const out = await api.list()
  expect(calledUrl()).toBe('/api/connector')
  expect(String(calledInit().method ?? 'GET')).toBe('GET')
  expect(out).toEqual([row])
})

test('tools → GET /api/connector/{id}/tools，解 {tools} 信封', async () => {
  const tool = { name: 'search', crud_type: 'read', effective_mode: 'auto' }
  fetchMock.mockResolvedValue(envelopeResponse({ connector_id: 'notion', tools: [tool] }))
  const out = await api.tools('notion')
  expect(calledUrl()).toBe('/api/connector/notion/tools')
  expect(out).toEqual([tool])
})

test('status / oauthStart / sync / disconnect → 各自路径 + method', async () => {
  const cases: Array<[() => Promise<unknown>, string, string]> = [
    [() => api.status('notion'), '/api/connector/notion/status', 'GET'],
    [() => api.oauthStart('notion'), '/api/connector/notion/oauth/start', 'POST'],
    [() => api.sync('notion'), '/api/connector/notion/sync', 'POST'],
    [() => api.disconnect('notion'), '/api/connector/notion/disconnect', 'POST']
  ]
  for (const [call, path, method] of cases) {
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(envelopeResponse({ connector_id: 'notion' }))
    await call()
    expect(calledUrl()).toBe(path)
    expect(String(calledInit().method ?? 'GET')).toBe(method)
  }
})

test('setEnabled → POST /{id}/enabled，body 恒带 bool', async () => {
  fetchMock.mockResolvedValue(envelopeResponse({ connector_id: 'notion', enabled: false }))
  const out = await api.setEnabled('notion', false)
  expect(calledUrl()).toBe('/api/connector/notion/enabled')
  expect(String(calledInit().method)).toBe('POST')
  expect(calledBody()).toEqual({ enabled: false })
  expect(out).toEqual({ connector_id: 'notion', enabled: false })
})

test('setToolMode(null) → 清覆盖回默认档：键在场且值为 null（不是「off」）', async () => {
  fetchMock.mockResolvedValue(
    envelopeResponse({
      connector_id: 'notion',
      tool_name: 'create_page',
      mode_override: null,
      effective_mode: 'auto'
    })
  )
  const out = await api.setToolMode('notion', 'create_page', null)
  expect(calledUrl()).toBe('/api/connector/notion/tools/create_page/mode')
  // 🔴 `{}`（键缺席）会被服务端 400；null 必须真的序列化进 body。
  expect(calledBody()).toEqual({ mode: null })
  expect(out.mode_override).toBeNull()
  expect(out.effective_mode).toBe('auto')
})

test('setToolMode → 工具名 encode（远端 manifest 的名字可能带斜杠/空格）', async () => {
  fetchMock.mockResolvedValue(
    envelopeResponse({
      connector_id: 'notion',
      tool_name: 'a/b c',
      mode_override: 'ask',
      effective_mode: 'ask'
    })
  )
  await api.setToolMode('notion', 'a/b c', 'ask')
  expect(calledUrl()).toBe('/api/connector/notion/tools/a%2Fb%20c/mode')
  expect(calledBody()).toEqual({ mode: 'ask' })
})

test('bulkSetToolMode → POST /{id}/tools/bulk_mode（crud 收窄可选；reset = mode null 无 crud）', async () => {
  fetchMock.mockResolvedValue(
    envelopeResponse({ connector_id: 'notion', mode: 'ask', crud_type: 'write', updated: 3 })
  )
  const out = await api.bulkSetToolMode('notion', 'ask', 'write')
  expect(calledUrl()).toBe('/api/connector/notion/tools/bulk_mode')
  expect(String(calledInit().method)).toBe('POST')
  expect(calledBody()).toEqual({ mode: 'ask', crud_type: 'write' })
  expect(out.updated).toBe(3)

  fetchMock.mockClear()
  fetchMock.mockResolvedValue(
    envelopeResponse({ connector_id: 'notion', mode: null, crud_type: null, updated: 5 })
  )
  await api.bulkSetToolMode('notion', null)
  // Reset permissions：mode=null 键在场、crud_type 缺席（= 全部在册工具）。
  expect(calledBody()).toEqual({ mode: null })
})

test('setPreprocessEnabled → POST /{id}/preprocess', async () => {
  fetchMock.mockResolvedValue(
    envelopeResponse({ connector_id: 'notion', preprocess_enabled: true })
  )
  const out = await api.setPreprocessEnabled('notion', true)
  expect(calledUrl()).toBe('/api/connector/notion/preprocess')
  expect(calledBody()).toEqual({ enabled: true })
  expect(out.preprocess_enabled).toBe(true)
})

test('purgeOrphans → POST /{id}/tools/purge_orphans（固定段，不是工具名位）', async () => {
  fetchMock.mockResolvedValue(envelopeResponse({ connector_id: 'notion', purged: 3 }))
  const out = await api.purgeOrphans('notion')
  expect(calledUrl()).toBe('/api/connector/notion/tools/purge_orphans')
  expect(String(calledInit().method)).toBe('POST')
  // 无 body —— 端点不收参数（删的是「全部 orphan 行」，没有第二种语义）。
  expect(calledBody()).toBeUndefined()
  expect(out).toEqual({ connector_id: 'notion', purged: 3 })
})

test('purgeOrphans 的错误同样抛出（flag 关 409 / 未知 connector 404 要能分开渲染）', async () => {
  fetchMock.mockResolvedValue(errorResponse('E_CONNECTOR_DISABLED', 'off', 409))
  await expect(api.purgeOrphans('notion')).rejects.toMatchObject({
    code: 'E_CONNECTOR_DISABLED'
  })
})

test('错误信封 → throw Error & {code}（不吞、不降级成空）', async () => {
  fetchMock.mockResolvedValue(
    errorResponse('E_CONNECTOR_DISABLED', 'MCP connectors are disabled', 409)
  )
  await expect(api.list()).rejects.toMatchObject({ code: 'E_CONNECTOR_DISABLED' })

  fetchMock.mockClear()
  fetchMock.mockResolvedValue(errorResponse('E_CONNECTOR_GRANT_DENIED', 'above crud ceiling', 403))
  await expect(api.setToolMode('notion', 'update_page', 'auto')).rejects.toMatchObject({
    code: 'E_CONNECTOR_GRANT_DENIED'
  })
})

// ── 08-05 WP-12：预置目录 + BYOK key + disconnect purge ──────────────────────

test('catalog / composio key —— 路径与 method（key 只在请求体里出现一次）', async () => {
  fetchMock.mockResolvedValue(envelopeResponse({ composio: { configured: false }, entries: [] }))
  await api.catalog()
  expect(calledUrl()).toBe('/api/connector/catalog')
  expect(String(calledInit().method ?? 'GET')).toBe('GET')

  fetchMock.mockClear()
  fetchMock.mockResolvedValue(envelopeResponse({ configured: true, updated_at: 1 }))
  await api.setComposioKey('ck_secret')
  expect(calledUrl()).toBe('/api/connector/composio/key')
  expect(String(calledInit().method)).toBe('POST')
  expect(calledBody()).toEqual({ api_key: 'ck_secret' })

  fetchMock.mockClear()
  fetchMock.mockResolvedValue(envelopeResponse({ configured: false, updated_at: null }))
  await api.clearComposioKey()
  expect(calledUrl()).toBe('/api/connector/composio/key')
  expect(String(calledInit().method)).toBe('DELETE')
})

test('disconnect 恒显式发 purge（默认 false = 只删凭证、留配置）', async () => {
  fetchMock.mockResolvedValue(
    envelopeResponse({ connector_id: 'notion', deleted_credentials: 2, purged: false })
  )
  await api.disconnect('notion')
  expect(calledBody()).toEqual({ purge: false })

  fetchMock.mockClear()
  fetchMock.mockResolvedValue(
    envelopeResponse({ connector_id: 'notion', deleted_credentials: 2, purged: true })
  )
  await api.disconnect('notion', true)
  expect(calledBody()).toEqual({ purge: true })
})
