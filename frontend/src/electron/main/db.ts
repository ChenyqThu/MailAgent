// better-sqlite3 singleton. Sprint 0 = open with WAL + busy_timeout; Sprint 1
// IPC handlers (email.list / .get / .body / .search / attachment.list) consume
// this. Path resolution per ARCHITECTURE.md §5:
//   1. env SYNC_STORE_DB_PATH (matches the backend's pydantic Config)
//   2. user override from settings.json (`dbPath`) — Sprint 8 wire-through
//   3. ~/Documents/MailAgent/data/sync_store.db (project default)
// We never open the file write-mode from the renderer — schema is mail-sync
// territory (REVIEW-LOG C-05); frontend reads only, and writes go via the
// `mailagent` CLI subprocess.

import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { isSafeUserPath } from './lib/path-guard'

let _db: Database.Database | null = null

/**
 * Read the user's `dbPath` override from `<userData>/settings.json`. Returns
 * the validated absolute path or null on any failure — Sprint 7 review
 * MEDIUM #1 fix: the IPC sanitizer was dead code without this wire.
 *
 * Defense-in-depth: even though `handlers/settings.ts:sanitize()` already
 * runs `isSafeUserPath()` on write, we re-validate on read so a settings
 * file that was tampered with out-of-band (manual edit, sync conflict
 * roll-back) cannot smuggle a traversal through.
 */
export function settingsDbPathOverride(): string | null {
  try {
    const SETTINGS_FILE = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(SETTINGS_FILE)) return null
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { dbPath?: unknown }
    if (typeof raw.dbPath !== 'string') return null
    if (!isSafeUserPath(raw.dbPath)) return null
    return raw.dbPath
  } catch {
    return null
  }
}

export function resolveDbPath(): string {
  const fromEnv = process.env['SYNC_STORE_DB_PATH']
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  // Sprint 8 §2.2 — settings.json wire-through (Sprint 7 review MEDIUM #1).
  // `settingsDbPathOverride()` returns null when `app` isn't ready (e.g.
  // unit tests that import this module before `app.whenReady()`), keeping
  // existing fixture-based tests working without modification.
  try {
    const fromSettings = settingsDbPathOverride()
    if (fromSettings && existsSync(fromSettings)) return fromSettings
  } catch {
    /* app.getPath() can throw before app.whenReady() — fall through to default. */
  }
  return join(homedir(), 'Documents', 'MailAgent', 'data', 'sync_store.db')
}

export function getDb(): Database.Database {
  if (_db) return _db
  const path = resolveDbPath()
  if (!existsSync(path)) {
    throw new Error(
      `sync_store.db not found at ${path}. Set SYNC_STORE_DB_PATH or run mail-sync first.`
    )
  }
  _db = new Database(path, { readonly: true, fileMustExist: true })
  _db.pragma('journal_mode = WAL')
  _db.pragma('busy_timeout = 2000')
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
