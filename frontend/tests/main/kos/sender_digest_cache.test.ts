// Sprint 19 PR-2f — Sender KOS digest cache tests.
//
// Mock 策略: __setCacheClientForTests 注入 fake KOSClient (only query()
// method needed); __resetCacheForTests 每 test 前清; __setTtlForTests
// 设短 TTL 测过期路径.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  __resetCacheForTests,
  __setCacheClientForTests,
  __setTtlForTests,
  getCachedSenderDigest,
  prefetchSenderDigest
} from '../../../src/electron/main/kos/sender_digest_cache'
import { KOSClient, KOSError } from '../../../src/electron/main/kos/client'

function makeMockClient(
  query: KOSClient['query'],
  configured: boolean = true
): KOSClient {
  return { query, configured } as unknown as KOSClient
}

beforeEach(() => {
  __resetCacheForTests()
})

afterEach(() => {
  __setCacheClientForTests(null)
  __setTtlForTests(null) // restore default 1h TTL
})

describe('getCachedSenderDigest (sync read)', () => {
  test('returns undefined when no entry', () => {
    expect(getCachedSenderDigest('bob@acme.com')).toBeUndefined()
  })

  test('returns undefined for null/empty sender', () => {
    expect(getCachedSenderDigest(null)).toBeUndefined()
    expect(getCachedSenderDigest('')).toBeUndefined()
    expect(getCachedSenderDigest(undefined)).toBeUndefined()
  })
})

describe('prefetchSenderDigest', () => {
  test('queries KOS and writes cache on success', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { slug: 'people/bob-acme-com', chunk_text: 'Bob is CTO at Acme', score: 0.95 }
    ])
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest('bob@acme.com')
    expect(queryFn).toHaveBeenCalledWith('people/bob-acme-com', { limit: 1, expand: true })
    expect(getCachedSenderDigest('bob@acme.com')).toBe('Bob is CTO at Acme')
  })

  test('caches null when KOS returns no hits', async () => {
    const queryFn = vi.fn().mockResolvedValue([])
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest('unknown@x.com')
    expect(getCachedSenderDigest('unknown@x.com')).toBeNull()
  })

  test('caches null when chunk_text missing from top hit', async () => {
    const queryFn = vi.fn().mockResolvedValue([{ slug: 'people/x', score: 0.5 }])
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest('x@y.com')
    expect(getCachedSenderDigest('x@y.com')).toBeNull()
  })

  test('subsequent prefetch within TTL skips network', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { slug: 'people/a', chunk_text: 'first', score: 0.9 }
    ])
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest('a@b.com')
    await prefetchSenderDigest('a@b.com')
    await prefetchSenderDigest('a@b.com')
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  test('case-insensitive cache key', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { slug: 'people/x', chunk_text: 'normalized', score: 0.9 }
    ])
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest('Bob@ACME.com')
    // 查 lower / upper / mixed 都应命中同一 cache entry
    expect(getCachedSenderDigest('bob@acme.com')).toBe('normalized')
    expect(getCachedSenderDigest('BOB@ACME.COM')).toBe('normalized')
    expect(getCachedSenderDigest('Bob@Acme.com')).toBe('normalized')
  })

  test('concurrent prefetch dedupes (single network call)', async () => {
    let resolveQuery: (v: unknown[]) => void = () => {}
    const queryPromise = new Promise<unknown[]>((r) => {
      resolveQuery = r
    })
    const queryFn = vi.fn(() => queryPromise)
    __setCacheClientForTests(makeMockClient(queryFn as KOSClient['query']))

    const p1 = prefetchSenderDigest('c@d.com')
    const p2 = prefetchSenderDigest('c@d.com')
    const p3 = prefetchSenderDigest('c@d.com')

    resolveQuery([{ slug: 'people/c', chunk_text: 'shared', score: 0.7 }])
    await Promise.all([p1, p2, p3])

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(getCachedSenderDigest('c@d.com')).toBe('shared')
  })

  test('KOSError caches null silently (no throw)', async () => {
    const queryFn = vi.fn().mockRejectedValue(
      new KOSError('rate limited', 'E_KOS_RATE_LIMIT', 429)
    )
    __setCacheClientForTests(makeMockClient(queryFn))

    await expect(prefetchSenderDigest('e@x.com')).resolves.toBeUndefined()
    expect(getCachedSenderDigest('e@x.com')).toBeNull()
  })

  test('unknown exception also cached null', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'))
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest('f@x.com')
    expect(getCachedSenderDigest('f@x.com')).toBeNull()
  })

  test('not-configured client → no-op silent', async () => {
    const queryFn = vi.fn()
    __setCacheClientForTests(makeMockClient(queryFn, /* configured */ false))

    await prefetchSenderDigest('g@x.com')
    expect(queryFn).not.toHaveBeenCalled()
    // 没 cache 写入 (skip 路径不该污染 cache 状态)
    expect(getCachedSenderDigest('g@x.com')).toBeUndefined()
  })

  test('TTL expiration evicts entry', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { slug: 'people/t', chunk_text: 'ephemeral', score: 0.9 }
    ])
    __setCacheClientForTests(makeMockClient(queryFn))
    __setTtlForTests(1) // 1ms — almost immediate expiry

    await prefetchSenderDigest('t@x.com')
    expect(getCachedSenderDigest('t@x.com')).toBe('ephemeral')

    // 等 TTL 过期
    await new Promise((r) => setTimeout(r, 10))
    expect(getCachedSenderDigest('t@x.com')).toBeUndefined()

    // 再 prefetch 重新拉
    await prefetchSenderDigest('t@x.com')
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  test('null/empty sender no-op', async () => {
    const queryFn = vi.fn()
    __setCacheClientForTests(makeMockClient(queryFn))

    await prefetchSenderDigest(null)
    await prefetchSenderDigest('')
    await prefetchSenderDigest(undefined)
    expect(queryFn).not.toHaveBeenCalled()
  })
})
