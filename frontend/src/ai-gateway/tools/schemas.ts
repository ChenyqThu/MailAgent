// chat-panel P4 Phase 03a — zod input schemas for the AI SDK Gateway read tools.
//
// One zod schema per migrated read tool, mirroring the legacy JSON-Schema field
// names / constraints / defaults (shared/chat/tools/builtin/{email,attachment,kos,
// report}.ts) byte-for-byte so the model sees the same tool surface and the parity
// tests can drive both implementations from the SAME input fixtures. Exported so the
// parity tests import the canonical schemas rather than re-declaring them.
//
// 🔴 Tool-facing field names (snake_case, model-visible) — these are the LEGACY tool
//    param names, NOT the serve-api wire names. The domain client maps them to the
//    (inconsistent) wire params; see python/domainClient.ts.

import { z } from 'zod'

/** email_search — metadata filter (subject/sender/date/flags). All optional. */
export const emailSearchSchema = z.object({
  subject_contains: z.string().optional(),
  sender_contains: z.string().optional(),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  is_read: z.boolean().optional(),
  is_flagged: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type EmailSearchInput = z.infer<typeof emailSearchSchema>

/** email_search_fulltext — FTS body search (query required). */
export const emailSearchFulltextSchema = z.object({
  query: z.string().min(1),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type EmailSearchFulltextInput = z.infer<typeof emailSearchFulltextSchema>

/** email_get — single email metadata. */
export const emailGetSchema = z.object({
  internal_id: z.number().int()
})
export type EmailGetInput = z.infer<typeof emailGetSchema>

/** email_body — markdown body (capped). */
export const emailBodySchema = z.object({
  internal_id: z.number().int(),
  max_chars: z.number().int().min(200).max(12000).default(12000)
})
export type EmailBodyInput = z.infer<typeof emailBodySchema>

/** email_list_thread — all emails in a thread. */
export const emailListThreadSchema = z.object({
  thread_id: z.string().min(1)
})
export type EmailListThreadInput = z.infer<typeof emailListThreadSchema>

/** email_search_attachments — FTS over extracted attachment text (query required). */
export const emailSearchAttachmentsSchema = z.object({
  query: z.string().min(1),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type EmailSearchAttachmentsInput = z.infer<typeof emailSearchAttachmentsSchema>

/** kos_query — cross-domain KOS retrieval. */
export const kosQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).default(10),
  expand: z.boolean().default(false),
  source_id: z.string().optional()
})
export type KosQueryInput = z.infer<typeof kosQuerySchema>

/** report_list — generated reports (all filters optional). */
export const reportListSchema = z.object({
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
  agent_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type ReportListInput = z.infer<typeof reportListSchema>

/** report_get — one report by id. */
export const reportGetSchema = z.object({
  report_id: z.string().min(1)
})
export type ReportGetInput = z.infer<typeof reportGetSchema>

// ── write-tool schemas (Phase 03b) — mirror the legacy JSON-Schema field names /
//    requireds from shared/chat/tools/builtin/write.ts byte-for-byte (parity). The
//    "at least one of …" semantic checks stay in the tool's run (matching the legacy
//    handler's E_INVALID_ARG), not the schema, so the error shape matches legacy. ──

/** email_flag — toggle is_read / is_flagged / processing_status (≥1 enforced in run). */
export const emailFlagSchema = z.object({
  internal_id: z.number().int(),
  is_read: z.boolean().optional(),
  is_flagged: z.boolean().optional(),
  processing_status: z.string().optional()
})
export type EmailFlagInput = z.infer<typeof emailFlagSchema>

/** email_archive — move into Archive (davmail-only). */
export const emailArchiveSchema = z.object({
  internal_id: z.number().int()
})
export type EmailArchiveInput = z.infer<typeof emailArchiveSchema>

/** email_pin — pin / unpin (local UI flag). */
export const emailPinSchema = z.object({
  internal_id: z.number().int(),
  pinned: z.boolean()
})
export type EmailPinInput = z.infer<typeof emailPinSchema>

/** email_draft_reply — compose a reply-all draft. */
export const emailDraftReplySchema = z.object({
  internal_id: z.number().int(),
  body_markdown: z.string().min(1)
})
export type EmailDraftReplyInput = z.infer<typeof emailDraftReplySchema>

/** email_resync — re-push to Notion from the SQLite SSoT. */
export const emailResyncSchema = z.object({
  internal_id: z.number().int()
})
export type EmailResyncInput = z.infer<typeof emailResyncSchema>
