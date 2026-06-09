// V2.1 阶段 3 — 3b-4：Attachment read tools（从 electron `chat/tools/builtin/attachment.ts`
// 下沉 shared）。
//
// `attachment_list` (metadata: filename / mime / size) + `email_search_attachments`
// (FTS5 over extracted PDF / docx / pptx / xlsx text). Smart mode (default) reuses
// PR-2a CJK-aware wrapper（在后端原语侧）. 后端原语经注入的 ChatToolPlatform 访问
// （electron 直调 handlers/attachment；http fetch serve-api `GET /attachment/search`，3b-4 补）。

import type { ToolDef, ToolResult } from '../registry'
import type { ChatToolPlatform } from '../../platform'

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN
  if (Number.isNaN(n)) return dflt
  return Math.min(Math.max(n, min), max)
}

/** Build the 2 attachment tools bound to the injected platform. */
export function createAttachmentTools(platform: ChatToolPlatform): ToolDef[] {
  const attachmentList: ToolDef = {
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
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'internal_id is required (integer)',
          durationMs: Date.now() - start
        }
      }
      try {
        const items = await platform.listAttachments(id)
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

  // ── PR-2b: email_search_attachments — FTS5 over extracted attachment text ──
  const emailSearchAttachments: ToolDef = {
    name: 'email_search_attachments',
    description:
      'Full-text search across extracted text from email attachments (PDF, docx, ' +
      'pptx, xlsx). Pass natural-language keywords like "合同条款" or "redis ' +
      'configuration" — CJK queries are auto-expanded (smart mode, PR-2a). ' +
      'Returns ranked hits with attachment_id + filename + email context ' +
      '(subject/sender/date) + snippet (bm25, smaller = more relevant). Only ' +
      'covers attachments whose text has been extracted (run `mailagent ' +
      'attachment extract --pending` first if results seem sparse).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language keywords or FTS5 syntax. Examples: "合同条款" | ' +
            '"redis timeout" | "redis AND timeout" | "config*".'
        },
        mailbox: { type: 'string', description: 'Limit to mailbox. Omit for all.' },
        since: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
        until: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      },
      required: ['query']
    },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    timeoutMs: 8000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const q = asStr(i.query)
      if (!q) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'query is required (non-empty string)',
          durationMs: Date.now() - start
        }
      }
      try {
        // searchAttachments 默认 smart mode (PR-2b) — CJK 自然语言 query 自动改写
        const result = await platform.searchAttachments({
          query: q,
          mailbox: asStr(i.mailbox),
          since: asStr(i.since),
          until: asStr(i.until),
          limit: asInt(i.limit, 20, 1, 50)
        })
        return {
          ok: true,
          output: result,
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

  return [attachmentList, emailSearchAttachments]
}
