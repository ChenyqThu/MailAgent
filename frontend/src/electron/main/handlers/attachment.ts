// REVIEW-LOG C-03 — attachment list/localPath IPC handler. SQLite direct
// read; binary content stays on disk and is exposed via local_path so the
// renderer can `file://` it directly (Electron `webPreferences.sandbox:false`
// keeps file: legal). V2 Web SPA cannot do that and must route through the
// FastAPI `/api/attachment/{id}/download` StreamingResponse (out of Sprint 1
// scope; see BACKEND-INTERFACES.md §4.4).

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

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
}
