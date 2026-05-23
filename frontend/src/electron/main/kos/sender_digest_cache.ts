// Sprint 19 PR-2f — Sender KOS digest in-memory cache.
//
// chat harness 启动时 (harness.ts) 调 prefetchSenderDigest(senderAddr)
// 异步 fire-and-forget 拉 KOS `people/<slug>` 档案; 真 streaming start 前
// 通常已返回. buildSystemBlocks (custom_api.ts) 同步读 getCachedSenderDigest
// 决定是否注入 L1 hot block; cache miss → block 不注入 (LLM 走纯 STATIC
// prompt 路径, 无 cross-context).
//
// Cache key: lowercase email; TTL 1h match KOS dream-cycle (03:11 cron) 数据
// 刷新节奏. 失败 (KOS unreachable / KOSError) 也 cache empty 1h 防反复重试
// 拖慢启动.
//
// Test seam: __setCacheClientForTests / __resetCacheForTests.

import { KOSClient, KOSError } from './client'
import { senderToKosPeopleSlug } from './slug'

interface CachedDigest {
  /** KOS slug used to fetch */
  slug: string
  /** chunk_text 摘要 from top hit; null = KOS no page for slug or fetch error */
  text: string | null
  /** Cache write timestamp (ms epoch) */
  fetchedAt: number
}

const TTL_MS = 60 * 60 * 1000 // 1h
const _cache = new Map<string, CachedDigest>()
let _client: KOSClient | null = null
// Track in-flight prefetch promises to dedupe concurrent calls
const _inflight = new Map<string, Promise<void>>()

function getClient(): KOSClient {
  if (_client === null) _client = new KOSClient()
  return _client
}

/** Test seam: inject mock KOSClient (pass null to reset to default lazy ctor). */
export function __setCacheClientForTests(c: KOSClient | null): void {
  _client = c
}

/** Test seam: clear cache + in-flight map. */
export function __resetCacheForTests(): void {
  _cache.clear()
  _inflight.clear()
}

/** Test seam: override TTL (ms). Pass null to restore default 1h. */
export function __setTtlForTests(ms: number | null): void {
  _ttlOverride = ms
}
let _ttlOverride: number | null = null

function effectiveTtl(): number {
  return _ttlOverride !== null ? _ttlOverride : TTL_MS
}

/**
 * Synchronous read — return cached digest text, or `undefined` if cache miss.
 *
 * Distinction:
 *   undefined → no cache entry (prefetch not run / not finished / TTL expired)
 *   null      → cache entry exists but KOS has no matching page (or fetch
 *               errored) — caller should NOT inject anything
 *   string    → digest chunk_text ready for L1 hot block injection
 *
 * Callers must treat the difference so we don't re-prefetch when KOS
 * legitimately returned no hits.
 */
export function getCachedSenderDigest(
  senderEmail: string | null | undefined
): string | null | undefined {
  if (!senderEmail) return undefined
  const key = senderEmail.toLowerCase()
  const entry = _cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.fetchedAt > effectiveTtl()) {
    _cache.delete(key)
    return undefined
  }
  return entry.text
}

/**
 * Async prefetch — chat harness 启动时 fire-and-forget 调.
 *
 * Idempotent + concurrent-safe:
 *   - 已 cache 且未过期 → no-op
 *   - 已在 in-flight → 返同一 promise (dedupe)
 *   - 新调 → 异步 KOS query + write cache + clear in-flight slot
 *
 * KOSClient 未 configured (3 env 缺) → no-op silent.
 * KOSError / 任何异常 → cache empty result 1h (避免反复重试同一不可达 sender).
 */
export async function prefetchSenderDigest(
  senderEmail: string | null | undefined
): Promise<void> {
  if (!senderEmail) return
  const key = senderEmail.toLowerCase()

  // 已 cache 且未过期 → skip
  const existing = _cache.get(key)
  if (existing && Date.now() - existing.fetchedAt <= effectiveTtl()) return

  // 已在 in-flight → 返同一 promise (concurrent prefetch dedupe)
  const inflight = _inflight.get(key)
  if (inflight) return await inflight

  const slug = senderToKosPeopleSlug(senderEmail)
  const client = getClient()
  if (!client.configured) return // env 缺, silent skip

  const promise = (async () => {
    try {
      const hits = await client.query(slug, { limit: 1, expand: true })
      const top = hits[0]
      const text = typeof top?.chunk_text === 'string' ? top.chunk_text : null
      _cache.set(key, { slug, text, fetchedAt: Date.now() })
    } catch (e) {
      // KOSError or other — cache empty result so we don't retry tight loop
      if (e instanceof KOSError) {
        // expected (E_KOS_UNREACHABLE / E_KOS_RATE_LIMIT / ...): keep silent
      }
      _cache.set(key, { slug, text: null, fetchedAt: Date.now() })
    } finally {
      _inflight.delete(key)
    }
  })()

  _inflight.set(key, promise)
  return await promise
}
