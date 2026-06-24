// chat-panel P4 Phase 03a — email read tools (AI SDK Gateway).
//
// Six silent read tools migrated from the legacy harness (shared/chat/tools/builtin/
// email.ts + attachment.ts). Each is an AI SDK `tool()` whose execute runs against
// the injected MailAgentDomainClient and applies the SAME output massage as the
// legacy tool (so a parity test sees identical key fields). Descriptions are reused
// VERBATIM from the legacy tools so the model's tool surface is unchanged.
//
// 🔴 No side effects, no needsApproval (silent tier) — read-only.

import type { Tool } from 'ai'

// buildSearchHint is the legacy fulltext teaching-hint (Phase A G-A2) — reuse it
// verbatim for parity (pure shared helper, no Electron dep). RELATIVE import (not the
// @shared alias) so the pure-Node poc harness (tsx, which doesn't resolve tsconfig
// paths for runtime imports) can load the gateway tools; vite/vitest/tsc resolve it
// identically.
import { buildSearchHint } from '../../shared/chat/tools/builtin/email'

import type { z } from 'zod'

import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import {
  emailBodySchema,
  emailGetSchema,
  emailListThreadSchema,
  emailSearchAttachmentsSchema,
  emailSearchFulltextSchema,
  emailSearchSchema
} from './schemas'

const BODY_MAX_CHARS = 12000

/** Build the six email read tools bound to the injected domain client + audit
 *  collector. Each tool pushes a chat_tool_call audit entry into `collector` (the
 *  gateway creates one per request and drains it in onFinish). */
export function createEmailReadTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = []
): Record<string, Tool> {
  // bind every tool's audit to this request's collector (generic — preserves the
  // per-tool input typing inferred from each zod inputSchema).
  const make = <I>(opts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    run: (input: I, signal: AbortSignal | undefined) => Promise<unknown>
  }): Tool => auditedReadTool(opts, collector)

  const email_search = make({
    name: 'email_search',
    description:
      'Search emails by subject substring, sender substring, mailbox, date range, or flag state. ' +
      'Returns matching internal_id + subject + sender + date + flags. ' +
      'Use when the user asks "find emails from X" / "show last week\'s mail about Y" / ' +
      '"list flagged emails since DATE". Does NOT search email body — use email_search_fulltext for that.',
    inputSchema: emailSearchSchema,
    run: async (input, signal) => {
      const items = await domain.searchEmails(
        {
          subject: input.subject_contains,
          fromAddr: input.sender_contains,
          mailbox: input.mailbox,
          sinceDate: input.since,
          untilDate: input.until,
          isRead: input.is_read,
          isFlagged: input.is_flagged,
          limit: input.limit
        },
        signal
      )
      return { count: items.length, items }
    }
  })

  const email_search_fulltext = make({
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
    inputSchema: emailSearchFulltextSchema,
    run: async (input, signal) => {
      const result = await domain.searchEmailsFulltext(
        {
          query: input.query,
          mailbox: input.mailbox,
          since: input.since,
          until: input.until,
          limit: input.limit
        },
        signal
      )
      // Phase A G-A2 agent-facing projection — mirror legacy email_search_fulltext.
      const items = result.items ?? []
      const totalMatches = result.total_matches ?? items.length
      const hasMore = result.has_more ?? false
      return {
        items,
        total_matches: totalMatches,
        has_more: hasMore,
        hint: buildSearchHint(items.length, hasMore),
        transformed_query: result.transformed_query,
        parse_warnings: result.parse_warnings,
        mode: result.mode
      }
    }
  })

  const email_get = make({
    name: 'email_get',
    description:
      'Fetch metadata + attachment summary for a single email by internal_id. ' +
      'Returns subject, sender, date, mailbox, flags, thread_id, has_attachments, ' +
      'and a list of attachment names. ' +
      'Does NOT include the body — call email_body for that.',
    inputSchema: emailGetSchema,
    run: async (input, signal) => {
      const row = await domain.getEmail(input.internal_id, signal)
      if (!row) throw new DomainError('E_NOT_FOUND', `email ${input.internal_id} not found`)
      return row
    }
  })

  const email_body = make({
    name: 'email_body',
    description:
      'Read the markdown body of a single email. Capped at 12000 characters; ' +
      'longer bodies are truncated and a `…[truncated]` marker is appended. ' +
      'Use after email_search / email_get when you need the actual content.',
    inputSchema: emailBodySchema,
    run: async (input, signal) => {
      const data = await domain.getEmailBody(input.internal_id, signal)
      if (!data)
        throw new DomainError('E_NOT_FOUND', `body for email ${input.internal_id} not found`)
      const cap = input.max_chars ?? BODY_MAX_CHARS
      const content = data.content ?? ''
      // Same truncation as legacy email_body: append the marker so the model sees it.
      const out = content.length > cap ? content.slice(0, cap) + '\n\n…[truncated]' : content
      return {
        internal_id: data.internal_id,
        content: out,
        size_bytes: data.size_bytes,
        fetched_at: data.fetched_at,
        fetched_source: data.fetched_source,
        format: 'markdown'
      }
    }
  })

  const email_list_thread = make({
    name: 'email_list_thread',
    description:
      'List every email in the same conversation thread by thread_id, ordered oldest-first. ' +
      'Returns the same metadata shape as email_search items. ' +
      'thread_id is usually pulled from a prior email_get / email_search result.',
    inputSchema: emailListThreadSchema,
    run: async (input, signal) => {
      const items = await domain.listEmailsByThread(input.thread_id, signal)
      return { count: items.length, items }
    }
  })

  const email_search_attachments = make({
    name: 'email_search_attachments',
    description:
      'Full-text search across extracted text from email attachments (PDF, docx, ' +
      'pptx, xlsx). Pass natural-language keywords like "合同条款" or "redis ' +
      'configuration" — CJK queries are auto-expanded (smart mode). ' +
      'Returns ranked hits with attachment_id + filename + email context ' +
      '(subject/sender/date) + snippet (bm25, smaller = more relevant). Only ' +
      'covers attachments whose text has been extracted.',
    inputSchema: emailSearchAttachmentsSchema,
    run: async (input, signal) => {
      return domain.searchAttachments(
        {
          query: input.query,
          mailbox: input.mailbox,
          since: input.since,
          until: input.until,
          limit: input.limit
        },
        signal
      )
    }
  })

  return {
    email_search,
    email_search_fulltext,
    email_get,
    email_body,
    email_list_thread,
    email_search_attachments
  }
}
