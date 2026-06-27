// chat-panel P4 Phase 03a — MailAgentDomainClient contract (HTTP / envelope / auth).
//
// Pure-Node: a recording mock fetch drives the client so we can assert the exact wire
// shape (endpoint path, the inconsistent query param names, the X-MailAgent-Local-Token
// header) + the envelope unwrap (success → data, error → DomainError, E_NOT_FOUND → null).

import { describe, expect, test } from 'vitest'

import { DomainError, MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'

interface Recorded {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
}

function recordingFetch(responder: (url: string) => { status?: number; json: unknown }): {
  fetchImpl: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {})
    )
    calls.push({ url, method: init?.method, headers, body: init?.body as string | undefined })
    const r = responder(url)
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function client(
  fetchImpl: typeof fetch,
  localToken: string | null = 'local-tok'
): MailAgentDomainClient {
  return new MailAgentDomainClient({ baseUrl: 'http://127.0.0.1:8200/api', localToken, fetchImpl })
}

const success = (data: unknown) => ({ json: { status: 'success', data } })

describe('MailAgentDomainClient — auth + envelope', () => {
  test('injects X-MailAgent-Local-Token header on every request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success([]))
    await client(fetchImpl, 'secret-token').searchEmails({})
    expect(calls[0].headers['X-MailAgent-Local-Token']).toBe('secret-token')
  })

  test('omits the token header when localToken is null', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success([]))
    await client(fetchImpl, null).searchEmails({})
    expect(calls[0].headers['X-MailAgent-Local-Token']).toBeUndefined()
  })

  test('success envelope → returns data', async () => {
    const { fetchImpl } = recordingFetch(() => success([{ internal_id: 1 }]))
    const out = await client(fetchImpl).searchEmails({})
    expect(out).toEqual([{ internal_id: 1 }])
  })

  test('error envelope → throws DomainError with the code', async () => {
    const { fetchImpl } = recordingFetch(() => ({
      status: 502,
      json: { status: 'error', error: { code: 'E_KOS_UNREACHABLE', message: 'kos down' } }
    }))
    await expect(client(fetchImpl).kosCall('query', { query: 'x' })).rejects.toMatchObject({
      code: 'E_KOS_UNREACHABLE'
    })
    await expect(client(fetchImpl).kosCall('query', { query: 'x' })).rejects.toBeInstanceOf(
      DomainError
    )
  })
})

describe('MailAgentDomainClient — wire-param fidelity', () => {
  test('searchEmails → GET /email/list with camelCase alias query params', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success([]))
    await client(fetchImpl).searchEmails({
      subject: 'redis',
      fromAddr: 'alice',
      sinceDate: '2026-06-01',
      isRead: false,
      isFlagged: true,
      limit: 10
    })
    const url = calls[0].url
    expect(url).toContain('/api/email/list?')
    expect(url).toContain('subject=redis')
    expect(url).toContain('fromAddr=alice')
    expect(url).toContain('sinceDate=2026-06-01')
    expect(url).toContain('isRead=false')
    expect(url).toContain('isFlagged=true')
    expect(url).toContain('limit=10')
  })

  test('searchEmailsFulltext → GET /email/search with q / since / until (NOT query/sinceDate)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ items: [] }))
    await client(fetchImpl).searchEmailsFulltext({ query: 'redis timeout', since: '2026-06-01' })
    const url = calls[0].url
    expect(url).toContain('/api/email/search?')
    expect(url).toContain('q=redis+timeout')
    expect(url).toContain('since=2026-06-01')
    expect(url).not.toContain('query=')
    expect(url).not.toContain('sinceDate=')
  })

  test('getEmail → include=body,attachments; E_NOT_FOUND → null', async () => {
    const { fetchImpl, calls } = recordingFetch((url) =>
      url.includes('/email/1')
        ? success({ internal_id: 1, subject: 'hi' })
        : { status: 404, json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'no' } } }
    )
    const found = await client(fetchImpl).getEmail(1)
    expect(found).toMatchObject({ internal_id: 1 })
    expect(decodeURIComponent(calls[0].url)).toContain('include=body,attachments')

    const missing = await client(fetchImpl).getEmail(999)
    expect(missing).toBeNull()
  })

  test('kosCall → POST /chat/kos-call with {name, args} body', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success([{ slug: 'a' }]))
    await client(fetchImpl).kosCall('query', { query: 'acme', limit: 5 })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/api/chat/kos-call')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      name: 'query',
      args: { query: 'acme', limit: 5 }
    })
  })

  test('listReports → GET /reports with agentId alias', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success([]))
    await client(fetchImpl).listReports({ cadence: 'daily', agentId: 'agent-1', limit: 5 })
    const url = calls[0].url
    expect(url).toContain('/api/reports?')
    expect(url).toContain('cadence=daily')
    expect(url).toContain('agentId=agent-1')
  })
})

describe('MailAgentDomainClient — memory wire (M0, mirrors legacy http_platform)', () => {
  test('listMemory → GET /chat/memory (scope query only when provided)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success([{ scope: 'user', key: 'k' }]))
    const c = client(fetchImpl)
    await c.listMemory('user')
    expect(calls[0].method ?? 'GET').toBe('GET')
    expect(calls[0].url).toContain('/api/chat/memory?')
    expect(calls[0].url).toContain('scope=user')
    // no scope → no query string at all
    await c.listMemory()
    expect(calls[1].url).toMatch(/\/api\/chat\/memory$/)
  })

  test('getMemory → GET /chat/memory/entry with scope + key query', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ scope: 'user', key: 'k' }))
    await client(fetchImpl).getMemory('user', 'reply_language')
    expect(calls[0].method ?? 'GET').toBe('GET')
    expect(calls[0].url).toContain('/api/chat/memory/entry?')
    expect(calls[0].url).toContain('scope=user')
    expect(calls[0].url).toContain('key=reply_language')
  })

  test('getMemory → data:null is a normal "not stored" result (NOT a throw)', async () => {
    const { fetchImpl } = recordingFetch(() => success(null))
    const out = await client(fetchImpl).getMemory('user', 'missing')
    expect(out).toBeNull()
  })

  test('writeMemory → POST /chat/memory with the camelCase body', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ scope: 'user', key: 'k' }))
    await client(fetchImpl).writeMemory({
      scope: 'user',
      key: 'reply_language',
      valueJson: '"English"',
      priority: 1,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceToolUseId: null,
      sourceWikiPath: null
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/api/chat/memory')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      scope: 'user',
      key: 'reply_language',
      valueJson: '"English"',
      priority: 1,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceToolUseId: null,
      sourceWikiPath: null
    })
  })

  test('deleteMemory → DELETE /chat/memory (scope+key query) → projects the deleted count', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ deleted: 1 }))
    const count = await client(fetchImpl).deleteMemory('user', 'reply_language')
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('/api/chat/memory?')
    expect(calls[0].url).toContain('scope=user')
    expect(calls[0].url).toContain('key=reply_language')
    expect(count).toBe(1)
  })
})

describe('MailAgentDomainClient — abort', () => {
  test('threads the abort signal; an aborted fetch rejects (not wrapped as DomainError)', async () => {
    const ac = new AbortController()
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      // simulate a fetch that rejects when the signal is already aborted.
      if (init?.signal?.aborted) {
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        throw e
      }
      return new Response(JSON.stringify({ status: 'success', data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    ac.abort()
    await expect(client(fetchImpl).searchEmails({}, ac.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})
