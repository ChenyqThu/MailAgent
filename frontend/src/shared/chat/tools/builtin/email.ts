// V2.1 阶段 3 — 3b-4：Email read tools（从 electron `chat/tools/builtin/email.ts` 下沉 shared）。
//
// Seven silent-tier read tools the LLM uses to discover and inspect mail without
// side effects (incl. email_list_folders, which resolves folder names for email_move).
// 纯逻辑（input 校验 + shape massage + email_body 截断）下沉单一真源；
// 后端原语经注入的 ChatToolPlatform 访问（electron 直调 handlers/email；http fetch
// serve-api）。createEmailTools(platform) 闭包持 toolPlatform，取代 module-global const。

import type { ToolDef, ToolResult } from '../registry'
import type { ChatToolPlatform } from '../../platform'

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

const BODY_MAX_CHARS = 12000

/**
 * Phase A G-A2 — 教学式截断/空结果引导（给搜索 agent 自我收敛用）。
 *
 * 行业最佳实践（Anthropic「writing tools for agents」/ Claude Code）：工具结果绝不静默
 * 截断，要「教 agent 下一步」。空结果引导放宽、溢出引导缩小，并提示用 email_body 精读
 * top 几条确认。bilingual（中文为主用户 + 英文模型都可读）。
 */
export function buildSearchHint(returned: number, hasMore: boolean): string {
  if (returned === 0) {
    return (
      '0 命中：放宽关键词、去掉一个 filter（from:/after:/in: 等）、或换同义词，重试一次；' +
      '仍空则如实回报「没找到」，不要编造。 ' +
      '/ No matches: broaden keywords, drop one filter, or try a synonym and retry once; ' +
      'if still empty, report honestly that nothing was found.'
    )
  }
  if (hasMore) {
    return (
      `已返回 top ${returned} 条，还有更多命中：用 from:/after:/before:/subject:/in: 等 ` +
      'filter 缩小范围，或用 email_body 读 top 几条正文确认相关性后再 present_results。 ' +
      `/ Returned the top ${returned}; more matches exist — narrow with filters or open the ` +
      'top results via email_body to confirm before present_results.'
    )
  }
  return (
    `本次查询共 ${returned} 条，已全部返回。 ` +
    `/ All ${returned} match(es) for this query were returned.`
  )
}

/** Build the 7 email read tools bound to the injected platform. */
export function createEmailTools(platform: ChatToolPlatform): ToolDef[] {
  // ── 1. email_search — metadata-filter search (subject/sender/date/flags) ──
  const emailSearch: ToolDef = {
    name: 'email_search',
    description:
      'Search emails by subject substring, sender substring, mailbox, date range, or flag state. ' +
      'Returns matching internal_id + subject + sender + date + flags. ' +
      'Use when the user asks "find emails from X" / "show last week\'s mail about Y" / ' +
      '"list flagged emails since DATE". Does NOT search email body — use email_search_fulltext for that.',
    inputSchema: {
      type: 'object',
      properties: {
        subject_contains: {
          type: 'string',
          description: 'Case-insensitive substring match on subject.'
        },
        sender_contains: {
          type: 'string',
          description: 'Case-insensitive substring match on sender email or display name.'
        },
        mailbox: {
          type: 'string',
          description: 'Limit to mailbox (e.g. "收件箱", "发件箱"). Omit for all mailboxes.'
        },
        since: {
          type: 'string',
          description: 'ISO date YYYY-MM-DD. Only emails received on or after this date.'
        },
        until: {
          type: 'string',
          description: 'ISO date YYYY-MM-DD. Only emails received on or before this date.'
        },
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
        const items = await platform.listEmails({
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

  // ── 2. email_get — single email metadata + summary ──────────────────────
  const emailGet: ToolDef = {
    name: 'email_get',
    description:
      'Fetch metadata + attachment summary for a single email by internal_id. ' +
      'Returns subject, sender, date, mailbox, flags, thread_id, has_attachments, ' +
      'and a list of attachment names. ' +
      'Does NOT include the body — call email_body for that.',
    inputSchema: {
      type: 'object',
      properties: {
        internal_id: { type: 'integer', description: "The email's internal_id (SQLite ROWID)." }
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
        const row = await platform.getEmail(id)
        if (!row) return err('E_NOT_FOUND', `email ${id} not found`, start)
        return ok(row, start)
      } catch (e) {
        return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 3. email_body — markdown body of a single email ─────────────────────
  const emailBody: ToolDef = {
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
        const data = await platform.getEmailBody(id)
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

  // ── 4. email_list_thread — all emails sharing a thread_id ───────────────
  const emailListThread: ToolDef = {
    name: 'email_list_thread',
    description:
      'List every email in the same conversation thread by thread_id, ordered oldest-first. ' +
      'Returns the same metadata shape as email_search items. ' +
      'thread_id is usually pulled from a prior email_get / email_search result.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'The shared thread identifier (typically the root Message-ID).'
        }
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
        const items = await platform.listEmailsByThread(tid)
        return ok({ count: items.length, items }, start)
      } catch (e) {
        return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 5. email_search_fulltext — FTS5 body search ─────────────────────────
  const emailSearchFulltext: ToolDef = {
    name: 'email_search_fulltext',
    description:
      'Full-text search across all synced email bodies (subject + sender + body) ' +
      'using SQLite FTS5 plus Search Query DSL. Mix plain keywords with filters ' +
      'like from:, to:, subject:, in:, after:, before:, date:, newer_than:, ' +
      'is:unread|flagged, has:attachment, priority:urgent. Supports quoted ' +
      'phrases, token-level -negation, uppercase OR, and natural CJK expansion. ' +
      'Examples: from:alice redis; 产品评审 has:attachment newer_than:7d; ' +
      'subject:"weekly report" -from:noreply. Returns ranked hits with snippet + ' +
      'sender + date (bm25 rank, smaller = more relevant).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords or Search Query DSL. Fields: from:/to:/subject:/in:/after:/' +
            'before:/date:/newer_than:/is:unread|flagged/has:attachment/' +
            'priority:urgent. Use quotes for phrases, -term to exclude, uppercase ' +
            'OR for alternatives. Examples: "from:alice redis"; ' +
            '"产品评审 has:attachment newer_than:7d"; ' +
            '"subject:\\"weekly report\\" -from:noreply".'
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
        // PR-2a: searchEmailsFulltext 内部默认 smart mode, CJK/自然语言 query 自动改写
        const result = await platform.searchEmailsFulltext({
          query: q,
          mailbox: asStr(i.mailbox),
          since: asStr(i.since),
          until: asStr(i.until),
          limit: asInt(i.limit, 20, 1, 50)
        })
        // Phase A G-A2: agent-facing 投影 —— 用「本次命中数 total_matches + has_more +
        // 教学 hint」取代误导的 total_indexed（语料总量）。items 保留完整 SearchHit（候选池
        // 防幻觉交集 + UI 渲染都靠它），仅在 result 元信息层收敛。
        const items = result.items ?? []
        const totalMatches = result.total_matches ?? items.length
        const hasMore = result.has_more ?? false
        return ok(
          {
            items,
            total_matches: totalMatches,
            has_more: hasMore,
            hint: buildSearchHint(items.length, hasMore),
            transformed_query: result.transformed_query,
            parse_warnings: result.parse_warnings,
            mode: result.mode
          },
          start
        )
      } catch (e) {
        return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 6. email_get_ai_fields — LLM-classified labels for one email ────────
  const emailGetAiFields: ToolDef = {
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
        const fields = await platform.getAiFields(id)
        if (!fields) {
          return ok({ classified: false, internal_id: id }, start)
        }
        return ok({ classified: true, ...fields }, start)
      } catch (e) {
        return err('E_INTERNAL', e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 7. email_list_folders — list mailbox folders (for email_move) ───────
  const emailListFolders: ToolDef = {
    name: 'email_list_folders',
    description:
      'List the available mailbox folders, each with its raw imap_name and human display_name. ' +
      'Call this BEFORE email_move to resolve a folder the user named ("move it to 项目" / "file ' +
      'under Archive") into the exact imap_name email_move needs — custom / non-ASCII folder names ' +
      'are encoded (modified-UTF7) and cannot be guessed. Returns special_use (Archive/Sent/…) and ' +
      'is_synced per folder. davmail-only: returns an error on the AppleScript backend.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    // IMAP LIST round-trip via serve-api (counts disabled) — wider than a pure SQLite read.
    timeoutMs: 10_000,
    handler: async (_input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      try {
        const folders = await platform.listFolders()
        return ok({ count: folders.length, folders }, start)
      } catch (e) {
        // davmail-only / IMAP unreachable → surface the error so the LLM knows
        // move-by-folder isn't available on this backend (don't fabricate names).
        const code = (e as { code?: string }).code ?? 'E_INTERNAL'
        return err(code, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  return [
    emailSearch,
    emailGet,
    emailBody,
    emailListThread,
    emailSearchFulltext,
    emailGetAiFields,
    emailListFolders
  ]
}
