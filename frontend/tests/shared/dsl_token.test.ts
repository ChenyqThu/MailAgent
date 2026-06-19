// G-B3 — facet chip toggle helper unit tests (pure string ops, node env).
// Covers add / remove / idempotent / word-boundary (no substring false-match).

import { describe, expect, test } from 'vitest'

import { hasDslToken, toggleDslToken } from '../../src/shared/lib/dsl_token'

describe('toggleDslToken', () => {
  test('appends a token when absent (empty query)', () => {
    expect(toggleDslToken('', 'is:unread')).toBe('is:unread')
  })

  test('appends space-separated to a non-empty query', () => {
    expect(toggleDslToken('redis', 'is:unread')).toBe('redis is:unread')
  })

  test('removes a token when present (full unit)', () => {
    expect(toggleDslToken('redis is:unread', 'is:unread')).toBe('redis')
    expect(toggleDslToken('is:unread redis', 'is:unread')).toBe('redis')
  })

  test('removing the only token yields empty string', () => {
    expect(toggleDslToken('is:unread', 'is:unread')).toBe('')
  })

  test('idempotent: toggle twice returns to original (normalised)', () => {
    const once = toggleDslToken('redis', 'has:attachment')
    expect(toggleDslToken(once, 'has:attachment')).toBe('redis')
  })

  test('word-boundary: does NOT remove a substring token', () => {
    // `is:unread` must not match inside `is:unreadx`.
    expect(toggleDslToken('is:unreadx', 'is:unread')).toBe('is:unreadx is:unread')
  })

  test('word-boundary: a different unit containing the token text is untouched', () => {
    expect(toggleDslToken('subject:is:unread', 'is:unread')).toBe('subject:is:unread is:unread')
  })

  test('collapses extra whitespace on add', () => {
    expect(toggleDslToken('  redis   timeout  ', 'is:unread')).toBe('redis timeout is:unread')
  })

  test('removes every duplicate occurrence', () => {
    expect(toggleDslToken('is:unread redis is:unread', 'is:unread')).toBe('redis')
  })

  test('quoted mailbox token round-trips', () => {
    const t = 'in:"Sent Items"'
    expect(toggleDslToken('', t)).toBe(t)
    expect(toggleDslToken(t, t)).toBe('')
  })

  test('bare CJK mailbox token round-trips', () => {
    expect(toggleDslToken('redis', 'in:收件箱')).toBe('redis in:收件箱')
    expect(toggleDslToken('redis in:收件箱', 'in:收件箱')).toBe('redis')
  })

  test('empty token is a no-op (returns trimmed query)', () => {
    expect(toggleDslToken('  redis  ', '')).toBe('redis')
    expect(toggleDslToken('  redis  ', '   ')).toBe('redis')
  })
})

describe('hasDslToken', () => {
  test('true only for a full whitespace unit match', () => {
    expect(hasDslToken('redis is:unread', 'is:unread')).toBe(true)
    expect(hasDslToken('redis is:unreadx', 'is:unread')).toBe(false)
    expect(hasDslToken('', 'is:unread')).toBe(false)
  })

  test('empty token is never present', () => {
    expect(hasDslToken('redis', '')).toBe(false)
  })

  test('matches a quoted mailbox token', () => {
    expect(hasDslToken('in:"Sent Items" redis', 'in:"Sent Items"')).toBe(true)
  })
})
