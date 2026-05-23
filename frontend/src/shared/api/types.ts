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
/**
 * EmailDetail = schema-typed EmailGet_EmailRecord + the fields the Electron
 * main handler returns that the cli-schema codegen doesn't yet expose.
 * Sprint 14 should fold these into email-get.schema.json + `pnpm gen:types`.
 *
 *   - `is_important` — v9 RFC-header importance bit, written by
 *     `reader._parse_importance` and surfaced verbatim by
 *     `handlers/email.ts:520` (asBool of the SQLite column).
 */
export type EmailDetail = EmailGet_EmailRecord & {
  is_important?: boolean
}
export type EmailBody = NonNullable<MailagentEmailBody['data']>
export type SearchHit = EmailSearch_SearchHit
export type AttachmentMeta = AttachmentList_AttachmentItem
export type ResyncResult = MailagentEmailResync['data']

/**
 * Search-module 1:1 mockup-search.html — IPC wrapper around `SearchHit[]`.
 *
 * The palette footer needs the FTS5 indexed-row total to render
 * "N of total_indexed" (mockup-search.html line 798). Returning it inline
 * with the hits keeps the palette to a single IPC roundtrip per keystroke
 * (debounce 250ms × ~4ms each = effectively free).
 *
 * Both fields are required; an empty query still returns `items: []` plus
 * the cached `total_indexed`.
 *
 * PR-2a: 当 smart mode 改写了 query (CJK-aware FTS5 transform) 时,
 * transformed_query 含实际打给 FTS5 的 query, UI 可显示 "your query
 * '产品' was expanded to ..." 提示. 跟原 query 一样时省略.
 */
export interface SearchResult {
  items: SearchHit[]
  total_indexed: number
  transformed_query?: string
  mode?: 'smart' | 'raw'
}

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
  /** `labels_json.category` — LLM-emitted closed enum (CATEGORY_ENUM in
   *  src/llm_agent/schema.py), passed through verbatim (e.g. "💼 产品管理").
   *  Null if no LLM run yet. Drives the filter popover's Category section. */
  ai_category: string | null
  /** User-visible attachment count: excludes inline-only images. Includes derived (docx→pdf). */
  attach_count: number
  /** v9 — 邮件原生重要性（reader._parse_importance: Importance / X-Priority /
   *  X-MSMail-Priority 任一为 high → true）。EmailRow 的 ❗ 角标读这个字段，
   *  与 LLM 推断的 ai_priority 互相独立。 */
  is_important: boolean
  /** Sprint 15 D 块 — Notion Processing Status 镜像 (CLI email flag 写, 反向
   *  webhook handler 也维护). EmailRow 用 `processing_status === '已完成'`
   *  判 'done' 三态显示 (v3 的 sync_status==='deleted' 判定永远 false, 已失效).
   *  可能值: '未处理' / 'AI Reviewed' / '已同步' / '已完成' / '草稿已创建';
   *  老邮件未被任何写入触达时为 null. */
  processing_status: string | null
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
  /** Restrict to a specific set of internal_id values. 配合其他 filter
   *  叠加 (AND), 主要给 pinned-supplement / 已知 id 批量取 enriched 用. */
  internalIds?: number[]
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

/**
 * Sprint 15 — `mailagent email flag` opts. Mirrors `EmailFlagOpts` declared
 * in `src/electron/main/handlers/write_ops.ts` (same shape, kept duplicated
 * to keep main / renderer free of cross-imports — same convention as
 * `UpdateFlagOpts`).
 *
 * Replaces the v3 `notion.updateFlag` path: writes SQLite flag intent + a
 * dual-target outbox row (mailapp + notion), then mail-sync's FanoutWorker
 * dispatches both sides async. Pass `internalId = null` + `opts.ids = [...]`
 * to batch (single CLI fork enqueues N×2 outbox rows).
 */
export interface EmailFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string
  /** Batch mode: ids ↔ internalId are mutually exclusive at the CLI level. */
  ids?: number[]
  /** Default true. Mail-sync is always online in production, so the CLI's
   *  pm2 conflict check must be bypassed. */
  allowConcurrent?: boolean
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
  /**
   * Search-module 1:1 mockup-search.html — returns wrapped
   * `{ items, total_indexed }` so the palette footer can render
   * "N of total_indexed" without a second IPC roundtrip.
   */
  search(opts: SearchOpts): Promise<SearchResult>
  /** Sprint 5 — Notion resync via `mailagent email resync`. Returns whatever
   *  the CLI's `data` envelope contains (page_id, status, etc.). */
  resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult>
  /** Sprint 5 — open Mail.app reply window (AppleScript). User edits +
   *  sends in Mail.app; we don't relay the send. */
  createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult>
  /** v8 — set pinned (true) / unpinned (false) via the `mailagent email
   *  pin/unpin` CLI. Returns the new state, or null on E_NOT_FOUND. The
   *  renderer's optimistic store reconciles against the next
   *  listPinnedIds refetch. */
  pin(internalId: number, pinned: boolean): Promise<boolean | null>
  /** v8 — current set of pinned internal_ids (pinned_at DESC). Drives
   *  the `pinned` zustand store and the "📌 已固定" group in EmailList. */
  listPinnedIds(): Promise<number[]>
  /**
   * Sprint 15 — SSoT inversion. Writes flag / processing_status intent to
   * SQLite (with echo-prevention) + a dual-target outbox row (mailapp +
   * notion). The mail-sync FanoutWorker then dispatches both sides async,
   * so this method returns as soon as the SQL has landed — actual Mail.app
   * / Notion mutations follow within ~5-10s.
   *
   * Single email: `flag(<id>, {isFlagged: true})`.
   * Batch: `flag(null, {ids: [...], isRead: true})` — one CLI fork, N×2
   * outbox rows. The two modes are mutually exclusive at the CLI level.
   *
   * Replaces `mailApi.notion.updateFlag(...)`; the old method stays during
   * Sprint 15 grayscale (frontend/SPRINT15-D handoff §6).
   */
  flag(internalId: number | null, opts: EmailFlagOpts): Promise<unknown>
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

// ── DavMail health snapshot (roadmap §4.5.1-3) — frontend reads sync_state
// davmail.* keys via direct better-sqlite3 (no CLI fork) every 5s for the
// red-dot badge + AdminPage card. Source-of-truth: DavMailWatchdog writes
// these keys every 60s.
export interface DavMailHealthData {
  /** False when mail-sync isn't in davmail mode (no watchdog ticks yet). */
  enabled: boolean
  level: 'ok' | 'warning' | 'critical' | 'unknown'
  last_probe_at: string | null
  imap_reachable: boolean
  smtp_reachable: boolean
  consecutive_imap_failures: number
  consecutive_smtp_failures: number
  /** Days since token.dat mtime. Null when token.dat missing. */
  token_age_days: number | null
  token_mtime_iso: string | null
  /** Count of EWSThrottlingException headers in last 5 min log tail. */
  throttle_events_5min: number
  last_oauth_error: string | null
  last_oauth_error_at: string | null
  /** Watchdog auto-pauses uid-mapper when throttling >= 3 in 5min. */
  uid_backfill_paused: boolean
}

export interface SystemAlertItem {
  level: 'critical' | 'warning' | 'info'
  source: string
  title: string
  message: string
  ts: string | null
}

export interface SystemAlertsData {
  alerts: SystemAlertItem[]
  critical_count: number
  warning_count: number
  /** Server-side ISO timestamp; renderer uses it for tooltip "as of". */
  generated_at: string
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
  /** roadmap §4.5 — current davmail backend health snapshot (direct SQLite
   *  read, ~1ms). Returns enabled=false when watchdog hasn't ticked. */
  davmailHealth(): Promise<DavMailHealthData>
  /** Current active system alerts derived from davmail health + (future)
   *  other sources. Polled by SystemAlertBadge every 5s. */
  systemAlerts(): Promise<SystemAlertsData>
}

// ---- Sprint 6 §2.2 — calendar (recurring meeting) surface -----------------

export interface RecurringInviteItem {
  /** Phase 2.4 — vEvent UID (RFC 5545). Replay 按钮调 eventReplay 用这个,
   *  跟 source 无关 (任何 source 都可 replay). 等于 series_uid. */
  ical_uid: string
  /** Source email (the meeting invite carrier). Phase 1.5 caldav-only events = 0. */
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

// Phase 3 §3.1 (frontend-view-silly-knuth.md) — Calendar SSoT 类型 (前端直读 SQLite
// calendar_event 表 + npm rrule 展开 occurrences). source 三态对应灰度共存:
// 'caldav' (CalendarSyncWorker 拉的) / 'email_ics' (meeting_sync 派生) /
// 'legacy_calendar_app' (老 calendar_main.py 路径).

export type CalendarEventSource = 'caldav' | 'email_ics' | 'legacy_calendar_app'

export interface CalendarEventAttendee {
  email: string
  name?: string
  /** PARTSTAT — ACCEPTED / TENTATIVE / DECLINED / NEEDS-ACTION */
  response?: string
  /** ROLE — CHAIR / REQ-PARTICIPANT / OPT-PARTICIPANT */
  role?: string
}

/** RRULE 展开后的单 occurrence (前端日历 timeline 渲染拿到的). */
export interface CalendarEventOccurrence {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  /** ISO UTC datetime — 前端 toLocaleString 转本地 TZ 展示. */
  occurrence_start_iso: string
  occurrence_end_iso: string
  /** True = 来自 RRULE 展开; False = 单次 event. */
  is_recurrence_instance: boolean
  is_all_day: boolean
  calendar_name: string
  organizer: string
  attendees: CalendarEventAttendee[]
  location: string
  url: string
  /** CONFIRMED / TENTATIVE / CANCELLED */
  status: string
  response_status: string
  source: CalendarEventSource
  notion_page_id: string | null
  related_email_internal_id: number | null
}

/** calendar_event 表完整 row (event-get 输出, 含 dtstart_iso / ics_raw 等). */
export interface CalendarEventDetail {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  description: string
  location: string
  organizer: string
  attendees: CalendarEventAttendee[]
  dtstart_iso: string | null
  dtend_iso: string | null
  is_all_day: boolean
  rrule: string
  exdates: string[]
  rdates: string[]
  status: string
  response_status: string
  url: string
  calendar_name: string
  source: string
  notion_page_id: string | null
  related_email_internal_id: number | null
  ics_raw: string
}

export interface CalendarSyncStateItem {
  calendar_name: string
  ctag: string | null
  sync_token: string | null
  last_full_sync_at_iso: string | null
  last_incremental_sync_at_iso: string | null
  last_error: string | null
}

export interface EventsListOpts {
  /** Window start (ISO datetime, UTC). Default = today 00:00 UTC. */
  fromIso?: string
  /** Window end. Default = fromIso + 7 days. */
  toIso?: string
  calendarName?: string
  source?: CalendarEventSource
  /** Default true. False = only return master events (skip RRULE expansion). */
  expandRecurrences?: boolean
  /** Cap on returned occurrences. Default 1000. */
  limit?: number
}

export interface EventGetOpts {
  icalUid: string
  recurrenceId?: string | null
  source?: CalendarEventSource
}

export interface SyncNowOpts {
  /** Default true. False = try sync-collection (DavMail 支持有限). */
  full?: boolean
  calendarName?: string
}

// Phase 2.4 — replay 单 calendar_event 行到 Notion mirror (任何 source).
export interface EventReplayOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** 非空 = replay 单次跳脱 occurrence; 留空 = 主事件. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = 按 caldav → email_ics → legacy 顺序自动查. */
  source?: CalendarEventSource
  /** 仅查 row 列 plan, 不写 Notion (无需 auth). */
  dryRun?: boolean
}

// Phase 2.1 — RSVP iTIP REPLY to organizer (drawer accept/tentative/decline button).
export type RsvpResponse = 'accept' | 'tentative' | 'decline'

export interface EventRsvpOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** accept / tentative / decline. */
  response: RsvpResponse
  /** 非空 = RSVP 单次跳脱 occurrence; 留空 = 整系列 REPLY. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = caldav → email_ics → legacy 自动查. */
  source?: CalendarEventSource
  /** True = 仅查 row + 拼 plan, 不发 SMTP (无需 auth). */
  dryRun?: boolean
}

export interface CalendarApi {
  recurringDiscover(opts?: RecurringDiscoverOpts): Promise<RecurringInviteItem[]>
  recurringReplay(opts: RecurringReplayOpts): Promise<unknown>
  expand(opts?: CalendarExpandOpts): Promise<unknown>

  // Phase 3 §3.1 — Calendar SSoT 直读
  eventsList(opts?: EventsListOpts): Promise<CalendarEventOccurrence[]>
  eventGet(opts: EventGetOpts): Promise<CalendarEventDetail | null>
  syncStatus(): Promise<CalendarSyncStateItem[]>
  calendarNames(): Promise<string[]>
  syncTrigger(opts?: SyncNowOpts): Promise<unknown>

  // Phase 2.4 — 重导出 calendar_event 行到 Notion (any source)
  eventReplay(opts: EventReplayOpts): Promise<unknown>

  // Phase 2.1 — 发 iTIP REPLY 给 organizer (accept/tentative/decline)
  eventRsvp(opts: EventRsvpOpts): Promise<unknown>
}

// ---- Sprint 6 §2.2 — SettingsPage surface --------------------------------

export type SecretSlot = 'cliApiKey' | 'llmApiKey' | 'llmTranslateApiKey' | 'customApiKey'

export interface SecretsStatus {
  cliApiKey: boolean
  llmApiKey: boolean
  llmTranslateApiKey: boolean
  customApiKey: boolean
}

export interface PersistentSettings {
  dbPath: string | null
  attachmentDir: string | null
  pollIntervalSec: 5 | 10 | 30 | 0
  notionAgentPageId: string | null
  notionAgentName: string | null
  customApiEndpoint: string | null
  /** Owner's email — sourced from repo-root `.env` USER_EMAIL on every
   *  settings:get read. Read-only; the renderer doesn't write this. */
  userEmail: string | null
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
  /** Sprint 13 — same content as `localPath` but inlined as a
   *  `data:<mime>;base64,...` URL. The sandboxed body iframe can't load
   *  `file://` URLs (same-origin policy under srcdoc) so inline images
   *  (cid: refs) substitute the data URL instead. Returns null when
   *  the file is missing or the read fails. */
  readDataUrl(attachmentId: number): Promise<string | null>
  /** Copy the on-disk attachment into the user's ~/Downloads, returning the
   *  final absolute path. Collides safely (appends `_1`, `_2`, …). Returns
   *  null when the row has no on-disk content or the source file is missing.
   *  Renderer cannot open `file://` URLs from the dev-server origin, so this
   *  exists as the user-visible "download attachment" affordance. */
  download(attachmentId: number): Promise<string | null>
}

// ---- Immersive translate (DB v12) ------------------------------------------
//
// 翻译路径双轨制：
//   - Path A (LLM 分类顺带): src/llm_agent/runner.py 在 LLM 分类时同步返回
//     translation_segments, 写 email_translation 表 (source='llm_agent').
//   - Path B (用户按 "翻译"): translateBatch IPC, html-extractor 抽块级 →
//     pLimit(2) batches of 10 → 写 email_translation 表 (source='on_demand').
//
// Renderer 不在乎是哪条路径写的, 拿到 segments 后让 EmailBodyFrame 通过
// iframe.contentDocument 用 textContent.includes(src) fuzzy 配对 DOM 节点
// 注入译文。

export type TargetLang = 'zh' | 'en'

export interface TranslationSegment {
  /** Source paragraph plaintext, verbatim substring of the email body
   *  paragraph. Used to fuzzy-match DOM nodes in the iframe via
   *  `textContent.includes(src)`. */
  src: string
  /** Translation of the segment (Simplified Chinese, mainland usage). */
  tgt: string
}

/** Cached translation envelope (returned by AiApi.getCached and AiApi.translateBatch). */
export interface TranslationCache {
  internalId: number
  targetLang: TargetLang
  segments: TranslationSegment[]
  /** Provenance — 'llm_agent' (Path A) | 'on_demand' (Path B). null on
   *  ad-hoc results before they're persisted. */
  source: string | null
  /** Model that produced the translation; empty string if empty cache. */
  model: string | null
  /** Unix seconds when the cache row was written; null for un-persisted result. */
  fetchedAt: number | null
}

/** Result of translateBatch — TranslationCache + batch run statistics. */
export interface TranslateBatchResult extends TranslationCache {
  latencyMs: number
  /** Number of batches that failed (LLM error / JSON parse / abort). When 0,
   *  the translation is complete. Renderer shows a partial-failure banner
   *  when this is > 0 but segments.length > 0. */
  failedBatches: number
  totalBatches: number
}

export interface AiApi {
  /**
   * Run an on-demand batch translation of an email's body (Path B). Extracts
   * block-level paragraphs from body_html in the main process, batches them
   * (10 per request, 2 concurrent), calls the LLM gateway, and writes the
   * result to email_translation (DB v12). Returns the full TranslateBatchResult
   * including failedBatches for partial-failure UX.
   *
   * API key + endpoint stay in the main process (REVIEW-LOG C-04). Errors
   * carry `code`: E_NO_BODY / E_NO_LLM_KEY / E_INVALID_ARG / E_UPSTREAM.
   */
  translateBatch(internalId: number, targetLang?: TargetLang): Promise<TranslateBatchResult>
  /** Read cached translation segments from email_translation table. Returns
   *  null on cache miss. Used to render the immersive translation on email
   *  open without re-running the LLM. */
  getCached(internalId: number, targetLang?: TargetLang): Promise<TranslationCache | null>
  /** Delete the cached translation row. Renderer fires this before
   *  re-translation so the new run overwrites cleanly. */
  deleteCached(internalId: number, targetLang?: TargetLang): Promise<boolean>
  /** Abort all in-flight batches for `internalId`. Renderer fires this when
   *  switching emails so stale batches don't keep CRS slots wedged. */
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
/** Sprint 19 — LLM proposes a tool call inside the agent harness loop.
 *  Mirror of main-process ToolUseEvent (chat/types.ts). */
export interface ChatToolUseEvent {
  type: 'tool_use'
  toolUseId: string
  name: string
  input: unknown
}
/** Sprint 19 — Tool execution finished (or was canceled by the user).
 *  Mirror of main-process ToolResultEvent. */
export interface ChatToolResultEvent {
  type: 'tool_result'
  toolUseId: string
  status: 'ok' | 'error' | 'canceled'
  output?: unknown
  errorMessage?: string
  durationMs: number
}
/** Sprint 19 — Harness needs user confirmation before running a write tool.
 *  Renderer pops ConfirmToolDialog; user click → chat:confirmTool IPC. */
export interface ChatPendingConfirmationEvent {
  type: 'pending_confirmation'
  toolUseId: string
  toolName: string
  input: unknown
  preview?: string
  tier: 'preview' | 'edit'
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
  /** Sprint 19 — Anthropic stop_reason carried to the renderer. Optional
   *  for backends that don't emit it (notion-agent CLI). */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
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
  | ChatToolUseEvent
  | ChatToolResultEvent
  | ChatPendingConfirmationEvent
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

// Sprint 14 PR B — inline message edit. The renderer sends the session +
// the user-message id being edited + the replacement content + the same
// backend choice fields chat.start uses (model can change between edits).
// Backend truncates everything from `editingMessageId` onward, appends a
// fresh user row with `newContent`, and re-streams the assistant turn.
export interface ChatEditOpts {
  sessionId: number
  editingMessageId: number
  newContent: string
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
  /**
   * Sprint 14 PR B — truncate session messages from `editingMessageId`
   * onward, append a new user message with `newContent`, and re-stream
   * the assistant reply. Throws `Error & { code }` on dispatch failure
   * (E_INVALID_ARG / E_NOT_FOUND / E_BACKEND_UNAVAILABLE / E_DISPATCH).
   * Only user-role messages can be edited.
   */
  editMessage(opts: ChatEditOpts): Promise<ChatStartResult>
  /**
   * Sprint 14 PR E — spawn a dedicated popout window pinned to the
   * given email's AI chat. Fire-and-forget: the new window shows
   * itself; no resolved promise. Same ai_chat.db backing store as the
   * main inbox panel, so flipping between the two windows is
   * transparent (WAL + busy_timeout already configured in chat_db.ts).
   */
  openPopout(emailId: number): void
  /**
   * Sprint 14 PR J — delete a session + its message rows (CASCADE).
   * Fire-and-forget; caller (useEmailChat.deleteSession) updates
   * renderer state synchronously after dispatching.
   */
  deleteSession(sessionId: number): void
  /**
   * Sprint 19 PR-1d.2 — reply to a ConfirmToolDialog. The harness is
   * blocked on a per-toolUseId promise (main-process tools/confirmation.ts)
   * waiting for this. `approved=false` → tool result is 'canceled' (LLM
   * sees a structured "user declined"). `editedInput` is only used when
   * the dialog tier is 'edit' and the user changed the LLM proposal.
   * Returns `{ ok: false, code: 'E_NOT_PENDING' }` for late clicks after
   * the session aborted.
   */
  confirmTool(
    toolUseId: string,
    approved: boolean,
    editedInput?: unknown
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>
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

// ---- Sprint 16 §SSE — events bridge surface ----------------------------

/** Sprint 16 — SSE event types. 后端 publish 点见 src/events/publisher.py
 *  + docs/sse-events.md. */
export type SseEventType =
  | 'email.synced'
  | 'email.failed'
  | 'email.dead_letter'
  | 'email.flag_changed'
  | 'outbox.enqueued'
  | 'outbox.done'
  | 'outbox.failed'
  | 'outbox.dead_letter'
  | 'llm.success'
  | 'llm.failed'
  | 'llm.gave_up'

export interface SseEvent {
  event_type: SseEventType | string
  ts: number
  internal_id: number | null
  data: Record<string, unknown>
  source: string
}

export type EventsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'disabled'

export interface EventsStatus {
  state: EventsConnectionState
  lastError: string | null
  lastEventTs: number | null
  url: string
}

export interface EventsApi {
  /** Current snapshot (idempotent invoke). */
  status(): Promise<EventsStatus>
  /** 立即重连 — 清退避 / 取消当前 fetch / 启新 attempt; 返回新 status. */
  reconnect(): Promise<EventsStatus>
  /** Subscribe to incoming SSE events; returns unsubscribe fn. */
  onEvent(handler: (event: SseEvent) => void): () => void
  /** Subscribe to connection-state changes; returns unsubscribe fn. */
  onStatus(handler: (status: EventsStatus) => void): () => void
}

// ---- Sprint 18 §PR B — repo-root .env read/write + pm2 services surface --
//
// Settings tabs (PR D) read the resolved `.env` once via env:get + cache it
// in zustand; on field-blur they call env:set({KEY: value}) which atomic-
// writes the file and returns restartRequired=true. RestartBanner (PR E)
// then surfaces and calls services:restart('mail-sync').

/** Mirror of `EnvSnapshot` in `electron/main/handlers/env.ts`. SECRET keys
 *  carry only '***' (set) or '' (unset) — plaintext never crosses IPC. */
export interface EnvSnapshot {
  path: string
  exists: boolean
  values: Record<string, string>
  managedKeys: readonly string[]
  secretKeys: string[]
}

export type EnvSetResult =
  | { ok: true; path: string; changedKeys: string[]; restartRequired: boolean }
  | {
      ok: false
      path: string
      error: { code: 'E_INVALID_KEY' | 'E_NOT_FOUND' | 'E_WRITE'; message: string }
    }

export interface EnvApi {
  /** Read the resolved `.env` snapshot. Secret values redacted. */
  get(): Promise<EnvSnapshot>
  /** Merge-write keys into the resolved `.env`. `null` value comments out
   *  the line (preserves the key for future re-enable). Returns a result
   *  envelope (not an exception) so the renderer can branch on error codes
   *  without losing the `code` property through the IPC structured-clone. */
  set(patch: Record<string, string | null>): Promise<EnvSetResult>
}

export type ServiceTarget = 'mail-sync' | 'calendar-sync' | 'all'

export interface ServiceRestartResult {
  ok: boolean
  target: string
  exitCode: number | null
  stdout: string
  stderr: string
  error?: {
    code: 'E_PM2_NOT_FOUND' | 'E_PM2_FAILED' | 'E_TIMEOUT' | 'E_INVALID_ARG'
    message: string
    /** Set on E_PM2_NOT_FOUND so the renderer toast can quote the exact
     *  terminal command. */
    fallbackCommand?: string
  }
}

export interface ServiceStatus {
  name: 'mail-sync' | 'calendar-sync'
  state: 'online' | 'stopped' | 'errored' | 'unknown'
  pid: number | null
  uptimeMs: number | null
  cpu: number | null
  memMB: number | null
}

export interface ServicesApi {
  /** Spawn `pm2 restart <target>`. Default target = `mail-sync`. */
  restart(target?: ServiceTarget): Promise<ServiceRestartResult>
  /** `pm2 jlist` → both known service slots, even when pm2 doesn't list one
   *  (returns `state: 'unknown'`). */
  status(): Promise<ServiceStatus[]>
}

// ---- LLM prompt files ---------------------------------------------------

export type PromptSlot = 'inbox' | 'sent'

export interface PromptInfo {
  slot: PromptSlot
  path: string
  exists: boolean
}

export interface PromptContent extends PromptInfo {
  content: string
}

export type PromptWriteResult =
  | { ok: true; info: PromptInfo }
  | { ok: false; code: string; message: string }

export interface PromptsApi {
  /** List both prompt slots with their resolved on-disk paths. The renderer
   *  uses `exists` to decide whether to surface a "未配置 / 保存后创建" hint. */
  list(): Promise<{ inbox: PromptInfo; sent: PromptInfo }>
  /** Read one prompt's content. Missing file returns `{exists:false, content:''}`. */
  read(slot: PromptSlot): Promise<PromptContent>
  /** Write content to the resolved path; auto-mkdir parent. */
  write(slot: PromptSlot, content: string): Promise<PromptWriteResult>
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
  /** Sprint 16 — SSE events bridge (replaces 5s polling). */
  events: EventsApi
  /** Sprint 18 §PR B — repo-root .env read/write. Settings tabs use this to
   *  persist managed ENV keys directly to the file Python services read. */
  env: EnvApi
  /** Sprint 18 §PR B — pm2 restart/status bridge. Wired to the
   *  RestartBanner (PR E) "立即重启" CTA after env:set returns
   *  restartRequired=true. */
  services: ServicesApi
  /** LLM prompt file CRUD (inbox / sent markdown). */
  prompts: PromptsApi
}
