// MailApi data-layer abstraction. All React components consume this through
// useMailApi(); the Electron build resolves to ElectronApi (IPC + better-sqlite3),
// the Web build (V2) to HttpApi (fetch + Cloudflare Access). See ARCHITECTURE.md §2.2.
//
// The concrete shapes are pulled from the schema codegen output (REVIEW-LOG C-03):
// shared/types/cli.gen.ts is regenerated from docs/cli-schema/*.schema.json via
// `pnpm gen:types`. When the backend bumps a schema, the unit tests in
// Sprint 1.8 fail loudly via ajv against the same source-of-truth.
//
// Sub-types in cli.gen.ts are prefixed (`EmailList_EmailListItem` etc.) to
// avoid cross-schema name collisions — we re-export the friendly aliases here
// so components write `EmailMeta` instead of the schema-slug verbosity.

import type {
  EmailList_EmailListItem,
  EmailGet_EmailRecord,
  EmailSearch_SearchHit,
  AttachmentList_AttachmentItem,
  MailagentEmailBody,
  MailagentEmailResync
} from '@shared/types/cli.gen'

export type EmailMeta = EmailList_EmailListItem
export type EmailDetail = EmailGet_EmailRecord
export type EmailBody = NonNullable<MailagentEmailBody['data']>
export type SearchHit = EmailSearch_SearchHit
export type AttachmentMeta = AttachmentList_AttachmentItem
export type ResyncResult = MailagentEmailResync['data']

// ---- Sprint 2 frontend-only enriched views ---------------------------------
//
// These three views (listEnriched / listMailboxes / aiFields) are joined by
// the Electron main handlers from `email_metadata` + `email_body` (snippet) +
// `llm_processing.labels_json` (AI fields). They deliberately live OUTSIDE
// `cli.gen.ts` — the backend CLI doesn't return them and the schema-
// conformance tests treat `cli.gen.ts` as the boundary anchor (REVIEW-LOG
// C-03). Both the renderer (`shared/api/ElectronApi.ts`) and the handler
// (`electron/main/handlers/email.ts`) import these names from here so the
// type stays single-source.

/** DESIGN.md §2.3 / §5.2 — 5-tier priority enum used by <AIBadge> variant. */
export type AIPriority = 'critical' | 'urgent' | 'important' | 'normal' | 'low'

export interface EnrichedEmailMeta extends EmailList_EmailListItem {
  /** First ~100 chars of `email_body.body_markdown`; null if body row missing. */
  snippet: string | null
  /** ISO 2-letter from `labels_json.language`. `'unknown'` if LLM hasn't seen it. */
  lang: 'zh' | 'en' | 'unknown'
  /** Mapped from `labels_json.priority` (emoji-Chinese) to the 5-slug enum. */
  ai_priority: AIPriority | null
  /** `labels_json.action_type` — Chinese label passed through verbatim for the chip. */
  ai_action: string | null
  /** User-visible attachment count: excludes inline-only images. Includes derived (docx→pdf). */
  attach_count: number
}

export interface MailboxSummary {
  /** NULL-mailbox rows are excluded from this list. */
  mailbox: string
  total: number
  /** Sum of `is_read = 0`. Production data may show all-zero — real-world signal, not a bug. */
  unread: number
}

export interface AIFields {
  internal_id: number
  processing_status: string | null
  /** Duplicated from email_metadata for one-shot rendering convenience. */
  mailbox: string | null
  is_read: boolean
  is_flagged: boolean
  ai_priority: AIPriority | null
  ai_action: string | null
  /** Mapped from `llm_processing.status`. Null if no llm_processing row exists. */
  ai_review_status: 'pending' | 'reviewed' | null
  /** Passthrough from `labels_json.sentiment` — agent does not emit yet (REVIEW-LOG H-14 follow-up). */
  sentiment: string | null
  /** Raw labels blob for Sprint 4 AI Chat context / V1.5 debug. Null if no LLM run. */
  labels_raw: Record<string, unknown> | null
}

export interface ListOpts {
  mailbox?: string
  status?: string
  sinceDate?: string
  untilDate?: string
  fromAddr?: string
  subject?: string
  isRead?: boolean
  isFlagged?: boolean
  hasNotion?: boolean
  limit?: number
  offset?: number
}

export interface BodyOpts {
  format?: 'markdown' | 'html' | 'raw'
}

export interface SearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
}

export interface ResyncOpts {
  replaceExisting?: boolean
  skipParentLookup?: boolean
  dryRun?: boolean
}

export interface EmailApi {
  list(opts: ListOpts): Promise<EmailMeta[]>
  /** Sprint 2 — list + body snippet + LLM labels + attach count, all in one IPC. */
  listEnriched(opts: ListOpts): Promise<EnrichedEmailMeta[]>
  /** Sprint 2 — sidebar mailbox totals + unread counts. */
  listMailboxes(): Promise<MailboxSummary[]>
  get(internalId: number): Promise<EmailDetail | null>
  body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null>
  /** Sprint 2 — joined LLM labels + processing_status for <AIFieldsBlock>. */
  aiFields(internalId: number): Promise<AIFields | null>
  search(opts: SearchOpts): Promise<SearchHit[]>
  resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult>
}

export interface AttachmentApi {
  list(internalId: number): Promise<AttachmentMeta[]>
  /** Returns a `file://`-safe local absolute path, or null if the attachment
   *  hasn't been persisted to disk (e.g. inline images that live only in MIME). */
  localPath(attachmentId: number): Promise<string | null>
}

export interface MailApi {
  email: EmailApi
  attachment: AttachmentApi
}
