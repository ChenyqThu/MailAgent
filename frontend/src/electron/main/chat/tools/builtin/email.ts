// Sprint 19 PR-1b — Email read tools.
//
// Six silent-tier read tools the LLM uses to discover and inspect mail
// without side effects. Each tool is a thin wrapper around a
// `handlers/email.ts` export function — no SQL or business logic here, just
// shape-massage between Anthropic-style input_schema and the existing IPC
// handler signature.
//
// Why import directly from handlers/email.ts (not via ipcMain.invoke):
//   We're INSIDE the main process. ipcMain.invoke would round-trip the
//   payload through a serialization layer that exists only for the
//   main↔renderer boundary; here it'd be pointless overhead and would
//   require a fake event sender. Sharing the export function is the
//   intended pattern — see how `handlers/admin.ts` reuses `getAIFields`
//   from `handlers/email.ts`.

import type { ToolDef, ToolResult } from '../registry'
import {
  getEmail as ipcGetEmail,
  getEmailBody as ipcGetEmailBody,
  getAIFields as ipcGetAIFields,
  listEmails as ipcListEmails,
  listEmailsByThread as ipcListEmailsByThread,
  searchEmails as ipcSearchEmails
} from '../../../handlers/email'

// ── helpers ────────────────────────────────────────────────────────────

function ok<O>(output: O, start: number, truncated?: boolean): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start, truncated }
}

function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}

function asInt(x: unknown, def: number, min = 1, max = 200): number {
  const n = typeof x === 'number' ? Math.floor(x) : NaN
  if (Number.isNaN(n)) return def
  return Math.min(Math.max(n, min), max)
}

function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}

function asBool(x: unknown): boolean | undefined {
  return typeof x === 'boolean' ? x : undefined
}

// ── 1. email_search — metadata-filter search (subject/sender/date/flags) ────

export const emailSearch: ToolDef = {
  name: 'email_search',
  description:
    'Search emails by subject substring, sender substring, mailbox, date range, or flag state. ' +
    'Returns matching internal_id + subject + sender + date + flags. ' +
    'Use when the user asks "find emails from X" / "show last week\'s mail about Y" / ' +
    '"list flagged emails since DATE". Does NOT search email body — use email_search_fulltext for that.',
  inputSchema: {
    type: 'object',
    properties: {
      subject_contains: { type: 'string', description: 'Case-insensitive substring match on subject.' },
      sender_contains: { type: 'string', description: 'Case-insensitive substring match on sender email or display name.' },
      mailbox: { type: 'string', description: 'Limit to mailbox (e.g. "收件箱", "发件箱"). Omit for all mailboxes.' },
      since: { type: 'string', description: 'ISO date YYYY-MM-DD. Only emails received on or after this date.' },
      until: { type: 'string', description: 'ISO date YYYY-MM-DD. Only emails received on or before this date.' },
      is_read: { type: 'boolean', description: 'Filter by read state.' },
      is_flagged: { type: 'boolean', description: 'Filter by flag (旗标) state.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    },
    required: []
  },
  confirmationTier: 'silent',
  category: 'read',
  surface: 'ipc',
  timeoutMs: 5000,
  handler: async (input, _ctx): Promise<ToolResult> => {
    const start = Date.now()
    const i = (input ?? {}) as Record<string, unknown>
    try {
      const items = ipcListEmails({
        subject: asStr(i.subject_contains),
        fromAddr: asStr(i.sender_contains),
        mailbox: asStr(i.mailbox),
        sinceDate: asStr(i.since),
        untilDate: asStr(i.until),
        isRead: asBool(i.is_read),
        isFlagged: asBool(i.is_flagged),
        limit: asInt(i.limit, 20, 1, 100)
      })
      return ok({ count: items.length, items }, start)
    } catch (e) {
      return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 2. email_get — single email metadata + summary ───────────────────────

export const emailGet: ToolDef = {
  name: 'email_get',
  description:
    'Fetch metadata + attachment summary for a single email by internal_id. ' +
    'Returns subject, sender, date, mailbox, flags, thread_id, has_attachments, ' +
    'and a list of attachment names. ' +
    'Does NOT include the body — call email_body for that.',
  inputSchema: {
    type: 'object',
    properties: {
      internal_id: { type: 'integer', description: 'The email\'s internal_id (SQLite ROWID).' }
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
    const id = asInt(i.internal_id, -1, -1, Number.MAX_SAFE_INTEGER)
    if (id < 0) return err('E_INVALID_ARG', 'internal_id is required (integer)', start)
    try {
      const row = ipcGetEmail(id)
      if (!row) return err('E_NOT_FOUND', `email ${id} not found`, start)
      return ok(row, start)
    } catch (e) {
      return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 3. email_body — markdown body of a single email ──────────────────────

const BODY_MAX_CHARS = 12000

export const emailBody: ToolDef = {
  name: 'email_body',
  description:
    'Read the markdown body of a single email. Capped at 12000 characters; ' +
    'longer bodies are truncated and `truncated: true` is set on the result. ' +
    'Use after email_search / email_get when you need the actual content.',
  inputSchema: {
    type: 'object',
    properties: {
      internal_id: { type: 'integer' },
      max_chars: {
        type: 'integer',
        minimum: 200,
        maximum: 12000,
        default: 12000,
        description: 'Optional shorter cap. Default returns up to 12000 chars.'
      }
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
    const id = asInt(i.internal_id, -1, -1, Number.MAX_SAFE_INTEGER)
    if (id < 0) return err('E_INVALID_ARG', 'internal_id is required (integer)', start)
    const cap = asInt(i.max_chars, BODY_MAX_CHARS, 200, BODY_MAX_CHARS)
    try {
      const data = ipcGetEmailBody(id, 'markdown')
      if (!data) return err('E_NOT_FOUND', `body for email ${id} not found`, start)
      const content = data.content ?? ''
      let truncated = false
      let out = content
      if (content.length > cap) {
        out = content.slice(0, cap) + '\n\n…[truncated]'
        truncated = true
      }
      return ok(
        {
          internal_id: data.internal_id,
          content: out,
          size_bytes: data.size_bytes,
          fetched_at: data.fetched_at,
          fetched_source: data.fetched_source,
          format: 'markdown'
        },
        start,
        truncated
      )
    } catch (e) {
      return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 4. email_list_thread — all emails sharing a thread_id ────────────────

export const emailListThread: ToolDef = {
  name: 'email_list_thread',
  description:
    'List every email in the same conversation thread by thread_id, ordered oldest-first. ' +
    'Returns the same metadata shape as email_search items. ' +
    'thread_id is usually pulled from a prior email_get / email_search result.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: 'The shared thread identifier (typically the root Message-ID).' }
    },
    required: ['thread_id']
  },
  confirmationTier: 'silent',
  category: 'read',
  surface: 'ipc',
  timeoutMs: 3000,
  handler: async (input, _ctx): Promise<ToolResult> => {
    const start = Date.now()
    const i = (input ?? {}) as Record<string, unknown>
    const tid = asStr(i.thread_id)
    if (!tid) return err('E_INVALID_ARG', 'thread_id is required', start)
    try {
      const items = ipcListEmailsByThread(tid)
      return ok({ count: items.length, items }, start)
    } catch (e) {
      return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 5. email_search_fulltext — FTS5 body search ──────────────────────────

export const emailSearchFulltext: ToolDef = {
  name: 'email_search_fulltext',
  description:
    'Full-text search across all synced email bodies (subject + sender + body) ' +
    'using SQLite FTS5. Pass natural-language keywords like "产品评审" or ' +
    '"redis timeout" — they are automatically CJK-aware expanded (smart mode, ' +
    'PR-2a) so Chinese chunked tokens are handled. Also accepts explicit FTS5 ' +
    'syntax: phrases ("team meeting"), boolean (redis AND timeout), prefix ' +
    '(meet*). Returns ranked hits with snippet + sender + date (bm25 rank, ' +
    'smaller = more relevant).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language keywords or FTS5 syntax. Examples: "产品评审" | ' +
          '"redis timeout" | "redis AND timeout" | "meet*" | "\\"team meeting\\"".'
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
  timeoutMs: 6000,
  handler: async (input, _ctx): Promise<ToolResult> => {
    const start = Date.now()
    const i = (input ?? {}) as Record<string, unknown>
    const q = asStr(i.query)
    if (!q) return err('E_INVALID_ARG', 'query is required (non-empty string)', start)
    try {
      // PR-2a: searchEmails 内部默认 smart mode, CJK/自然语言 query 自动改写
      const result = ipcSearchEmails({
        query: q,
        mailbox: asStr(i.mailbox),
        since: asStr(i.since),
        until: asStr(i.until),
        limit: asInt(i.limit, 20, 1, 50)
      })
      return ok(result, start)
    } catch (e) {
      return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
    }
  }
}

// ── 6. email_get_ai_fields — LLM-classified labels for one email ─────────

export const emailGetAiFields: ToolDef = {
  name: 'email_get_ai_fields',
  description:
    'Fetch the AI-classified fields for an email (priority, action, review status, sentiment, ' +
    'raw label blob). Returns null if the LLM classifier has not yet processed the email. ' +
    'Use to check whether an email is already labeled before suggesting a re-classify.',
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
    const id = asInt(i.internal_id, -1, -1, Number.MAX_SAFE_INTEGER)
    if (id < 0) return err('E_INVALID_ARG', 'internal_id is required (integer)', start)
    try {
      const fields = ipcGetAIFields(id)
      if (!fields) {
        return ok({ classified: false, internal_id: id }, start)
      }
      return ok({ classified: true, ...fields }, start)
    } catch (e) {
      return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
    }
  }
}

export const allEmailTools: ToolDef[] = [
  emailSearch,
  emailGet,
  emailBody,
  emailListThread,
  emailSearchFulltext,
  emailGetAiFields
]
