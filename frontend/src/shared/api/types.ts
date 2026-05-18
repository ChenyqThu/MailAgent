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
  /** Excludes `skipped` rows so the count matches what EmailList actually
   *  shows (Sprint 10 user-acceptance follow-up). */
  total: number
  /** Sum of `is_read = 0`. Production data may show all-zero — real-world signal, not a bug. */
  unread: number
  /** Sum of `is_flagged = 1`. Powers the Sidebar "已标旗" virtual entry. */
  flagged: number
  /** Sum of `sync_status IN ('failed', 'dead_letter')`. Powers the
   *  "Failed" filter chip + future Sidebar entry. */
  failed: number
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

// ---- Sprint 6 §2.2 — LLM dashboard surface --------------------------------

export interface LlmStatsData {
  total: number
  by_status: Record<string, number>
  days: number
  since_ts: number
  cost: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    cache_hit_rate_pct: number
    avg_latency_ms: number
    success_rows: number
  }
}

export interface LlmSelfTestData {
  healthy: boolean
  detail?: string
  latency_ms?: number
}

export interface LlmApi {
  /** Sprint 5 — re-run AI classification for one email via `mailagent llm run`. */
  run(internalId: number, opts?: LlmRunOpts): Promise<unknown>
  /** Sprint 6 — aggregate stats for the LLM dashboard (cost / cache hit / latency). */
  stats(days?: number): Promise<LlmStatsData>
  /** Sprint 6 — no-token health probe for the LLM gateway. */
  selftest(): Promise<LlmSelfTestData>
}

// ---- Sprint 6 §2.2 — admin dashboard surface ------------------------------

export interface AdminHealthData {
  db_path: string
  db_accessible: boolean
  db_version: number
  db_version_expected: number
  schema_ok: boolean
  tables_present: string[]
  tables_missing: string[]
  healthy: boolean
}

export interface AdminStatsData {
  watcher?: Record<string, unknown>
  sync_store?: {
    total_emails: number
    by_status: Record<string, number>
    by_mailbox: Record<string, number>
    failure_queue: number
    last_max_row_id: number | null
    last_sync_time: string | null
    db_size_mb: number
    db_size_bytes: number
    _source?: string
  }
  handlers?: Record<string, unknown>
  v4_rollout?: {
    from_sqlite_hit: number
    fallback_miss: number
    fallback_error: number
    route_latency_p99_ms: number
    body_miss_internal_ids: number[]
    window_seconds: number
    _staleness_seconds?: number
    _source?: string
  }
}

export interface DeadLetterItem {
  internal_id: number
  mailbox: string | null
  subject: string | null
  sender: string | null
  date_received: string | null
  retry_count: number
  sync_status: string
  sync_error: string | null
  updated_at: string | null
}

export interface DeadLetterListOpts {
  limit?: number
  mailbox?: string
}

export interface CleanupDeadLetterOpts {
  olderThan?: number
  dryRun?: boolean
}

export interface AdminApi {
  health(): Promise<AdminHealthData>
  stats(): Promise<AdminStatsData>
  deadLetterList(opts?: DeadLetterListOpts): Promise<DeadLetterItem[]>
  /** Re-arms a dead-letter email for retry (write+auth). Throws Error & { code }
   *  on failure exactly like the other write methods. */
  deadLetterRetry(internalId: number): Promise<unknown>
  /** Run the cleanup-deadletter command (write+auth unless dryRun). */
  cleanupDeadLetter(opts?: CleanupDeadLetterOpts): Promise<unknown>
}

// ---- Sprint 6 §2.2 — calendar (recurring meeting) surface -----------------

export interface RecurringInviteItem {
  internal_id: number
  subject: string | null
  organizer: string | null
  rrule: string | null
  notion_page_id: string | null
  first_occurrence: string | null
  last_occurrence: string | null
  occurrence_count: number | null
  date_received: string | null
}

export interface RecurringDiscoverOpts {
  /** ISO date (YYYY-MM-DD). Defaults to CLI's "last 30 days" if omitted. */
  since?: string
}

export interface RecurringReplayOpts {
  internalId?: number
  ids?: number[]
  dryRun?: boolean
}

export interface CalendarExpandOpts {
  horizonWeeks?: number
  dryRun?: boolean
}

export interface CalendarApi {
  recurringDiscover(opts?: RecurringDiscoverOpts): Promise<RecurringInviteItem[]>
  recurringReplay(opts: RecurringReplayOpts): Promise<unknown>
  expand(opts?: CalendarExpandOpts): Promise<unknown>
}

// ---- Sprint 6 §2.2 — SettingsPage surface --------------------------------

export type SecretSlot = 'cliApiKey' | 'llmApiKey' | 'customApiKey'

export interface SecretsStatus {
  cliApiKey: boolean
  llmApiKey: boolean
  customApiKey: boolean
}

export interface PersistentSettings {
  dbPath: string | null
  attachmentDir: string | null
  pollIntervalSec: 5 | 10 | 30 | 0
  notionAgentPageId: string | null
  notionAgentName: string | null
  customApiEndpoint: string | null
}

export interface PingResult {
  ok: boolean
  detail?: string
  code?: string
}

export interface SettingsApi {
  /** Returns booleans only — the secret values never leave keytar. */
  secretsStatus(): Promise<SecretsStatus>
  /** Empty string clears the slot; otherwise stores in keytar. */
  setSecret(slot: SecretSlot, value: string): Promise<SecretsStatus>
  clearSecret(slot: SecretSlot): Promise<SecretsStatus>
  get(): Promise<PersistentSettings>
  set(partial: Partial<PersistentSettings>): Promise<PersistentSettings>
  /** Native folder picker. Returns absolute path or null on cancel. */
  pickFolder(title?: string): Promise<string | null>
  /** Pings the LLM gateway via `mailagent llm selftest`. */
  testLlm(): Promise<PingResult>
  /** Soft check: confirms custom-api-key + endpoint configured. */
  testCustomApi(): Promise<PingResult>
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

// ---- Sprint 9 §2.3 — Island bridge surface --------------------------------
//
// Status state machine mirrors `src/electron/main/island/probe.ts`:
//   idle          → fresh boot, no probe attempted yet (first 100ms)
//   connected     → /tmp/island.sock present + last Ping accepted
//   degraded      → socket present but Ping failed (timeout / parse error)
//   disconnected  → socket file missing (ping-island.app not running)
//   dev-disabled  → `is.dev = true`, auto-probe skipped (Settings can still
//                   trigger `testConnection` manually)
//   disabled      → user toggled the integration off via Settings

export type IslandConnectionState =
  | 'idle'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'dev-disabled'
  | 'disabled'

export interface IslandStatus {
  state: IslandConnectionState
  /** Resolved unix socket path (default `/tmp/island.sock`, overridable via
   *  `ISLAND_SOCKET_PATH` env). Read-only on the renderer. */
  socketPath: string
  /** Epoch ms of the last probe attempt, or null if probe loop hasn't run. */
  lastProbeAt: number | null
  /** Free-form last error from a probe / send attempt. */
  lastError: string | null
}

export interface IslandAppearancePayload {
  accent: string
  theme: 'dark' | 'light'
  lang?: string
}

export interface IslandAIDraftStartPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** Plain-text user prompt; clipped server-side to 240 chars. */
  prompt: string
}

export interface IslandAIDraftStreamPayload {
  emailId: number
  /** Running count of streamed characters (cumulative, monotonic). */
  streamedChars: number
}

export interface IslandAIDraftReadyPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** First ~240 chars of the final draft for the island preview pill. */
  preview: string
}

export interface IslandApi {
  /** Current island connection snapshot. */
  status(): Promise<IslandStatus>
  /** Trigger an immediate probe (fs.existsSync + Ping envelope). Resolves
   *  with the post-probe status. */
  testConnection(): Promise<IslandStatus>
  /** Toggle the integration on/off from Settings. */
  setEnabled(enabled: boolean): Promise<IslandStatus>
  /** Fire-and-forget: theme/accent change → AppearanceChange envelope. */
  appearance(payload: IslandAppearancePayload): void
  /** Fire-and-forget: AI Chat composer kicked off a draft turn. */
  aiDraftStart(payload: IslandAIDraftStartPayload): void
  /** Fire-and-forget: streaming progress tick. Throttled by caller. */
  aiDraftStream(payload: IslandAIDraftStreamPayload): void
  /** Fire-and-forget: draft turn finished (status.kind=completed). */
  aiDraftReady(payload: IslandAIDraftReadyPayload): void
  /** Subscribe to status broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (status: IslandStatus) => void): () => void
}

// ---- Sprint 8 §2.2 — auto-updater surface ---------------------------------

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'dev-disabled'

export interface UpdaterStatus {
  state: UpdaterState
  /** From `app.getVersion()` (package.json at build time). */
  currentVersion: string
  latestVersion: string | null
  /** 0-100; defined only while state === 'downloading'. */
  downloadPercent: number | null
  message: string | null
  /** Epoch ms of the last state transition. */
  updatedAt: number
}

export interface UpdaterApi {
  /** Synchronous snapshot of the current status (single IPC roundtrip). */
  status(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.checkForUpdates()`. Returns the post-call status —
   *  events typically follow asynchronously so subscribe via `onEvent`. */
  check(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.downloadUpdate()` (only valid when state ===
   *  'available'). Returns the post-call status. */
  download(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.quitAndInstall(false, true)`. Quits the app, so
   *  there's nothing useful to return. */
  quitAndInstall(): Promise<void>
  /** Subscribe to status broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (status: UpdaterStatus) => void): () => void
}

export interface MailApi {
  email: EmailApi
  attachment: AttachmentApi
  ai: AiApi
  chat: ChatApi
  llm: LlmApi
  notion: NotionWriteApi
  /** Sprint 6 — admin dashboard data. */
  admin: AdminApi
  /** Sprint 6 — recurring meeting list. */
  calendar: CalendarApi
  /** Sprint 6 — SettingsPage IPC surface (keytar + persistent settings). */
  settings: SettingsApi
  /** Sprint 8 — electron-updater bridge (current version + check / download / install). */
  updater: UpdaterApi
  /** Sprint 9 — ping-island bridge (status + appearance broadcast + AI draft envelopes). */
  island: IslandApi
}
