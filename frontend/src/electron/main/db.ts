// better-sqlite3 singleton. Sprint 0 = open with WAL + busy_timeout; Sprint 1
// IPC handlers (email.list / .get / .body / .search / attachment.list) consume
// this. Path resolution per ARCHITECTURE.md §5:
//   1. env SYNC_STORE_DB_PATH (matches the backend's pydantic Config)
//   2. ~/Documents/MailAgent/data/sync_store.db (project default)
// We never open the file write-mode from the renderer — schema is mail-sync
// territory (REVIEW-LOG C-05); frontend reads only, and writes go via the
// `mailagent` CLI subprocess.

import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

let _db: Database.Database | null = null

export function resolveDbPath(): string {
  const fromEnv = process.env['SYNC_STORE_DB_PATH']
  if (fromEnv && existsSync(fromEnv)) return fromEnv
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
