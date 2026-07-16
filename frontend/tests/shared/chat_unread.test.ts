// harness-chat lane A B4 (task 07-15) — the shared unread derivation (single source for the three
// history lists). NULL/undefined last_read_at deliberately reads NOT-unread (legacy rows / a Python
// mirror running on a not-yet-migrated DB must not light up the whole history).

import { describe, expect, test } from 'vitest'

import { isSessionUnread } from '../../src/shared/lib/chatUnread'

describe('isSessionUnread', () => {
  test('updated after the last read → unread', () => {
    expect(isSessionUnread({ updated_at: 2000, last_read_at: 1000 })).toBe(true)
  })
  test('read at/after the last update → not unread', () => {
    expect(isSessionUnread({ updated_at: 2000, last_read_at: 2000 })).toBe(false)
    expect(isSessionUnread({ updated_at: 2000, last_read_at: 3000 })).toBe(false)
  })
  test('never read (NULL / undefined watermark) → not unread (no badge explosion on migration)', () => {
    expect(isSessionUnread({ updated_at: 2000, last_read_at: null })).toBe(false)
    expect(isSessionUnread({ updated_at: 2000 })).toBe(false)
  })
})
