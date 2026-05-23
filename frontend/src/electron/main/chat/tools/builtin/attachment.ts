// Sprint 19 PR-1b — Attachment read tools.
//
// M1 ships only `attachment_list` (metadata: filename / mime / size). The
// M2 `email_search_attachments` tool (FTS5 over extracted PDF/docx/xlsx text)
// lands once attachment_text.py + email_attachment_fts are in place.
// Reading raw attachment bytes via tool intentionally NOT exposed — they
// can be megabytes and would blow the LLM context. Use the local-path tool
// (M3) instead when the LLM needs to reference a file path.

import type { ToolDef, ToolResult } from '../registry'
import { listAttachments as ipcListAttachments } from '../../../handlers/attachment'

export const attachmentList: ToolDef = {
  name: 'attachment_list',
  description:
    'List attachments for an email by internal_id. Returns filename, mime type, ' +
    'size, inline flag, and (when present) the derived-format link (e.g. docx→PDF). ' +
    'Use to discover what files arrived with an email before suggesting actions.',
  inputSchema: {
    type: 'object',
    properties: {
      internal_id: { type: 'integer' }
    },
    required: ['internal_id']
  },
  confirmationTier: 'silent',
  category: 'read',
  surface: 'ipc',
  timeoutMs: 3000,
  handler: async (input, _ctx): Promise<ToolResult> => {
    const start = Date.now()
    const i = (input ?? {}) as Record<string, unknown>
    const id = typeof i.internal_id === 'number' ? Math.floor(i.internal_id) : NaN
    if (Number.isNaN(id) || id < 0) {
      return { ok: false, code: 'E_INVALID_ARG', message: 'internal_id is required (integer)', durationMs: Date.now() - start }
    }
    try {
      const items = ipcListAttachments(id)
      return {
        ok: true,
        output: { count: items.length, items },
        durationMs: Date.now() - start
      }
    } catch (e) {
      return {
        ok: false,
        code: 'E_INTERNAL',
        message: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - start
      }
    }
  }
}

export const allAttachmentTools: ToolDef[] = [attachmentList]
