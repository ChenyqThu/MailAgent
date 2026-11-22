// Email read and write tool zod input schemas.
import { z } from 'zod'

/** email_list_filter — metadata filter (subject/sender/date/flags). All optional. */
export const emailSearchSchema = z.object({
  subject_contains: z.string().optional(),
  sender_contains: z.string().optional(),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  is_read: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      'Omit or null = all read states; false = unread only; true = read only. Filter only when the user requests it.'
    ),
  is_flagged: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      'Omit or null = all flag states; false = unflagged only; true = flagged only. Filter only when the user requests it.'
    ),
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

/** email_thread_attachments — every attachment across a thread (metadata + provenance). Mirrors
 *  email_list_thread's single thread_id input. */
export const emailThreadAttachmentsSchema = z.object({
  thread_id: z.string().min(1)
})
export type EmailThreadAttachmentsInput = z.infer<typeof emailThreadAttachmentsSchema>

/** email_attachment_text — one page of an attachment's extracted text (offset + max_chars). */
export const emailAttachmentTextSchema = z.object({
  attachment_id: z.number().int(),
  max_chars: z.number().int().min(200).max(12000).default(12000),
  offset: z.number().int().min(0).default(0)
})
export type EmailAttachmentTextInput = z.infer<typeof emailAttachmentTextSchema>

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

/** email_draft_reply — compose a reply / reply-all draft. Recipients default to
 *  server-derived reply-all; optional to/cc/bcc OVERRIDE the full lists (the way to
 *  add/remove people on top of reply-all — compute the final lists from the source
 *  email's sender/to/cc and pass them explicitly).
 *  Per-field `.describe()` (issue #70) — the JSON Schema is the ONLY part of a schema the model
 *  actually sees, so every rule a caller can get wrong has to be stated on the field itself. */
export const emailDraftReplySchema = z.object({
  internal_id: z.number().int().describe('The email being replied to (its internal_id). Required.'),
  body_markdown: z.string().min(1),
  mode: z.enum(['reply', 'reply-all']).optional(),
  to: z
    .array(z.string().min(3))
    .optional()
    .describe(
      'OVERRIDE of the whole To list (omit to let the server derive reply-all). Not additive: ' +
        'to add or remove one person, compute the FULL final list yourself and pass it.'
    ),
  cc: z
    .array(z.string().min(3))
    .optional()
    .describe('OVERRIDE of the whole Cc list (same all-or-nothing rule as `to`).'),
  bcc: z.array(z.string().min(3)).optional().describe('OVERRIDE of the whole Bcc list.')
})
export type EmailDraftReplyInput = z.infer<typeof emailDraftReplySchema>

/** email_draft_compose (prd 07-27 C-3) — a BRAND-NEW draft (`mode:'new'`) or a forward of an
 *  existing email (`mode:'forward'`). Unlike the "at least one of …" checks that live in `run`,
 *  the cross-field rules sit in `.superRefine` so an impossible combination fails BEFORE the
 *  approval card is shown (showing the user a card for a call that can only error is worse than a
 *  validation retry the model fixes itself):
 *    - forward REQUIRES internal_id (the source email) + at least one recipient (the service
 *      rejects a recipient-less forward too);
 *    - 'new' REJECTS internal_id — a new draft has no source email, so passing one means the
 *      model meant forward (or email_draft_reply).
 *  quote_original is forward-only (a new draft has nothing to quote); default true.
 *
 *  🔴 issue #70 — a `.superRefine` is invisible to the model: `toJSONSchema` drops it, so the
 *  mode↔internal_id coupling reached the model through NOTHING but prose buried mid-description,
 *  and a model that guessed `internal_id` on a 'new' draft repeatedly burned the run guessing
 *  values (0 → -1 → 1.9e15 → 0) for a field that must simply be absent. The rules now live on the
 *  fields themselves via `.describe()` (that IS the model-visible surface) — the superRefine stays
 *  as the pre-approval-card backstop, not as the way the model learns the rule. Every retry message
 *  below therefore also states the corrective ACTION, not just the violated constraint. */
export const emailDraftComposeSchema = z
  .object({
    mode: z
      .enum(['new', 'forward'])
      .describe(
        "'new' = a brand-new draft written from scratch; 'forward' = forward an existing email. " +
          'The two modes take DIFFERENT parameters — see internal_id.'
      ),
    internal_id: z
      .number()
      .int()
      .optional()
      .describe(
        "mode 'forward' ONLY, where it is required: the internal_id of the email being forwarded. " +
          "OMIT THIS FIELD ENTIRELY for mode 'new' — a new draft has no source email, so there is " +
          'no id to pass and no placeholder (0 / -1 / any number) is accepted. To reply to an ' +
          'email, use email_draft_reply instead of guessing an id here.'
      ),
    subject: z
      .string()
      .optional()
      .describe(
        "Subject line. Pass it for mode 'new'; for mode 'forward' it defaults to \"Fwd: <original>\"."
      ),
    body_markdown: z.string().min(1).describe('Draft body, markdown.'),
    to: z.array(z.string().min(3)).describe('Final To list — explicit, never derived. Required.'),
    cc: z.array(z.string().min(3)).optional(),
    bcc: z.array(z.string().min(3)).optional(),
    quote_original: z
      .boolean()
      .optional()
      .describe(
        "mode 'forward' only (default true): quote the forwarded email under your body. A new " +
          'draft has nothing to quote.'
      )
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'forward') {
      if (v.internal_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['internal_id'],
          message:
            "mode 'forward' requires internal_id (the source email to forward). Retry with the " +
            'internal_id of the email you are forwarding.'
        })
      }
      if (v.to.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message:
            "mode 'forward' requires at least one recipient in `to`. Retry with the recipients filled in."
        })
      }
    } else if (v.internal_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['internal_id'],
        message:
          "mode 'new' takes no internal_id (a new draft has no source email — use mode 'forward' to forward one, or email_draft_reply to reply to one). " +
          'Retry with the SAME arguments and the internal_id field REMOVED — do not substitute 0, ' +
          '-1 or any other placeholder value.'
      })
    }
  })
export type EmailDraftComposeInput = z.infer<typeof emailDraftComposeSchema>

/** email_draft_update (prd 07-27 C-4) — edit an EXISTING draft by its internal_id. Every content
 *  field is optional: an omitted field is backfilled from the current draft, so a subject-only
 *  edit keeps the body/recipients as they are. "at least one field must change" is enforced in
 *  `run` (email_flag precedent — the semantic check keeps the legacy E_INVALID_ARG error shape). */
export const emailDraftUpdateSchema = z.object({
  draft_internal_id: z
    .number()
    .int()
    .describe(
      'internal_id of the DRAFT row to edit — not the id of the email it replies to or forwards. ' +
        'To create a draft instead, use email_draft_compose / email_draft_reply.'
    ),
  subject: z.string().optional().describe('Omit to keep the current subject.'),
  body_markdown: z.string().min(1).optional().describe('Omit to keep the current body.'),
  to: z
    .array(z.string().min(3))
    .optional()
    .describe('OVERRIDE of the whole To list; omit to keep the current recipients.'),
  cc: z.array(z.string().min(3)).optional().describe('OVERRIDE of the whole Cc list.'),
  bcc: z.array(z.string().min(3)).optional().describe('OVERRIDE of the whole Bcc list.')
})
export type EmailDraftUpdateInput = z.infer<typeof emailDraftUpdateSchema>

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
