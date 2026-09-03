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
  /** JSON 端点是 string，二进制入库那条是裸字节 —— 断言处各自 narrow。 */
  body?: unknown
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
    calls.push({ url, method: init?.method, headers, body: init?.body })
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

  test('getEmail → include=attachments without body summary; E_NOT_FOUND → null', async () => {
    const { fetchImpl, calls } = recordingFetch((url) =>
      url.includes('/email/1')
        ? success({ internal_id: 1, subject: 'hi' })
        : { status: 404, json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'no' } } }
    )
    const found = await client(fetchImpl).getEmail(1)
    expect(found).toMatchObject({ internal_id: 1 })
    expect(decodeURIComponent(calls[0].url)).toContain('include=attachments')
    expect(decodeURIComponent(calls[0].url)).not.toContain('body,attachments')

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

// T4 主 agent 入群 —— resolveGroupSession 的保留字分支靠这个方法拿名字/头像。它的硬约束是
// 「读失败绝不 throw」：成员事实是 speakAsAgentId 的安全判据，抛出去会让群里的主 agent 在
// serve-api 抖动时人间蒸发（403）。调用方拿到 null 要 push 一个降级成员，而不是丢掉它。
describe('MailAgentDomainClient — getAssistantIdentity', () => {
  test('GET /agent/assistant-identity → the identity row', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ name: 'Jarvis', avatar: null }))
    const out = await client(fetchImpl).getAssistantIdentity()
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain('/api/agent/assistant-identity')
    expect(out).toEqual({ name: 'Jarvis', avatar: null })
  })

  test('E_NOT_FOUND → null（不 throw）', async () => {
    const { fetchImpl } = recordingFetch(() => ({
      status: 404,
      json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'missing' } }
    }))
    await expect(client(fetchImpl).getAssistantIdentity()).resolves.toBeNull()
  })

  test('网络故障 / 上游 5xx → null（不 throw）', async () => {
    const { fetchImpl } = recordingFetch(() => ({
      status: 500,
      json: { status: 'error', error: { code: 'E_INTERNAL', message: 'boom' } }
    }))
    await expect(client(fetchImpl).getAssistantIdentity()).resolves.toBeNull()

    const throwingFetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(client(throwingFetch).getAssistantIdentity()).resolves.toBeNull()
  })

  test('abort 仍原样抛（调用方要能区分「取消」与「读不到」）', async () => {
    const ac = new AbortController()
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        throw e
      }
      return new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 })
    }) as unknown as typeof fetch
    ac.abort()
    await expect(client(fetchImpl).getAssistantIdentity(ac.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

describe('MailAgentDomainClient — libraryUploadBinary（octet-stream 分支）', () => {
  test('参数走 query、请求体是裸字节、Content-Type 不是 JSON', async () => {
    const { fetchImpl, calls } = recordingFetch(() => success({ id: 9, path: 'x' }))
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    await client(fetchImpl).libraryUploadBinary({
      parentPath: 'chat-attachments/2026-09',
      filename: 'image-20260903-101112-0a1b2c3d.png',
      bytes,
      source: 'chat',
      sourceRef: '42:42-uuid.png'
    })
    const u = new URL(calls[0].url)
    expect(u.pathname).toBe('/api/library/files')
    expect(u.searchParams.get('parent_path')).toBe('chat-attachments/2026-09')
    expect(u.searchParams.get('filename')).toBe('image-20260903-101112-0a1b2c3d.png')
    expect(u.searchParams.get('source')).toBe('chat')
    expect(u.searchParams.get('source_ref')).toBe('42:42-uuid.png')
    // 🔴 Content-Type 一旦是 application/json，FastAPI 就走文本分支去 parse body → 400。
    expect(calls[0].headers['Content-Type']).toBe('application/octet-stream')
    expect(calls[0].body).toBe(bytes)
  })
})
