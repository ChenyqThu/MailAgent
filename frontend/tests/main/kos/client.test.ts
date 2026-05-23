// Sprint 19 PR-2c — KOS MCP client (TypeScript) tests.
//
// Mirrors `tests/kos/test_client.py` 1:1; both client implementations share
// the same protocol contract (OAuth /token → /mcp SSE → JSON-RPC tools/call).
//
// Mock strategy: inject `fetchImpl` via KOSClient constructor; tests build
// per-case `vi.fn()` that returns canned Response objects. No real network.

import { describe, expect, test } from 'vitest'
import { KOSClient, KOSError } from '../../../src/electron/main/kos/client'

// ============================================================
// Helpers
// ============================================================

function sseEnvelope(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

function toolResult(innerPayload: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'mock-1',
    result: {
      content: [{ type: 'text', text: JSON.stringify(innerPayload) }]
    }
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  })
}

function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) }
  })
}

function tokenResponse(token = 'tk', expiresIn = 3600): Response {
  return jsonResponse({
    access_token: token,
    token_type: 'bearer',
    expires_in: expiresIn,
    scope: 'read write'
  })
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function makeClient(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  client: KOSClient
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return await handler(url, init)
  }) as unknown as typeof fetch
  const client = new KOSClient({
    baseUrl: 'https://kos.test',
    clientId: 'cl_mock',
    clientSecret: 'cs_mock',
    fetchImpl
  })
  return { client, calls }
}

// ============================================================
// configured / config defaults
// ============================================================

describe('KOSClient configured', () => {
  test('fully configured', () => {
    const c = new KOSClient({
      baseUrl: 'https://kos.test',
      clientId: 'cl',
      clientSecret: 'cs'
    })
    expect(c.configured).toBe(true)
  })

  test('missing baseUrl', () => {
    const c = new KOSClient({ baseUrl: '', clientId: 'cl', clientSecret: 'cs' })
    expect(c.configured).toBe(false)
  })

  test('missing clientId', () => {
    const c = new KOSClient({ baseUrl: 'https://kos.test', clientId: '', clientSecret: 'cs' })
    expect(c.configured).toBe(false)
  })

  test('missing clientSecret', () => {
    const c = new KOSClient({ baseUrl: 'https://kos.test', clientId: 'cl', clientSecret: '' })
    expect(c.configured).toBe(false)
  })

  test('trailing slash stripped', () => {
    const c = new KOSClient({
      baseUrl: 'https://kos.test/',
      clientId: 'cl',
      clientSecret: 'cs'
    })
    expect(c.baseUrl).toBe('https://kos.test')
  })
})

// ============================================================
// health
// ============================================================

describe('KOSClient.health', () => {
  test('returns parsed JSON on 200', async () => {
    const { client } = makeClient((url) => {
      expect(url).toBe('https://kos.test/health')
      return jsonResponse({ status: 'ok', version: '0.38.2.0', engine: 'postgres' })
    })
    const result = await client.health()
    expect(result).toEqual({ status: 'ok', version: '0.38.2.0', engine: 'postgres' })
  })

  test('5xx → E_KOS_HEALTH', async () => {
    const { client } = makeClient(() => new Response('upstream down', { status: 503 }))
    await expect(client.health()).rejects.toMatchObject({
      code: 'E_KOS_HEALTH',
      status: 503
    })
  })

  test('not configured → E_KOS_NOT_CONFIGURED', async () => {
    const c = new KOSClient({
      baseUrl: '',
      clientId: 'cl',
      clientSecret: 'cs',
      fetchImpl: async () => new Response()
    })
    await expect(c.health()).rejects.toMatchObject({ code: 'E_KOS_NOT_CONFIGURED' })
  })
})

// ============================================================
// /token flow + cache
// ============================================================

describe('KOSClient token cache', () => {
  test('fetched on first call', async () => {
    let tokenCalls = 0
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) {
        tokenCalls++
        return tokenResponse('tk_1', 3600)
      }
      return sseResponse(sseEnvelope(toolResult([])))
    })
    await client.callTool('query', { query: 'x' })
    expect(tokenCalls).toBe(1)
  })

  test('cached across multiple calls', async () => {
    let tokenCalls = 0
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) {
        tokenCalls++
        return tokenResponse()
      }
      return sseResponse(sseEnvelope(toolResult([])))
    })
    await client.callTool('query', { query: '1' })
    await client.callTool('query', { query: '2' })
    await client.callTool('list_pages', {})
    expect(tokenCalls).toBe(1)
  })

  test('safety buffer 60s triggers refresh on short expires_in', async () => {
    let tokenCalls = 0
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) {
        tokenCalls++
        // 30s < 60s safety buffer → cache 永远立即失效
        return tokenResponse('tk', 30)
      }
      return sseResponse(sseEnvelope(toolResult([])))
    })
    await client.callTool('query', { query: '1' })
    await client.callTool('query', { query: '2' })
    expect(tokenCalls).toBe(2)
  })

  test('/token HTTP error → E_KOS_TOKEN_HTTP', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) {
        return new Response('invalid_client', { status: 401 })
      }
      return jsonResponse({})
    })
    await expect(client.callTool('query', {})).rejects.toMatchObject({
      code: 'E_KOS_TOKEN_HTTP',
      status: 401
    })
  })

  test('/token missing access_token → E_KOS_TOKEN_INVALID', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) {
        return jsonResponse({ foo: 'bar' })
      }
      return jsonResponse({})
    })
    await expect(client.callTool('query', {})).rejects.toMatchObject({
      code: 'E_KOS_TOKEN_INVALID'
    })
  })

  test('/token request body includes grant_type + scope', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return sseResponse(sseEnvelope(toolResult([])))
    })
    await client.callTool('query', {})
    const tokenCall = calls.find((c) => c.url.endsWith('/token'))
    expect(tokenCall).toBeDefined()
    const body = tokenCall!.init?.body as URLSearchParams
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('cl_mock')
    expect(body.get('client_secret')).toBe('cs_mock')
    expect(body.get('scope')).toBe('read write')
  })
})

// ============================================================
// /mcp call_tool — response shapes
// ============================================================

describe('KOSClient.callTool', () => {
  test('SSE response parsed', async () => {
    const hits = [{ slug: 'concepts/redis', score: 0.9 }]
    const { client } = makeClient((url, init) => {
      if (url.endsWith('/token')) return tokenResponse()
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? ''
      expect(auth.startsWith('Bearer ')).toBe(true)
      return sseResponse(sseEnvelope(toolResult(hits)))
    })
    const result = await client.callTool('query', { query: 'redis' })
    expect(result).toEqual(hits)
  })

  test('application/json response parsed (server returns JSON not SSE)', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return jsonResponse(toolResult({ slug: 'x' }))
    })
    const result = await client.callTool('get', {})
    expect(result).toEqual({ slug: 'x' })
  })

  test('401 triggers refresh + retry once → success', async () => {
    let tokenCalls = 0
    let mcpCalls = 0
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) {
        tokenCalls++
        return tokenResponse(`tk_${tokenCalls}`)
      }
      mcpCalls++
      if (mcpCalls === 1) {
        return new Response('expired', { status: 401 })
      }
      return sseResponse(sseEnvelope(toolResult(['ok'])))
    })
    const result = await client.callTool('query', { query: 'x' })
    expect(result).toEqual(['ok'])
    expect(tokenCalls).toBe(2)
    expect(mcpCalls).toBe(2)
  })

  test('429 → E_KOS_RATE_LIMIT', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return new Response('rate-limited', { status: 429 })
    })
    await expect(client.callTool('query', {})).rejects.toMatchObject({
      code: 'E_KOS_RATE_LIMIT',
      status: 429
    })
  })

  test('500 → E_KOS_HTTP', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return new Response('server error', { status: 500 })
    })
    await expect(client.callTool('query', {})).rejects.toMatchObject({
      code: 'E_KOS_HTTP',
      status: 500
    })
  })

  test('JSON-RPC error envelope → E_KOS_RPC', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return sseResponse(
        sseEnvelope({
          jsonrpc: '2.0',
          id: '1',
          error: { code: -32602, message: 'invalid params' }
        })
      )
    })
    await expect(client.callTool('query', {})).rejects.toMatchObject({
      code: 'E_KOS_RPC',
      status: -32602
    })
  })

  test('not configured → E_KOS_NOT_CONFIGURED', async () => {
    const c = new KOSClient({
      baseUrl: '',
      clientId: '',
      clientSecret: '',
      fetchImpl: async () => new Response()
    })
    await expect(c.callTool('query', {})).rejects.toMatchObject({
      code: 'E_KOS_NOT_CONFIGURED'
    })
  })
})

// ============================================================
// Convenience methods
// ============================================================

describe('KOSClient convenience methods', () => {
  test('query() returns hit array', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return sseResponse(sseEnvelope(toolResult([{ slug: 'x' }, { slug: 'y' }])))
    })
    const hits = await client.query('test', { limit: 5 })
    expect(hits).toHaveLength(2)
    expect(hits[0]?.slug).toBe('x')
    // request body included query + limit
    const mcpCall = calls.find((c) => c.url.endsWith('/mcp'))
    const body = JSON.parse(mcpCall!.init!.body as string)
    expect(body.params.name).toBe('query')
    expect(body.params.arguments.query).toBe('test')
    expect(body.params.arguments.limit).toBe(5)
  })

  test('query() defensive: non-array result → empty array', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return sseResponse(sseEnvelope(toolResult({ not: 'a list' })))
    })
    const hits = await client.query('x')
    expect(hits).toEqual([])
  })

  test('listPages() caps limit at 100', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return sseResponse(sseEnvelope(toolResult([])))
    })
    await client.listPages({ limit: 500 })
    const mcpCall = calls.find((c) => c.url.endsWith('/mcp'))
    const body = JSON.parse(mcpCall!.init!.body as string)
    expect(body.params.arguments.limit).toBe(100)
  })

  test('putPage() returns server payload', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/token')) return tokenResponse()
      return sseResponse(
        sseEnvelope(
          toolResult({
            slug: 'sources/mailagent-foo',
            status: 'created_or_updated',
            chunks: 3
          })
        )
      )
    })
    const result = await client.putPage(
      'sources/mailagent-foo',
      '---\nfrontmatter\n---\nbody'
    )
    expect(result.status).toBe('created_or_updated')
    expect(result.chunks).toBe(3)
    const mcpCall = calls.find((c) => c.url.endsWith('/mcp'))
    const body = JSON.parse(mcpCall!.init!.body as string)
    expect(body.params.name).toBe('put_page')
    expect(body.params.arguments.slug).toBe('sources/mailagent-foo')
    expect(body.params.arguments.content).toContain('frontmatter')
  })
})

// ============================================================
// Static helpers
// ============================================================

describe('extractSseEnvelope', () => {
  test('basic data line', () => {
    const env = KOSClient.extractSseEnvelope('event: message\ndata: {"x":1}\n\n')
    expect(env).toEqual({ x: 1 })
  })

  test('skips event lines', () => {
    const env = KOSClient.extractSseEnvelope(
      'event: ping\n\nevent: message\ndata: {"y":2}\n\n'
    )
    expect(env).toEqual({ y: 2 })
  })

  test('missing data line → E_KOS_PARSE', () => {
    expect(() => KOSClient.extractSseEnvelope('event: foo\n\n')).toThrowError(KOSError)
  })

  test('invalid JSON → E_KOS_PARSE', () => {
    expect(() => KOSClient.extractSseEnvelope('data: not-json\n\n')).toThrowError(
      /E_KOS_PARSE|not JSON|JSON/
    )
  })

  test('[DONE] sentinel skipped', () => {
    const env = KOSClient.extractSseEnvelope('data: [DONE]\n\ndata: {"x":1}\n\n')
    expect(env).toEqual({ x: 1 })
  })

  test('CRLF line endings supported', () => {
    const env = KOSClient.extractSseEnvelope('event: message\r\ndata: {"x":1}\r\n\r\n')
    expect(env).toEqual({ x: 1 })
  })
})

describe('unwrapToolResult', () => {
  test('unwraps text JSON', () => {
    const result = { content: [{ type: 'text', text: '{"slug":"a"}' }] }
    expect(KOSClient.unwrapToolResult(result)).toEqual({ slug: 'a' })
  })

  test('returns text if not JSON', () => {
    const result = { content: [{ type: 'text', text: 'just a string' }] }
    expect(KOSClient.unwrapToolResult(result)).toBe('just a string')
  })

  test('returns result if no text content', () => {
    const result = { content: [{ type: 'image', data: '...' }] }
    expect(KOSClient.unwrapToolResult(result)).toEqual(result)
  })

  test('returns result if no content array', () => {
    const result = { foo: 'bar' }
    expect(KOSClient.unwrapToolResult(result)).toEqual({ foo: 'bar' })
  })

  test('returns primitive as-is', () => {
    expect(KOSClient.unwrapToolResult('x')).toBe('x')
    expect(KOSClient.unwrapToolResult([1, 2])).toEqual([1, 2])
    expect(KOSClient.unwrapToolResult(null)).toBe(null)
  })
})
