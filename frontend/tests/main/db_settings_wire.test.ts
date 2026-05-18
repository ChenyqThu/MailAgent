// Sprint 8 §2.2 (Sprint 7 ship-review MEDIUM #1) — `db.ts:resolveDbPath()`
// must honour the user's `settings.dbPath` override, otherwise the IPC
// sanitizer in `handlers/settings.ts` is dead code.
//
// We test by writing a temp `settings.json` to a fake userData dir and
// asserting `settingsDbPathOverride()` validates + returns the path.

import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: (_kind: string) => userDataDir,
    getVersion: () => '1.2.3'
  }
}))

const { settingsDbPathOverride } = await import('../../src/electron/main/db')

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'mailagent-db-test-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function writeSettings(json: Record<string, unknown>): void {
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(json), 'utf8')
}

describe('db.settingsDbPathOverride', () => {
  test('returns null when settings.json missing', () => {
    expect(settingsDbPathOverride()).toBe(null)
  })

  test('returns null when dbPath absent', () => {
    writeSettings({ pollIntervalSec: 5 })
    expect(settingsDbPathOverride()).toBe(null)
  })

  test('returns null when dbPath is non-string', () => {
    writeSettings({ dbPath: 42 })
    expect(settingsDbPathOverride()).toBe(null)
  })

  test('accepts absolute path without traversal', () => {
    writeSettings({ dbPath: '/Users/me/MailAgent/data/sync_store.db' })
    expect(settingsDbPathOverride()).toBe('/Users/me/MailAgent/data/sync_store.db')
  })

  test('rejects relative dbPath', () => {
    writeSettings({ dbPath: './evil.db' })
    expect(settingsDbPathOverride()).toBe(null)
  })

  test('rejects traversal sequence even after a safe-looking prefix', () => {
    writeSettings({ dbPath: '/Users/me/../../private/etc/passwd' })
    expect(settingsDbPathOverride()).toBe(null)
  })

  test('returns null on malformed JSON (defense in depth)', () => {
    writeFileSync(join(userDataDir, 'settings.json'), '{not: valid json', 'utf8')
    expect(settingsDbPathOverride()).toBe(null)
  })
})
