// REVIEW-LOG C-03 — attachment list/localPath IPC handler. SQLite direct
// read; binary content stays on disk and is exposed via local_path so the
// renderer can `file://` it directly (Electron `webPreferences.sandbox:false`
// keeps file: legal). V2 Web SPA cannot do that and must route through the
// FastAPI `/api/attachment/{id}/download` StreamingResponse (out of Sprint 1
// scope; see BACKEND-INTERFACES.md §4.4).

import { ipcMain } from 'electron'

import { getDb } from '../db'
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
  return row?.local_path ?? null
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
}
