// Phase C — 存档 / 草稿箱 folder handler.
//
// 读 (list / get / search / syncStatus) 落 better-sqlite3 直读 `folder_email`
// 表 (~5ms), 仿 handlers/email.ts 的 getEmail / listEmails + prep() helper.
// 写 (syncNow / delete / move / sendDraft / createDraft / editDraft) fork
// `mailagent folder <cmd>` CLI (needsAuth + davmail-only), 仿 handlers/
// calendar-write.ts 的 envelopeFromCli(callCli(...)) 范式。
//
// folder_email 是 DB v17 独立表 (CLAUDE.md Phase C 段); 不挂 email_metadata,
// 所有读 WHERE folder=? AND deleted_at IS NULL ORDER BY date_received DESC.

import type { Database, Statement } from 'better-sqlite3'
import { ipcMain } from 'electron'

import { callCli } from '../cli_runner'
import { daemonRequest } from '../daemon_api'
import { getDb } from '../db'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'
import { smartQueryTransform } from './email'
import type {
  FolderApi,
  FolderAttachmentMeta,
  FolderDiscoverResult,
  FolderEmailDetail,
  FolderEmailMeta,
  FolderListOpts,
  FolderName,
  FolderSearchOpts,
  FolderSearchResult,
  FolderSetWhitelistResult,
  FolderSyncStateItem,
  FolderSyncStatusResult,
  FolderWhitelistResult
} from '@shared/api/types'

const WRITE_TIMEOUT_MS = 120_000

const VALID_FOLDERS: ReadonlySet<string> = new Set<FolderName>(['archive', 'drafts'])

// ---- raw row shape (private — never leaks to renderer) ----------------------

interface FolderEmailRow {
  id: number
  folder: string
  imap_uid: number
  imap_uidvalidity: number
  message_id: string | null
  thread_id: string | null
  subject: string | null
  sender: string | null
  sender_name: string | null
  to_addr: string | null
  cc_addr: string | null
  date_received: string | null
  is_flagged: number | null
  has_attachments: number | null
  snippet: string | null
  attachments_json: string | null
  // detail-only
  body_html?: string | null
  body_markdown?: string | null
}

// ---- shaping helpers --------------------------------------------------------

function asBool(n: number | null | undefined): boolean {
  return n === 1
}

function asFolderName(f: string): FolderName {
  // CHECK constraint at the SQLite layer guarantees one of the two; the cast
  // is defensive so the renderer type stays the narrow union.
  return f === 'drafts' ? 'drafts' : 'archive'
}

function parseAttachments(json: string | null): FolderAttachmentMeta[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({
        filename: typeof a.filename === 'string' ? a.filename : '',
        size: typeof a.size === 'number' ? a.size : 0,
        content_type: typeof a.content_type === 'string' ? a.content_type : ''
      }))
  } catch {
    return []
  }
}

function shapeMeta(row: FolderEmailRow): FolderEmailMeta {
  return {
    id: row.id,
    folder: asFolderName(row.folder),
    imap_uid: row.imap_uid,
    imap_uidvalidity: row.imap_uidvalidity,
    message_id: row.message_id,
    thread_id: row.thread_id,
    subject: row.subject ?? '',
    sender: row.sender ?? '',
    sender_name: row.sender_name,
    to_addr: row.to_addr ?? '',
    cc_addr: row.cc_addr ?? '',
    date_received: row.date_received,
    is_flagged: asBool(row.is_flagged),
    has_attachments: asBool(row.has_attachments),
    snippet: row.snippet,
    attachments: parseAttachments(row.attachments_json)
  }
}

function shapeDetail(row: FolderEmailRow): FolderEmailDetail {
  return {
    ...shapeMeta(row),
    body_html: row.body_html ?? null,
    body_markdown: row.body_markdown ?? null
  }
}

// ---- statement cache (mirrors handlers/email.ts) ----------------------------

const stmtCache = new Map<string, Statement>()

function prep(db: Database, sql: string): Statement {
  const hit = stmtCache.get(sql)
  if (hit) return hit
  const stmt = db.prepare(sql)
  stmtCache.set(sql, stmt)
  return stmt
}

const META_COLS = `
    id, folder, imap_uid, imap_uidvalidity, message_id, thread_id, subject,
    sender, sender_name, to_addr, cc_addr, date_received, is_flagged,
    has_attachments, snippet, attachments_json
`

const DETAIL_COLS = `${META_COLS}, body_html, body_markdown`

// Same META columns but qualified to the `f.` alias for the FTS5 JOIN
// (bare names would be ambiguous against folder_email_fts).
const META_COLS_F = `
    f.id, f.folder, f.imap_uid, f.imap_uidvalidity, f.message_id, f.thread_id,
    f.subject, f.sender, f.sender_name, f.to_addr, f.cc_addr, f.date_received,
    f.is_flagged, f.has_attachments, f.snippet, f.attachments_json
`

// ---- read handlers ----------------------------------------------------------

export function listFolder(opts: FolderListOpts): FolderEmailMeta[] {
  if (!opts || !VALID_FOLDERS.has(opts.folder)) return []
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const offset = Math.max(opts.offset ?? 0, 0)
  const sql = `SELECT ${META_COLS}
               FROM folder_email
               WHERE folder = ? AND deleted_at IS NULL
               ORDER BY date_received DESC NULLS LAST, id DESC
               LIMIT ? OFFSET ?`
  let rows: FolderEmailRow[] = []
  try {
    rows = prep(db, sql).all(opts.folder, limit, offset) as FolderEmailRow[]
  } catch (e) {
    console.warn('[folder:list] query failed (folder_email table missing?):', e)
    return []
  }
  return rows.map(shapeMeta)
}

export function getFolderEmail(id: number): FolderEmailDetail | null {
  const db = getDb()
  let row: FolderEmailRow | undefined
  try {
    row = prep(
      db,
      `SELECT ${DETAIL_COLS} FROM folder_email WHERE id = ? AND deleted_at IS NULL`
    ).get(id) as FolderEmailRow | undefined
  } catch (e) {
    console.warn('[folder:get] query failed:', e)
    return null
  }
  return row ? shapeDetail(row) : null
}

export function searchFolder(opts: FolderSearchOpts): FolderSearchResult {
  const query = opts?.query ?? ''
  if (!query || query.trim().length === 0) {
    return { query, transformed_query: null, total_hits: 0, hits: [] }
  }
  const db = getDb()
  const raw = opts.raw === true
  const effectiveQuery = raw ? query : smartQueryTransform(query)
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const filterClauses: string[] = ['f.deleted_at IS NULL']
  const filterParams: unknown[] = []
  if (opts.folder && VALID_FOLDERS.has(opts.folder)) {
    filterClauses.push('f.folder = ?')
    filterParams.push(opts.folder)
  }
  // folder_email_fts is a contentless FTS5 index whose rowid maps to
  // folder_email.id (mirrors email_body_fts ↔ email_metadata.internal_id).
  const sql = `
    SELECT ${META_COLS_F}
    FROM folder_email_fts
    JOIN folder_email f ON f.id = folder_email_fts.rowid
    WHERE folder_email_fts MATCH ?
    ${filterClauses.length > 0 ? 'AND ' + filterClauses.join(' AND ') : ''}
    ORDER BY bm25(folder_email_fts) ASC
    LIMIT ?`
  let rows: FolderEmailRow[] = []
  try {
    rows = prep(db, sql).all(effectiveQuery, ...filterParams, limit) as FolderEmailRow[]
  } catch (e) {
    console.warn('[folder:search] query failed:', e)
    return {
      query,
      transformed_query: raw ? null : effectiveQuery,
      total_hits: 0,
      hits: []
    }
  }
  const hits = rows.map(shapeMeta)
  return {
    query,
    transformed_query: raw || effectiveQuery === query ? null : effectiveQuery,
    total_hits: hits.length,
    hits
  }
}

export function folderSyncStatus(): FolderSyncStatusResult {
  const db = getDb()
  let states: FolderSyncStateItem[] = []
  try {
    const rows = prep(
      db,
      `SELECT folder, imap_uidvalidity, last_uidnext, last_full_sync_at,
              last_incremental_sync_at, last_error
       FROM folder_sync_state ORDER BY folder`
    ).all() as FolderSyncStateItem[]
    states = rows
  } catch (e) {
    console.warn('[folder:syncStatus] folder_sync_state query failed:', e)
  }
  const counts: Record<string, number> = {}
  for (const folder of ['archive', 'drafts'] as const) {
    try {
      const row = prep(
        db,
        `SELECT COUNT(*) AS n FROM folder_email WHERE folder = ? AND deleted_at IS NULL`
      ).get(folder) as { n: number } | undefined
      counts[folder] = row?.n ?? 0
    } catch {
      counts[folder] = 0
    }
  }
  return { states, counts }
}

// ---- write handlers (fork CLI, needsAuth + davmail-only) --------------------

export function runFolderSyncNow(folder: FolderName, full = true): Promise<unknown> {
  const args = ['folder', 'sync-now', folder, full ? '--full' : '--incremental']
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export function runFolderDelete(id: number): Promise<unknown> {
  const args = ['folder', 'delete', String(id), '--yes']
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export function runFolderMove(id: number, to = '收件箱'): Promise<unknown> {
  const args = ['folder', 'move', String(id), '--to', to, '--yes']
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export function runFolderSendDraft(id: number): Promise<unknown> {
  const args = ['folder', 'send-draft', String(id), '--yes']
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export interface FolderCreateDraftArgs {
  to: string
  html: string
  cc?: string
  subject?: string
}

export function runFolderCreateDraft(opts: FolderCreateDraftArgs): Promise<unknown> {
  const args = ['folder', 'create-draft', '--to', opts.to, '--html', opts.html]
  if (opts.cc) args.push('--cc', opts.cc)
  if (opts.subject !== undefined) args.push('--subject', opts.subject)
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export interface FolderEditDraftArgs {
  id: number
  html: string
  to?: string
  cc?: string
  subject?: string
}

export function runFolderEditDraft(opts: FolderEditDraftArgs): Promise<unknown> {
  const args = ['folder', 'edit-draft', String(opts.id), '--html', opts.html]
  if (opts.to !== undefined) args.push('--to', opts.to)
  if (opts.cc !== undefined) args.push('--cc', opts.cc)
  if (opts.subject !== undefined) args.push('--subject', opts.subject)
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

// ---- 多文件夹同步 (P3) — discover/whitelist (daemon → serve-api 转发) ---------
//
// 这三个不直读 SQLite (discover 要现连 IMAP LIST, whitelist 读/写 .env), 故经
// daemonRequest 转发到本机 serve-api in-process service (D1 架构, 注本地 token),
// 与远程 web 的 HttpApi 同 wire。serve-api 对非 davmail 后端返回 400 E_INVALID_ARG
// → daemonRequest 抛 ApiError{code} → envelopeFromCli 收成 {ok:false,code} 过 IPC →
// ElectronApi.unwrap 重抛带 code → FolderPicker 据此切门控态。

export function runFolderDiscover(counts = true): Promise<FolderDiscoverResult> {
  return daemonRequest<FolderDiscoverResult>('GET', '/folder/discover', {
    query: { counts }
  })
}

export function runFolderGetWhitelist(): Promise<FolderWhitelistResult> {
  return daemonRequest<FolderWhitelistResult>('GET', '/folder/whitelist')
}

export function runFolderSetWhitelist(imapNames: string[]): Promise<FolderSetWhitelistResult> {
  return daemonRequest<FolderSetWhitelistResult>('PUT', '/folder/whitelist', {
    body: { folders: imapNames }
  })
}

// ---- IPC wiring -------------------------------------------------------------

export function registerFolderHandlers(): void {
  // Reads — better-sqlite3 直读, 无 envelope (跟 email:list / calendar:eventsList 一致)
  ipcMain.handle('folder:list', (_evt, opts: FolderListOpts) => listFolder(opts))
  ipcMain.handle('folder:get', (_evt, id: number) => {
    if (!Number.isInteger(id) || id < 0) {
      throw new TypeError(`folder:get expected non-negative integer, got ${String(id)}`)
    }
    return getFolderEmail(id)
  })
  ipcMain.handle('folder:search', (_evt, opts: FolderSearchOpts) => {
    if (typeof opts?.query !== 'string') {
      throw new TypeError('folder:search expected { query: string, … }')
    }
    return searchFolder(opts)
  })
  ipcMain.handle('folder:syncStatus', () => folderSyncStatus())

  // Writes — fork CLI + envelope (跟 calendar:event* 一致)
  ipcMain.handle(
    'folder:syncNow',
    async (_evt, folder: FolderName, full?: boolean): Promise<WriteEnvelope<unknown>> => {
      if (!VALID_FOLDERS.has(folder)) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: `folder must be archive|drafts, got ${String(folder)}`
        }
      }
      return envelopeFromCli(runFolderSyncNow(folder, full ?? true))
    }
  )
  ipcMain.handle('folder:delete', async (_evt, id: number): Promise<WriteEnvelope<unknown>> => {
    if (!Number.isInteger(id) || id < 0) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: `folder:delete requires non-negative id, got ${String(id)}`
      }
    }
    return envelopeFromCli(runFolderDelete(id))
  })
  ipcMain.handle(
    'folder:move',
    async (_evt, id: number, to?: string): Promise<WriteEnvelope<unknown>> => {
      if (!Number.isInteger(id) || id < 0) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: `folder:move requires non-negative id, got ${String(id)}`
        }
      }
      return envelopeFromCli(runFolderMove(id, to ?? '收件箱'))
    }
  )
  ipcMain.handle('folder:sendDraft', async (_evt, id: number): Promise<WriteEnvelope<unknown>> => {
    if (!Number.isInteger(id) || id < 0) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: `folder:sendDraft requires non-negative id, got ${String(id)}`
      }
    }
    return envelopeFromCli(runFolderSendDraft(id))
  })
  ipcMain.handle(
    'folder:createDraft',
    async (_evt, opts: FolderCreateDraftArgs): Promise<WriteEnvelope<unknown>> => {
      if (!opts || typeof opts.to !== 'string' || typeof opts.html !== 'string') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:createDraft requires { to, html }'
        }
      }
      return envelopeFromCli(runFolderCreateDraft(opts))
    }
  )
  ipcMain.handle(
    'folder:editDraft',
    async (_evt, opts: FolderEditDraftArgs): Promise<WriteEnvelope<unknown>> => {
      if (!opts || !Number.isInteger(opts.id) || opts.id < 0 || typeof opts.html !== 'string') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:editDraft requires { id, html }'
        }
      }
      return envelopeFromCli(runFolderEditDraft(opts))
    }
  )

  // 多文件夹同步 (P3) — discover/whitelist。daemon → serve-api 转发, envelope 形态
  // 过 IPC 保住 error.code (davmail 门控)。
  ipcMain.handle(
    'folder:discover',
    async (_evt, opts?: { counts?: boolean }): Promise<WriteEnvelope<FolderDiscoverResult>> =>
      envelopeFromCli<FolderDiscoverResult>(runFolderDiscover(opts?.counts ?? true))
  )
  ipcMain.handle(
    'folder:getWhitelist',
    async (): Promise<WriteEnvelope<FolderWhitelistResult>> =>
      envelopeFromCli<FolderWhitelistResult>(runFolderGetWhitelist())
  )
  ipcMain.handle(
    'folder:setWhitelist',
    async (_evt, imapNames: unknown): Promise<WriteEnvelope<FolderSetWhitelistResult>> => {
      if (!Array.isArray(imapNames) || !imapNames.every((n) => typeof n === 'string')) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:setWhitelist requires string[]'
        }
      }
      return envelopeFromCli<FolderSetWhitelistResult>(runFolderSetWhitelist(imapNames))
    }
  )
}

// Test escape hatch (mirrors handlers/calendar.ts __testing).
export const __testing = {
  listFolder,
  getFolderEmail,
  searchFolder,
  folderSyncStatus,
  runFolderSyncNow,
  runFolderDelete,
  runFolderMove,
  runFolderSendDraft,
  runFolderCreateDraft,
  runFolderEditDraft,
  runFolderDiscover,
  runFolderGetWhitelist,
  runFolderSetWhitelist
}

// Re-export the renderer-facing type so test / other modules can import from
// the handler (parity with calendar.ts re-exports).
export type { FolderApi }
