import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createKeyPoolFetch,
  isKeyCoolingDown,
  markKeyRateLimited,
  normalizeProviderKeys,
  parseRetryAfterMs,
  pickActiveApiKey,
  resetKeyCooldowns
} from '../../src/ai-gateway/keyPool'

describe('ai-gateway keyPool', () => {
  afterEach(() => {
    resetKeyCooldowns()
  })

  it('keeps primary key sticky while healthy and rotates on 429 cooldown', () => {
    const keys = normalizeProviderKeys('sk-primary', ['sk-backup-1', 'sk-primary', 'sk-backup-2'])
    expect(keys).toEqual(['sk-primary', 'sk-backup-1', 'sk-backup-2'])

    expect(pickActiveApiKey('p1', keys, 1_000)).toBe('sk-primary')
    markKeyRateLimited('p1', 'sk-primary', 30_000, 1_000)
    expect(isKeyCoolingDown('p1', 'sk-primary', 10_000)).toBe(true)
    expect(pickActiveApiKey('p1', keys, 10_000)).toBe('sk-backup-1')

    // Once cooldown expires, primary becomes active again
    expect(isKeyCoolingDown('p1', 'sk-primary', 31_000)).toBe(false)
    expect(pickActiveApiKey('p1', keys, 31_000)).toBe('sk-primary')
  })

  it('parses Retry-After numeric seconds and clamps bounds', () => {
    expect(parseRetryAfterMs('12')).toBe(12_000)
    expect(parseRetryAfterMs('0')).toBe(1_000)
    expect(parseRetryAfterMs('99999')).toBe(3_600_000)
    expect(parseRetryAfterMs(null, 45_000)).toBe(45_000)
  })

  it('createKeyPoolFetch transparently fails over on HTTP 429 and rewrites auth headers', async () => {
    const seenAuth: string[] = []
    const baseFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seenAuth.push(headers.get('authorization') ?? '')
      if (seenAuth.length === 1) {
        return new Response('rate limit', { status: 429, headers: { 'retry-after': '20' } })
      }
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch

    const poolFetch = createKeyPoolFetch('p-multi', ['sk-1', 'sk-2'], baseFetch)
    const res = await poolFetch('https://api.example.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-1' }
    })

    expect(res.status).toBe(200)
    expect(seenAuth).toEqual(['Bearer sk-1', 'Bearer sk-2'])
    expect(isKeyCoolingDown('p-multi', 'sk-1')).toBe(true)
    expect(isKeyCoolingDown('p-multi', 'sk-2')).toBe(false)
  })
})
