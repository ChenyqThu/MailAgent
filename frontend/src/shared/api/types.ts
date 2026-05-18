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

// ---- Sprint 5 §2.2 — write surfaces ---------------------------------------

export interface CreateDraftOpts {
  internalId: number
  /** Optional plaintext body to prepend above the quoted source.
   *  Sprint 5 keeps it plaintext; Sprint 6 HTML clipboard ramp adds rich text. */
  body?: string
}

export interface CreateDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  /** AppleScript-returned draft message id. */
  draftId: string
}

export interface LlmRunOpts {
  dryRun?: boolean
  /** Overwrite existing AI fields. Without this the CLI no-ops when labels exist. */
  force?: boolean
  /** Preserve user-edited non-null fields when force=true. */
  noOverwrite?: boolean
}

export interface UpdateFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  /** Notion DB enum: 未处理 / AI Reviewed / 已同步 / 已完成 / 草稿已创建. */
  processingStatus?: string
  dryRun?: boolean
}

export interface EmailApi {
  list(opts: ListOpts): Promise<EmailMeta[]>
  /** Sprint 2 — list + body snippet + LLM labels + attach count, all in one IPC. */
  listEnriched(opts: ListOpts): Promise<EnrichedEmailMeta[]>
  /** Sprint 2 — sidebar mailbox totals + unread counts. */
  listMailboxes(): Promise<MailboxSummary[]>
  /** Sprint 3 — sibling emails of a thread, ascending by date. Empty list
   *  for unknown/empty threadId so the Thread sidebar can blanket-handle. */
  listByThread(threadId: string | null): Promise<EmailMeta[]>
  get(internalId: number): Promise<EmailDetail | null>
  body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null>
  /** Sprint 2 — joined LLM labels + processing_status for <AIFieldsBlock>. */
  aiFields(internalId: number): Promise<AIFields | null>
  search(opts: SearchOpts): Promise<SearchHit[]>
  /** Sprint 5 — Notion resync via `mailagent email resync`. Returns whatever
   *  the CLI's `data` envelope contains (page_id, status, etc.). */
  resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult>
  /** Sprint 5 — open Mail.app reply window (AppleScript). User edits +
   *  sends in Mail.app; we don't relay the send. */
  createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult>
}

export interface LlmApi {
  /** Sprint 5 — re-run AI classification for one email via `mailagent llm run`. */
  run(internalId: number, opts?: LlmRunOpts): Promise<unknown>
}

export interface NotionWriteApi {
  /** Sprint 5 — push read/flagged/processing_status to the Notion mail page. */
  updateFlag(internalId: number, opts: UpdateFlagOpts): Promise<unknown>
}

export interface AttachmentApi {
  list(internalId: number): Promise<AttachmentMeta[]>
  /** Returns a `file://`-safe local absolute path, or null if the attachment
   *  hasn't been persisted to disk (e.g. inline images that live only in MIME). */
  localPath(attachmentId: number): Promise<string | null>
}

// ---- Sprint 3 §2.2 — AI / translation surface ------------------------------

export type TargetLang = 'zh' | 'en'

export interface TranslationResult {
  internalId: number
  targetLang: TargetLang
  translated: string
  model: string
  latencyMs: number
}

export interface AiApi {
  /**
   * Translate `email_body.body_markdown` of `internalId` to `targetLang`
   * (default 'zh'). Runs in main process; API key + endpoint stay there
   * (REVIEW-LOG C-04). Errors carry a `code` property: E_NO_BODY /
   * E_NO_LLM_KEY / E_UPSTREAM / E_ABORTED / E_EMPTY_RESPONSE / E_INVALID_ARG.
   */
  translate(internalId: number, targetLang?: TargetLang): Promise<TranslationResult>
  /** Abort an in-flight translation by internalId. Renderer fires this when
   *  switching emails so the stale request doesn't pollute the new view. */
  abortTranslate(internalId: number): void
}

// ---- Sprint 4 §2.1 — AI Chat surface ------------------------------------
//
// These types mirror the main-process `chat_db.ts` + `chat/types.ts`
// shapes. They are duplicated (not imported) because the renderer must
// not import from `src/electron/main/**` — that would pull in
// better-sqlite3 + node:fs into the browser bundle. The IPC boundary is
// the seam; types align by hand and are guarded by the schema-ish unit
// tests in `tests/main/chat_db.test.ts` + `tests/components/useEmailChat.test.tsx`.

export type ChatBackendKind = 'notion-agent' | 'custom-api'
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type ChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'aborted'

export interface ChatMessage {
  id: number
  session_id: number
  role: ChatMessageRole
  content: string
  tokens_input: number | null
  tokens_output: number | null
  cost_usd: number | null
  model: string | null
  status: ChatMessageStatus
  error_message: string | null
  /** JSON-encoded backend-specific extras (e.g. notion_agent thread_id).
   *  Renderer treats it as opaque — only the backend that wrote it knows
   *  how to read it. See ai_chat.db schema_version 2 (Sprint 4 opus L). */
  metadata: string | null
  created_at: number
  updated_at: number
}

export interface ChatSession {
  id: number
  email_id: number
  backend_kind: ChatBackendKind
  backend_model: string | null
  backend_agent_page_id: string | null
  created_at: number
  updated_at: number
}

export interface ChatChunkEvent {
  type: 'chunk'
  delta: string
}
export interface ChatToolCallEvent {
  type: 'tool_call'
  name: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  detail?: string
}
export interface ChatUsageEvent {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  model: string | null
  metadata?: Record<string, unknown> | null
}
export interface ChatDoneEvent {
  type: 'done'
  finalContent: string
  model: string | null
  metadata?: Record<string, unknown> | null
}
export interface ChatErrorEvent {
  type: 'error'
  code: string
  message: string
}

export type ChatStreamEvent =
  | ChatChunkEvent
  | ChatToolCallEvent
  | ChatUsageEvent
  | ChatDoneEvent
  | ChatErrorEvent

export interface ChatStreamEnvelope {
  sessionId: number
  messageId: number
  event: ChatStreamEvent
}

export interface ChatStartOpts {
  emailId: number
  message: string
  backendKind: ChatBackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
}

export interface ChatStartResult {
  sessionId: number
  userMessageId: number
  assistantMessageId: number
}

export interface ChatApi {
  /**
   * Open or reuse the (emailId, backendKind, agentPageId) session, append
   * the user message, kick the backend stream, and return ids the
   * renderer needs to render an empty assistant bubble. Throws
   * `Error & { code }` on dispatch failure (E_INVALID_ARG /
   * E_BACKEND_UNAVAILABLE / E_DISPATCH).
   */
  start(opts: ChatStartOpts): Promise<ChatStartResult>
  /** Fire-and-forget renderer-side cancel. Safe to call when nothing is
   *  in flight. */
  abort(sessionId: number): void
  listMessages(sessionId: number): Promise<ChatMessage[]>
  listSessions(emailId: number): Promise<ChatSession[]>
  /** Subscribe to backend stream events. Returns an unsubscribe function. */
  onStream(handler: (envelope: ChatStreamEnvelope) => void): () => void
}

export interface MailApi {
  email: EmailApi
  attachment: AttachmentApi
  ai: AiApi
  chat: ChatApi
  llm: LlmApi
  notion: NotionWriteApi
}
