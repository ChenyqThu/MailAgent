// REVIEW-LOG C-03 — attachment list/localPath IPC handler. SQLite direct
// read; binary content stays on disk and is exposed via local_path so the
// renderer can `file://` it directly (Electron `webPreferences.sandbox:false`
// keeps file: legal). V2 Web SPA cannot do that and must route through the
// FastAPI `/api/attachment/{id}/download` StreamingResponse (out of Sprint 1
// scope; see BACKEND-INTERFACES.md §4.4).

import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join } from 'node:path'

import { ipcMain } from 'electron'

import { getDb, resolveDbPath } from '../db'
import type { AttachmentList_AttachmentItem } from '@shared/types/cli.gen'

interface AttachmentRow {
  id: number
  internal_id: number
  filename: string
  size_bytes: number | null
  content_type: string | null
  is_inline: number | null
  content_id: string | null
  sha256: string | null
  derived_from: number | null
  derived_format: string | null
  notion_file_id: string | null
  notion_block_id: string | null
  local_path: string | null
}

function shape(row: AttachmentRow): AttachmentList_AttachmentItem {
  return {
    id: row.id,
    internal_id: row.internal_id,
    filename: row.filename,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    is_inline: row.is_inline === 1,
    content_id: row.content_id,
    sha256: row.sha256,
    derived_from: row.derived_from,
    derived_format: row.derived_format,
    notion_file_id: row.notion_file_id,
    notion_block_id: row.notion_block_id
  }
}

export function listAttachments(internalId: number): AttachmentList_AttachmentItem[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, internal_id, filename, size_bytes, content_type, is_inline,
              content_id, sha256, derived_from, derived_format,
              notion_file_id, notion_block_id, local_path
       FROM email_attachment
       WHERE internal_id = ?
       ORDER BY id ASC`
    )
    .all(internalId) as AttachmentRow[]
  return rows.map(shape)
}

// ── PR-2b: 附件文本 FTS5 搜索 ──────────────────────────────────────
//
// 跟 handlers/email.ts:searchEmails 平行设计 — 搜的是 email_attachment_fts
// (PDF / docx / pptx / xlsx 文本抽取结果), JOIN email_attachment + 邮件
// metadata 拼上下文.
// smart mode (default) 复用 PR-2a 的 smartQueryTransform 让 CJK 自然语言
// 自动改写; raw mode 跳过.
import { smartQueryTransform } from './email'

export interface AttachmentSearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
  mode?: 'smart' | 'raw'
}

export interface AttachmentSearchHit {
  attachment_id: number
  internal_id: number
  filename: string
  content_type: string | null
  email_subject: string
  email_sender: string
  email_date: string | null
  email_mailbox: string | null
  snippet: string
  rank: number
  notion_page_id: string | null
  notion_url: string | null
}

export interface AttachmentSearchResult {
  items: AttachmentSearchHit[]
  total_indexed: number
  mode?: 'smart' | 'raw'
  transformed_query?: string
}

interface AttachmentSearchRow {
  attachment_id: number
  internal_id: number
  filename: string | null
  content_type: string | null
  email_subject: string | null
  email_sender: string | null
  email_date: string | null
  email_mailbox: string | null
  notion_page_id: string | null
  snippet: string | null
  rank: number
}

function getAttachmentFtsCount(): number {
  const db = getDb()
  const row = db.prepare(`SELECT COUNT(*) AS n FROM email_attachment_fts`).get() as
    | { n: number }
    | undefined
  return row?.n ?? 0
}

export function searchAttachments(opts: AttachmentSearchOpts): AttachmentSearchResult {
  const total_indexed = getAttachmentFtsCount()
  if (!opts.query || opts.query.trim().length === 0) {
    return { items: [], total_indexed }
  }
  const mode: 'smart' | 'raw' = opts.mode ?? 'smart'
  const effectiveQuery = mode === 'smart' ? smartQueryTransform(opts.query) : opts.query
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  const filterClauses: string[] = []
  const filterParams: unknown[] = []
  if (opts.mailbox) {
    filterClauses.push('m.mailbox = ?')
    filterParams.push(opts.mailbox)
  }
  if (opts.since) {
    filterClauses.push('m.date_received >= ?')
    filterParams.push(opts.since)
  }
  if (opts.until) {
    filterClauses.push('m.date_received <= ?')
    filterParams.push(opts.until)
  }
  const filterSql = filterClauses.length === 0 ? '' : 'AND ' + filterClauses.join(' AND ')
  const sql = `
    SELECT a.id             AS attachment_id,
           a.internal_id    AS internal_id,
           COALESCE(a.filename, '')      AS filename,
           a.content_type   AS content_type,
           COALESCE(m.subject, '')       AS email_subject,
           COALESCE(m.sender, '')        AS email_sender,
           m.date_received               AS email_date,
           m.mailbox                     AS email_mailbox,
           m.notion_page_id              AS notion_page_id,
           snippet(email_attachment_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
           bm25(email_attachment_fts)    AS rank
      FROM email_attachment_fts
      JOIN email_attachment a ON a.id = email_attachment_fts.rowid
      JOIN email_metadata m ON m.internal_id = a.internal_id
     WHERE email_attachment_fts MATCH ?
     ${filterSql}
     ORDER BY rank ASC
     LIMIT ?`
  let rows: AttachmentSearchRow[]
  try {
    rows = db.prepare(sql).all(effectiveQuery, ...filterParams, limit) as AttachmentSearchRow[]
  } catch {
    // FTS5 syntax error → empty (caller 已经传了 wrapper, raw 时用户自负责)
    const fallback: AttachmentSearchResult = { items: [], total_indexed, mode }
    if (effectiveQuery !== opts.query) fallback.transformed_query = effectiveQuery
    return fallback
  }
  const items: AttachmentSearchHit[] = rows.map((row) => ({
    attachment_id: row.attachment_id,
    internal_id: row.internal_id,
    filename: row.filename ?? '',
    content_type: row.content_type,
    email_subject: row.email_subject ?? '',
    email_sender: row.email_sender ?? '',
    email_date: row.email_date,
    email_mailbox: row.email_mailbox,
    snippet: row.snippet ?? '',
    rank: row.rank,
    notion_page_id: row.notion_page_id,
    notion_url: row.notion_page_id
      ? `https://www.notion.so/${row.notion_page_id.replace(/-/g, '')}`
      : null
  }))
  const result: AttachmentSearchResult = { items, total_indexed, mode }
  if (effectiveQuery !== opts.query) {
    result.transformed_query = effectiveQuery
  }
  return result
}

export function getAttachmentLocalPath(attachmentId: number): string | null {
  const db = getDb()
  const row = db
    .prepare('SELECT local_path FROM email_attachment WHERE id = ?')
    .get(attachmentId) as { local_path: string | null } | undefined
  const stored = row?.local_path ?? null
  if (stored === null) return null
  // Mirror readAttachmentAsDataUrl's resolution: stored paths are
  // relative to the project root (where the backend writes from),
  // but the renderer needs an absolute file:// URL to open.
  if (isAbsolute(stored)) return stored
  return join(dirname(dirname(resolveDbPath())), stored)
}

// Sprint 13 — inline-image data URL. The sandboxed body iframe (srcdoc,
// `sandbox="allow-same-origin"`, no allow-scripts) cannot load `file://`
// URLs even when Electron disables web security for the renderer — the
// iframe inherits a stricter same-origin context where file: is opaque.
// Round-tripping the bytes as `data:<mime>;base64,...` sidesteps the
// barrier; payload size is bounded by typical inline screenshot size
// (≤ 1 MB → base64 ~1.4 MB, well below the IPC message ceiling).
function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.heic')) return 'image/heic'
  return 'application/octet-stream'
}

export async function readAttachmentAsDataUrl(attachmentId: number): Promise<string | null> {
  const db = getDb()
  const row = db
    .prepare('SELECT local_path, content_type, filename FROM email_attachment WHERE id = ?')
    .get(attachmentId) as
    | { local_path: string | null; content_type: string | null; filename: string }
    | undefined
  if (!row || row.local_path === null) return null
  // Sprint 14 round 18 — local_path is stored relative ("data/attach-
  // ments/<id>/<file>") because the backend writes from the project
  // root.  Electron's main process cwd is the .app bundle / dev
  // dir, not the project root, so readFile() with the relative path
  // ENOENTs silently and we fall back to a broken image in the
  // iframe.  Resolve against the db dir's parent (= project root —
  // db itself lives at <root>/data/sync_store.db).
  let absPath = row.local_path
  if (!isAbsolute(absPath)) {
    const root = dirname(dirname(resolveDbPath()))
    absPath = join(root, absPath)
  }
  try {
    const bytes = await readFile(absPath)
    const mime = row.content_type ?? guessMimeFromName(row.filename)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    // ENOENT or sandbox denied — silent null so the iframe falls back
    // to the broken-image glyph rather than crashing the panel.
    return null
  }
}

// Copy the attachment into ~/Downloads with collision-safe renaming.
// Chromium refuses `window.open('file://...')` from a `http://localhost:5173`
// origin (dev server) — even in Electron with sandbox:false — so the renderer
// cannot navigate to the on-disk path directly. A real download IPC keeps the
// UX intuitive (matches Mail.app's "Save Attachment…" behaviour) and works
// across dev / packaged builds. Returns the final absolute path, or null if
// the source is missing or the row has no on-disk content.
export async function downloadAttachmentToDownloads(attachmentId: number): Promise<string | null> {
  const db = getDb()
  const row = db
    .prepare('SELECT local_path, filename FROM email_attachment WHERE id = ?')
    .get(attachmentId) as { local_path: string | null; filename: string } | undefined
  if (!row || row.local_path === null) return null

  let src = row.local_path
  if (!isAbsolute(src)) src = join(dirname(dirname(resolveDbPath())), src)
  try {
    await access(src, fsConstants.R_OK)
  } catch {
    return null
  }

  const downloadsDir = join(homedir(), 'Downloads')
  await mkdir(downloadsDir, { recursive: true })

  const ext = extname(row.filename)
  const stem = ext ? row.filename.slice(0, -ext.length) : row.filename
  let target = join(downloadsDir, row.filename)
  let counter = 1
  // Collision: file already exists → append `_1`, `_2`, … before extension.
  while (true) {
    try {
      await access(target, fsConstants.F_OK)
      target = join(downloadsDir, `${stem}_${counter}${ext}`)
      counter += 1
    } catch {
      break
    }
  }
  await copyFile(src, target)
  return target
}

export function registerAttachmentHandlers(): void {
  ipcMain.handle('attachment:list', (_evt, internalId: number) => {
    if (!Number.isInteger(internalId) || internalId < 0) {
      throw new TypeError(
        `attachment:list expected non-negative integer, got ${String(internalId)}`
      )
    }
    return listAttachments(internalId)
  })
  ipcMain.handle('attachment:localPath', (_evt, attachmentId: number) => {
    if (!Number.isInteger(attachmentId) || attachmentId < 0) {
      throw new TypeError(
        `attachment:localPath expected non-negative integer, got ${String(attachmentId)}`
      )
    }
    return getAttachmentLocalPath(attachmentId)
  })
  ipcMain.handle('attachment:readDataUrl', async (_evt, attachmentId: number) => {
    if (!Number.isInteger(attachmentId) || attachmentId < 0) {
      throw new TypeError(
        `attachment:readDataUrl expected non-negative integer, got ${String(attachmentId)}`
      )
    }
    return readAttachmentAsDataUrl(attachmentId)
  })
  ipcMain.handle('attachment:download', async (_evt, attachmentId: number) => {
    if (!Number.isInteger(attachmentId) || attachmentId < 0) {
      throw new TypeError(
        `attachment:download expected non-negative integer, got ${String(attachmentId)}`
      )
    }
    return downloadAttachmentToDownloads(attachmentId)
  })
}
