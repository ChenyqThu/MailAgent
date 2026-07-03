// Sprint 19 P1-B — KOS time-decay rerank tests.
//
// Verify the client-side rerank that wraps kos_query hits with exponential
// 14-day-half-life decay so recent KOS pages outrank older ones for the
// chat agent. KOS bm25 score has no time dimension; rerank multiplies it
// by 0.5^(Δt/τ) and re-sorts by adjusted score.
//
// Determinism: tests pin `nowMs` so the decay factor is reproducible.

import { describe, expect, test } from 'vitest'

// V2.1 3b-4 / S3：rerank 单一真源随 S3 迁入 gateway（原 shared/chat 副本随 legacy 删）。
import {
  extractHitTimestampMs,
  rerankByRecency,
  type QueryHit
} from '../../../src/ai-gateway/tools/kos_rerank'

const DAY_MS = 86_400_000
const NOW = 1_700_000_000_000 // arbitrary fixed epoch ms for reproducibility

describe('extractHitTimestampMs', () => {
  test('reads updated_at when present (gbrain wiki_pages convention)', () => {
    expect(extractHitTimestampMs({ slug: 'x', updated_at: 12345 })).toBe(12345)
  })

  test('converts mtime_ns (nanoseconds) → ms', () => {
    // 1_700_000_000 seconds = 1_700_000_000_000_000_000 ns; / 1e6 = 1.7e12 ms.
    expect(extractHitTimestampMs({ slug: 'x', mtime_ns: 1_700_000_000_000_000_000 })).toBe(
      1_700_000_000_000
    )
  })

  test('falls back to created_at when updated_at + mtime_ns missing', () => {
    expect(extractHitTimestampMs({ slug: 'x', created_at: 99999 })).toBe(99999)
  })

  test('returns null when no timestamp field present', () => {
    expect(extractHitTimestampMs({ slug: 'x' })).toBeNull()
    expect(extractHitTimestampMs({ slug: 'x', score: 0.5 })).toBeNull()
  })

  test('returns null for non-positive timestamps (treats 0 / negative as missing)', () => {
    expect(extractHitTimestampMs({ slug: 'x', updated_at: 0 })).toBeNull()
    expect(extractHitTimestampMs({ slug: 'x', updated_at: -1 })).toBeNull()
  })

  test('updated_at takes priority over mtime_ns and created_at', () => {
    const hit: QueryHit = {
      slug: 'x',
      updated_at: 1000,
      mtime_ns: 99_999_999_999,
      created_at: 500
    }
    expect(extractHitTimestampMs(hit)).toBe(1000)
  })
})

describe('rerankByRecency', () => {
  test('empty input returns []', () => {
    expect(rerankByRecency([])).toEqual([])
  })

  test('hit at t=now → factor=1.0, score unchanged', () => {
    const hits: QueryHit[] = [{ slug: 'a', score: 2.0, updated_at: NOW }]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked).toHaveLength(1)
    expect(reranked[0]._recency_factor).toBeCloseTo(1.0, 5)
    expect(reranked[0].score).toBeCloseTo(2.0, 5)
    expect(reranked[0]._original_score).toBe(2.0)
  })

  test('hit at t=now-14d → factor=0.5 (half-life)', () => {
    const hits: QueryHit[] = [{ slug: 'a', score: 2.0, updated_at: NOW - 14 * DAY_MS }]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked[0]._recency_factor).toBeCloseTo(0.5, 5)
    expect(reranked[0].score).toBeCloseTo(1.0, 5)
  })

  test('hit at t=now-28d → factor=0.25 (2 half-lives)', () => {
    const hits: QueryHit[] = [{ slug: 'a', score: 4.0, updated_at: NOW - 28 * DAY_MS }]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked[0]._recency_factor).toBeCloseTo(0.25, 5)
    expect(reranked[0].score).toBeCloseTo(1.0, 5)
  })

  test('hits without timestamp keep factor=1.0 (bm25 order preserved)', () => {
    const hits: QueryHit[] = [
      { slug: 'no-ts', score: 1.5 },
      { slug: 'with-ts', score: 1.0, updated_at: NOW }
    ]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    // no-ts keeps 1.5, with-ts keeps 1.0 (no decay since hit is now). Sort DESC.
    expect(reranked[0].slug).toBe('no-ts')
    expect(reranked[1].slug).toBe('with-ts')
  })

  test('rerank flips order when newer hit had lower original score', () => {
    // Older hit has bigger bm25 but is 28d old (factor 0.25 → effective 1.0).
    // Newer hit has smaller bm25 but is fresh (factor 1.0 → effective 1.5).
    const hits: QueryHit[] = [
      { slug: 'old-strong', score: 4.0, updated_at: NOW - 28 * DAY_MS },
      { slug: 'new-weak', score: 1.5, updated_at: NOW }
    ]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked[0].slug).toBe('new-weak')
    expect(reranked[1].slug).toBe('old-strong')
  })

  test('custom halfLifeDays — τ=7d makes 7d hit factor=0.5', () => {
    const hits: QueryHit[] = [{ slug: 'a', score: 2.0, updated_at: NOW - 7 * DAY_MS }]
    const reranked = rerankByRecency(hits, { nowMs: NOW, halfLifeDays: 7 })
    expect(reranked[0]._recency_factor).toBeCloseTo(0.5, 5)
  })

  test('does NOT mutate input hits', () => {
    const hits: QueryHit[] = [{ slug: 'a', score: 2.0, updated_at: NOW - 14 * DAY_MS }]
    const before = JSON.stringify(hits)
    rerankByRecency(hits, { nowMs: NOW })
    expect(JSON.stringify(hits)).toBe(before)
  })

  test('attaches _recency_factor + _original_score to reranked output for debug', () => {
    const hits: QueryHit[] = [{ slug: 'a', score: 2.0, updated_at: NOW - 14 * DAY_MS }]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked[0]).toHaveProperty('_recency_factor')
    expect(reranked[0]).toHaveProperty('_original_score', 2.0)
  })

  test('hit without score treated as 0 (sinks to bottom)', () => {
    const hits: QueryHit[] = [
      { slug: 'noscore', updated_at: NOW },
      { slug: 'withscore', score: 0.1, updated_at: NOW }
    ]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked[0].slug).toBe('withscore')
    expect(reranked[1].slug).toBe('noscore')
  })

  test('Δt < 0 (future timestamp) clamps to factor=1.0 (Math.max guard)', () => {
    // Hit timestamp from the future shouldn't get >1.0 boost.
    const hits: QueryHit[] = [{ slug: 'future', score: 1.0, updated_at: NOW + DAY_MS }]
    const reranked = rerankByRecency(hits, { nowMs: NOW })
    expect(reranked[0]._recency_factor).toBeCloseTo(1.0, 5)
  })
})
