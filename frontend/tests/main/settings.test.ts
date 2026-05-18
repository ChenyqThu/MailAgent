// Sprint 6 §2.2 — settings persistence sanitizer contract.
//
// `sanitize()` is the gatekeeper between renderer-supplied patches and the
// disk file. Type drift / future schema bumps must not silently coerce a
// hostile value (e.g. arbitrary string for pollIntervalSec); the sanitizer
// drops anything that doesn't match the literal enum.

import { describe, expect, test, vi } from 'vitest'

// Stub Electron's `app.getPath('userData')` BEFORE importing the handler —
// module-load reads SETTINGS_FILE = join(userData, 'settings.json'), and
// the Electron module isn't initialized in the node test pool.
vi.mock('electron', () => ({
  app: { getPath: (_kind: string) => '/tmp/mailagent-test-userdata' },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))

const { __testing } = await import('../../src/electron/main/handlers/settings')

describe('settings.sanitize', () => {
  test('accepts canonical shape', () => {
    expect(
      __testing.sanitize({
        dbPath: '/tmp/db',
        attachmentDir: '/tmp/att',
        pollIntervalSec: 10,
        notionAgentPageId: 'abc',
        notionAgentName: 'Jarvis',
        customApiEndpoint: 'https://crs.example.com'
      })
    ).toEqual({
      dbPath: '/tmp/db',
      attachmentDir: '/tmp/att',
      pollIntervalSec: 10,
      notionAgentPageId: 'abc',
      notionAgentName: 'Jarvis',
      customApiEndpoint: 'https://crs.example.com'
    })
  })

  test('null clears optional path fields', () => {
    expect(__testing.sanitize({ dbPath: null, attachmentDir: null })).toEqual({
      dbPath: null,
      attachmentDir: null
    })
  })

  test('rejects pollIntervalSec outside {5,10,30,0} enum', () => {
    // 60 is not in the enum — drop it.
    expect(__testing.sanitize({ pollIntervalSec: 60 } as never)).toEqual({})
    // 0 (off) IS allowed.
    expect(__testing.sanitize({ pollIntervalSec: 0 })).toEqual({ pollIntervalSec: 0 })
  })

  test('drops unknown keys silently', () => {
    expect(
      __testing.sanitize({ unrelated: 'leak' } as unknown as Parameters<
        typeof __testing.sanitize
      >[0])
    ).toEqual({})
  })

  test('coerces wrong-type pollIntervalSec to dropped', () => {
    expect(
      __testing.sanitize({ pollIntervalSec: '5' as unknown as 5 } as never)
    ).toEqual({})
  })

  test('null preserves notion fields (the "clear binding" path)', () => {
    expect(__testing.sanitize({ notionAgentPageId: null, notionAgentName: null })).toEqual({
      notionAgentPageId: null,
      notionAgentName: null
    })
  })

  test('DEFAULTS reads pollIntervalSec=5 (most-aggressive sync)', () => {
    expect(__testing.DEFAULTS.pollIntervalSec).toBe(5)
    expect(__testing.DEFAULTS.dbPath).toBeNull()
    expect(__testing.DEFAULTS.attachmentDir).toBeNull()
  })
})

// Sprint 7 D1 (Sprint 6 review opus MEDIUM #1 carry-forward) — `dbPath` /
// `attachmentDir` are wired into `better-sqlite3.Database(...)` + fs reads in
// Sprint 7+. Any traversal sequence or relative path supplied via the IPC
// must be rejected at the sanitize boundary so a malicious renderer message
// can't escape the user's chosen scope.
describe('settings.sanitize path validation (MEDIUM #1)', () => {
  test('accepts absolute path without traversal', () => {
    expect(__testing.isSafeUserPath('/Users/me/db.sqlite')).toBe(true)
    expect(__testing.isSafeUserPath('/var/folders/abc/data')).toBe(true)
  })

  test('rejects relative paths', () => {
    expect(__testing.isSafeUserPath('./db.sqlite')).toBe(false)
    expect(__testing.isSafeUserPath('data/sync_store.db')).toBe(false)
    expect(__testing.isSafeUserPath('')).toBe(false)
  })

  test('rejects traversal segments', () => {
    expect(__testing.isSafeUserPath('/Users/me/../../etc/passwd')).toBe(false)
    expect(__testing.isSafeUserPath('/Users/me/foo/..')).toBe(false)
  })

  test('sanitize drops non-absolute dbPath silently', () => {
    expect(__testing.sanitize({ dbPath: './evil.db' })).toEqual({})
    expect(__testing.sanitize({ attachmentDir: '../escape' })).toEqual({})
  })

  test('sanitize drops traversal-bearing absolute path', () => {
    expect(__testing.sanitize({ dbPath: '/Users/me/../../private/etc' })).toEqual({})
  })

  test('sanitize accepts safe absolute path', () => {
    expect(__testing.sanitize({ dbPath: '/Users/me/db.sqlite' })).toEqual({
      dbPath: '/Users/me/db.sqlite'
    })
  })

  test('sanitize allows null to clear path (DEFAULTS fallback)', () => {
    expect(__testing.sanitize({ dbPath: null })).toEqual({ dbPath: null })
    expect(__testing.sanitize({ attachmentDir: null })).toEqual({ attachmentDir: null })
  })
})
