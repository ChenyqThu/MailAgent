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

// ── high-risk outbound send schema (Phase 04b) — the ONLY tool that triggers a real SMTP
//    send, and only after a blocking SendApprovalCard + the double guard (content hash +
//    idempotency, gateway + Python). Field names are the model-visible (snake_case) surface;
//    the domain client maps them to the serve-api /email/send-approved wire body. ────────────

/** email_prepare_send — propose a real outbound email for human approval. Recipients are
 *  explicit (a fresh "new" compose — it does NOT derive recipients from a source email).
 *  internal_id is optional context only (audit / which email this relates to); the send uses
 *  the explicit to/cc/bcc/subject/body. Attachments are NOT supported in v1 (the model cannot
 *  pass bytes; a future phase may reference existing attachments by id). */
export const emailPrepareSendSchema = z.object({
  to: z.array(z.string().min(3)).min(1),
  cc: z.array(z.string().min(3)).optional(),
  bcc: z.array(z.string().min(3)).optional(),
  subject: z.string().min(1),
  body_markdown: z.string().min(1),
  internal_id: z.number().int().optional()
})
export type EmailPrepareSendInput = z.infer<typeof emailPrepareSendSchema>

// ── memory-tool schemas (M0) — mirror the legacy JSON-Schema field names / requireds from
//    shared/chat/tools/builtin/memory.ts byte-for-byte (parity). memory_list/get are silent
//    reads; memory_write/delete are preview writes. The default scope='user' resolution stays
//    in the tool's run (matching the legacy handler), NOT the schema, so scope is `.optional()`
//    here — the model may omit it. ────────────────────────────────────────────────────────

/** memory_list — list durable memory entries (optional scope filter). */
export const memoryListSchema = z.object({
  scope: z.string().optional()
})
export type MemoryListInput = z.infer<typeof memoryListSchema>

/** memory_get — fetch one entry by scope + key (scope defaults to 'user' in run). */
export const memoryGetSchema = z.object({
  scope: z.string().optional(),
  key: z.string()
})
export type MemoryGetInput = z.infer<typeof memoryGetSchema>

/** memory_write — save / overwrite a durable fact. `value` is an arbitrary JSON value
 *  (string or object); priority is an optional user-explicit importance boost. */
export const memoryWriteSchema = z.object({
  scope: z.string().optional(),
  key: z.string(),
  value: z.unknown(),
  priority: z.number().int().optional()
})
export type MemoryWriteInput = z.infer<typeof memoryWriteSchema>

/** memory_delete — forget one entry by scope + key (scope defaults to 'user' in run). */
export const memoryDeleteSchema = z.object({
  scope: z.string().optional(),
  key: z.string()
})
export type MemoryDeleteInput = z.infer<typeof memoryDeleteSchema>

// ── self-mount schemas (M4) — the agent updates its own Standing Context docs + skills. Behind
//    MAILAGENT_SKILL_SELF_MOUNT. update_system_md = edit-tier write (always asks); set_skill_enabled
//    = preview-tier write; discover_skills = silent read. Field names are the model-visible surface. ──

/** update_system_md (M4b) — propose new full content for one Standing Context doc. doc_name is the
 *  fixed backend enum (PROFILE_DOC_NAMES); rules content is additionally validated server-side
 *  (jailbreak / safety-override deny-list → E_INVALID_ARG). */
export const updateSystemMdSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user']),
  content: z.string().min(1)
})
export type UpdateSystemMdInput = z.infer<typeof updateSystemMdSchema>

/** discover_skills (M4c) — list capabilities (enabled + unavailable, with reasons). No input. */
export const discoverSkillsSchema = z.object({})
export type DiscoverSkillsInput = z.infer<typeof discoverSkillsSchema>

/** set_skill_enabled (M4c) — enable/disable a skill (mount/unmount its tools). */
export const setSkillEnabledSchema = z.object({
  skill_name: z.string().min(1),
  enabled: z.boolean()
})
export type SetSkillEnabledInput = z.infer<typeof setSkillEnabledSchema>
