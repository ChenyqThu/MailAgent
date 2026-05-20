// REVIEW-LOG C-03 — thin DAO + 4 IPC handler. Reads land directly on
// better-sqlite3 (~4ms) per BACKEND-INTERFACES.md §4.3; writes (resync /
// update-flag) live in Sprint 5 behind cli_runner.
//
// Every returned object is shaped to the cli-schema contract that lives in
// docs/cli-schema/*.schema.json + shared/types/cli.gen.ts. Unit tests
// (Sprint 1.8) validate the shapes with ajv against the same schema files —
// so if the backend bumps a schema the test fails loudly, and the renderer
// types update on `pnpm gen:types`.

import type { Database, Statement } from 'better-sqlite3'
import { ipcMain } from 'electron'

import { getDb } from '../db'
import {
  mapLanguage,
  mapPriority,
  mapReviewStatus,
  mapSentiment,
  parseLabels
} from '@shared/lib/ai_mapping'
import type { AIFields, EnrichedEmailMeta, MailboxSummary, SearchResult } from '@shared/api/types'
import type {
  EmailList_EmailListItem,
  EmailGet_EmailRecord,
  EmailSearch_SearchHit,
  AttachmentList_AttachmentItem,
  MailagentEmailBody
} from '@shared/types/cli.gen'

// ---- request shapes (renderer-side mirrors shared/api/types.ts) -------------

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

// Frontend-only enriched view shapes (NOT in cli.gen.ts) live in
// `@shared/api/types` so the renderer's <EmailRow>/<AIFieldsBlock> can read
// the same TypeScript declarations without crossing the main/renderer
// boundary. See the module doc in shared/api/types.ts for the rationale.

// ---- raw row shapes (private — never leak to renderer) ----------------------

interface EmailMetadataRow {
  internal_id: number
  message_id: string | null
  thread_id: string | null
  subject: string | null
  sender: string | null
  sender_name: string | null
  to_addr: string | null
  cc_addr: string | null
  date_received: string | null
  mailbox: string | null
  is_read: number
  is_flagged: number
  // v9 — 邮件原生重要性（Importance / X-Priority 头部归一化）。
  is_important: number | null
  sync_status: string | null
  notion_page_id: string | null
  notion_thread_id: string | null
  sync_error: string | null
  retry_count: number | null
}

interface EmailBodyRow {
  internal_id: number
  body_html: string | null
  body_markdown: string | null
  body_format: string | null
  body_size_bytes: number | null
  has_inline_images: number | null
  raw_mime_sha256: string | null
  fetched_at: number | null
  fetched_source: string | null
}

interface AttachmentRow {
  id: number
  internal_id: number
  filename: string
  size_bytes: number | null
  content_type: string | null
  is_inline: number | null
  content_id: string | null
  sha256: string | null
  derived_from: number | null
  derived_format: string | null
  notion_file_id: string | null
  notion_block_id: string | null
  local_path: string | null
}

interface SearchRow {
  internal_id: number
  subject: string | null
  sender: string | null
  date_received: string | null
  mailbox: string | null
  rank: number
  snippet: string | null
  notion_page_id: string | null
  // Search-module 1:1 mockup-search.html — LEFT JOIN llm_processing extracts
  // these so the palette EmailHitRow can render priority chip + lang-pip
  // without a second IPC roundtrip per hit. Either may be null when the LLM
  // hasn't classified the email yet (e.g. fresh mail, or LLM gave up).
  priority_raw: string | null
  lang_raw: string | null
}

// ---- shaping helpers --------------------------------------------------------

const SYNC_STATUSES = new Set([
  'pending',
  'fetch_failed',
  'synced',
  'failed',
  'skipped',
  'dead_letter',
  'deleted'
])

// EmailGet_EmailRecord declares sync_status as required (string | null), while
// EmailList_EmailListItem leaves it optional. Pick the stricter shape so the
// DAO never returns `undefined` — the list shape is a superset and remains
// assignable.
type SyncStatus = EmailGet_EmailRecord['sync_status']

function asBool(n: number | null | undefined): boolean {
  return n === 1
}

function asSyncStatus(s: string | null): SyncStatus {
  if (s === null) return null
  return SYNC_STATUSES.has(s) ? (s as SyncStatus) : null
}

function notionUrl(pageId: string | null): string | null {
  // The full workspace URL prefix is private; the bare /<pageid_no_dashes>
  // form Notion resolves into the user's correct workspace post-login is
  // good enough for "open in browser" UX. Sprint 6 SettingsPage can pin a
  // workspace-scoped prefix when the user supplies one.
  if (!pageId) return null
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`
}

function shapeListItem(row: EmailMetadataRow): EmailList_EmailListItem {
  return {
    internal_id: row.internal_id,
    message_id: row.message_id,
    thread_id: row.thread_id,
    subject: row.subject ?? '',
    sender: row.sender ?? '',
    sender_name: row.sender_name,
    date_received: row.date_received,
    mailbox: row.mailbox,
    is_read: asBool(row.is_read),
    is_flagged: asBool(row.is_flagged),
    sync_status: asSyncStatus(row.sync_status),
    notion_page_id: row.notion_page_id,
    notion_url: notionUrl(row.notion_page_id)
  }
}

function shapeAttachment(row: AttachmentRow): AttachmentList_AttachmentItem {
  return {
    id: row.id,
    internal_id: row.internal_id,
    filename: row.filename,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    is_inline: asBool(row.is_inline),
    content_id: row.content_id,
    sha256: row.sha256,
    derived_from: row.derived_from,
    derived_format: row.derived_format,
    notion_file_id: row.notion_file_id,
    notion_block_id: row.notion_block_id
  }
}

type RecordBody = NonNullable<EmailGet_EmailRecord['body']>
type BodyFormat = RecordBody['format']

function shapeBodySummary(row: EmailBodyRow | undefined): RecordBody | null {
  if (!row) return null
  const fmt = (row.body_format ?? 'empty') as BodyFormat
  return {
    format: fmt,
    size_bytes: row.body_size_bytes ?? 0,
    has_inline_images: asBool(row.has_inline_images),
    fetched_at: row.fetched_at,
    fetched_source: row.fetched_source,
    raw_mime_sha256: row.raw_mime_sha256
  }
}

function shapeFullRecord(
  meta: EmailMetadataRow,
  body: EmailBodyRow | undefined,
  attachments: AttachmentRow[]
): EmailGet_EmailRecord {
  return {
    internal_id: meta.internal_id,
    message_id: meta.message_id,
    thread_id: meta.thread_id,
    subject: meta.subject ?? '',
    sender: meta.sender ?? '',
    sender_name: meta.sender_name,
    to_addr: meta.to_addr ?? '',
    cc_addr: meta.cc_addr ?? '',
    date_received: meta.date_received,
    mailbox: meta.mailbox ?? '',
    is_read: asBool(meta.is_read),
    is_flagged: asBool(meta.is_flagged),
    sync_status: asSyncStatus(meta.sync_status),
    notion_page_id: meta.notion_page_id,
    notion_thread_id: meta.notion_thread_id,
    notion_url: notionUrl(meta.notion_page_id),
    sync_error: meta.sync_error,
    retry_count: meta.retry_count ?? 0,
    body: shapeBodySummary(body),
    attachments: attachments.map(shapeAttachment)
  }
}

// ---- DAO --------------------------------------------------------------------

interface WhereBuild {
  sql: string
  params: unknown[]
}

function buildListWhere(opts: ListOpts): WhereBuild {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.mailbox) {
    clauses.push('mailbox = ?')
    params.push(opts.mailbox)
  }
  if (opts.status) {
    clauses.push('sync_status = ?')
    params.push(opts.status)
  }
  if (opts.sinceDate) {
    clauses.push('date_received >= ?')
    params.push(opts.sinceDate)
  }
  if (opts.untilDate) {
    clauses.push('date_received <= ?')
    params.push(opts.untilDate)
  }
  if (opts.fromAddr) {
    clauses.push('sender LIKE ?')
    params.push(`%${opts.fromAddr}%`)
  }
  if (opts.subject) {
    clauses.push('subject LIKE ?')
    params.push(`%${opts.subject}%`)
  }
  if (opts.isRead !== undefined) {
    clauses.push('is_read = ?')
    params.push(opts.isRead ? 1 : 0)
  }
  if (opts.isFlagged !== undefined) {
    clauses.push('is_flagged = ?')
    params.push(opts.isFlagged ? 1 : 0)
  }
  if (opts.hasNotion !== undefined) {
    clauses.push(opts.hasNotion ? 'notion_page_id IS NOT NULL' : 'notion_page_id IS NULL')
  }
  const sql = clauses.length === 0 ? '' : 'WHERE ' + clauses.join(' AND ')
  return { sql, params }
}

const LIST_COLS = `
    internal_id, message_id, thread_id, subject, sender, sender_name,
    to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
    is_important,
    sync_status, notion_page_id, notion_thread_id, sync_error, retry_count
`

const BODY_COLS = `
    internal_id, body_html, body_markdown, body_format, body_size_bytes,
    has_inline_images, raw_mime_sha256, fetched_at, fetched_source
`

const ATTACHMENT_COLS = `
    id, internal_id, filename, size_bytes, content_type, is_inline,
    content_id, sha256, derived_from, derived_format,
    notion_file_id, notion_block_id, local_path
`

// Statement cache — better-sqlite3 prepared statements amortize parse cost
// across calls. We index by SQL text rather than fingerprinting opts, so the
// `WHERE … AND …` permutations from list() each get their own cache slot.
const stmtCache = new Map<string, Statement>()

function prep(db: Database, sql: string): Statement {
  const hit = stmtCache.get(sql)
  if (hit) return hit
  const stmt = db.prepare(sql)
  stmtCache.set(sql, stmt)
  return stmt
}

/**
 * Sprint 3 §2.3 — sibling list for the Thread sidebar. Cheap SQL on the
 * existing `thread_id` index; we deliberately don't join `email_body` /
 * `llm_processing` because the sidebar only renders the metadata stripe.
 * Ascending date order so the conversation reads top-to-bottom (mockup
 * §sidebar).
 */
export function listEmailsByThread(threadId: string | null | undefined): EmailList_EmailListItem[] {
  if (typeof threadId !== 'string' || threadId.length === 0) return []
  const db = getDb()
  const rows = prep(
    db,
    `SELECT ${LIST_COLS}
       FROM email_metadata
      WHERE thread_id = ?
      ORDER BY date_received ASC NULLS LAST, internal_id ASC`
  ).all(threadId) as EmailMetadataRow[]
  return rows.map(shapeListItem)
}

export function listEmails(opts: ListOpts): EmailList_EmailListItem[] {
  const db = getDb()
  const where = buildListWhere(opts)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const sql = `SELECT ${LIST_COLS}
               FROM email_metadata
               ${where.sql}
               ORDER BY date_received DESC NULLS LAST, internal_id DESC
               LIMIT ? OFFSET ?`
  const rows = prep(db, sql).all(...where.params, limit, offset) as EmailMetadataRow[]
  return rows.map(shapeListItem)
}

export function getEmail(internalId: number): EmailGet_EmailRecord | null {
  const db = getDb()
  const meta = prep(db, `SELECT ${LIST_COLS} FROM email_metadata WHERE internal_id = ?`).get(
    internalId
  ) as EmailMetadataRow | undefined
  if (!meta) return null
  const body = prep(db, `SELECT ${BODY_COLS} FROM email_body WHERE internal_id = ?`).get(
    internalId
  ) as EmailBodyRow | undefined
  const attachments = prep(
    db,
    `SELECT ${ATTACHMENT_COLS} FROM email_attachment WHERE internal_id = ? ORDER BY id ASC`
  ).all(internalId) as AttachmentRow[]
  return shapeFullRecord(meta, body, attachments)
}

export function getEmailBody(
  internalId: number,
  format: BodyOpts['format'] = 'markdown'
): MailagentEmailBody['data'] | null {
  const db = getDb()
  const row = prep(db, `SELECT ${BODY_COLS} FROM email_body WHERE internal_id = ?`).get(
    internalId
  ) as EmailBodyRow | undefined
  if (!row) return null
  let content: string | null
  if (format === 'raw') {
    // raw mode returns only the sha256 hash per email-body.schema.json — the
    // bytes themselves never round-trip through IPC (they live in MIME source
    // we no longer keep around).
    content = row.raw_mime_sha256
  } else if (format === 'html') {
    content = row.body_html
  } else {
    content = row.body_markdown
  }
  return {
    internal_id: internalId,
    format,
    content,
    size_bytes: row.body_size_bytes ?? 0,
    fetched_at: row.fetched_at,
    fetched_source: row.fetched_source
  }
}

// Cached COUNT(*) for the palette footer `N of total_indexed` segment.
// email_body_fts is small (~3k rows in production); prepared-statement cache
// already amortises parse cost across calls.
export function getEmailBodyFtsCount(): number {
  const db = getDb()
  const row = prep(db, `SELECT COUNT(*) AS n FROM email_body_fts`).get() as
    | { n: number }
    | undefined
  return row?.n ?? 0
}

export function searchEmails(opts: SearchOpts): SearchResult {
  const total_indexed = getEmailBodyFtsCount()
  if (!opts.query || opts.query.trim().length === 0) {
    return { items: [], total_indexed }
  }
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const filterClauses: string[] = []
  const filterParams: unknown[] = []
  if (opts.mailbox) {
    filterClauses.push('m.mailbox = ?')
    filterParams.push(opts.mailbox)
  }
  if (opts.since) {
    filterClauses.push('m.date_received >= ?')
    filterParams.push(opts.since)
  }
  if (opts.until) {
    filterClauses.push('m.date_received <= ?')
    filterParams.push(opts.until)
  }
  const filterSql = filterClauses.length === 0 ? '' : 'AND ' + filterClauses.join(' AND ')
  // FTS5 bm25 returns negative scores where smaller (more negative) = more
  // relevant. We re-emit the value as-is per email-search.schema.json
  // convention ("bm25 score - 越小越相关").
  //
  // Search-module 1:1 mockup-search.html — LEFT JOIN llm_processing pulls
  // priority + language out of labels_json so the palette EmailHitRow
  // renders priority chip + lang-pip without a per-hit follow-up IPC.
  // LEFT (not INNER) so emails the LLM hasn't classified yet still appear
  // — those land with null priority + 'unknown' lang.
  const sql = `
    SELECT
      m.internal_id           AS internal_id,
      m.subject               AS subject,
      m.sender                AS sender,
      m.date_received         AS date_received,
      m.mailbox               AS mailbox,
      bm25(email_body_fts)    AS rank,
      snippet(email_body_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
      m.notion_page_id        AS notion_page_id,
      json_extract(l.labels_json, '$.priority') AS priority_raw,
      json_extract(l.labels_json, '$.language') AS lang_raw
    FROM email_body_fts
    JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
    LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
    WHERE email_body_fts MATCH ?
    ${filterSql}
    ORDER BY rank ASC
    LIMIT ?`
  const rows = prep(db, sql).all(opts.query, ...filterParams, limit) as SearchRow[]
  const items: EmailSearch_SearchHit[] = rows.map((row) => ({
    internal_id: row.internal_id,
    subject: row.subject ?? '',
    sender: row.sender ?? '',
    date_received: row.date_received,
    mailbox: row.mailbox,
    rank: row.rank,
    snippet: row.snippet,
    notion_page_id: row.notion_page_id,
    notion_url: notionUrl(row.notion_page_id),
    ai_priority: mapPriority(row.priority_raw),
    lang: mapLanguage(row.lang_raw)
  }))
  return { items, total_indexed }
}

// ---- Enriched list + mailbox + AI fields (renderer-only views) -------------

interface EnrichedRow extends EmailMetadataRow {
  snippet_raw: string | null
  lang_raw: string | null
  priority_raw: string | null
  action_raw: string | null
  category_raw: string | null
  attach_count: number | null
  // Sprint 15 D 块: Notion Processing Status 镜像 (CLI email flag 写, 反向
  // handler 也维护). EmailRow 用它判断 'done' 三态显示, 不再依赖 sync_status.
  processing_status: string | null
}

interface MailboxRow {
  mailbox: string | null
  total: number
  unread: number
  flagged: number
  failed: number
}

interface AIFieldsRow extends EmailMetadataRow {
  processing_status: string | null
  labels_json: string | null
  llm_status: string | null
}

// Selecting the same metadata columns as LIST_COLS but qualified to the
// `m.` alias (the LEFT JOINs make bare names ambiguous). Plus the join-
// derived extras. `is_inline = 0` keeps the user-visible attachment count
// honest — cid: inline images shouldn't bump the paperclip counter;
// derived docx→pdf siblings are user-visible so they stay in.
const ENRICHED_LIST_COLS = `
    m.internal_id, m.message_id, m.thread_id, m.subject, m.sender, m.sender_name,
    m.to_addr, m.cc_addr, m.date_received, m.mailbox, m.is_read, m.is_flagged,
    m.is_important,
    m.sync_status, m.notion_page_id, m.notion_thread_id, m.sync_error, m.retry_count,
    m.processing_status
`

const ENRICHED_EXTRA_COLS = `
    substr(b.body_markdown, 1, 100) AS snippet_raw,
    json_extract(l.labels_json, '$.language')   AS lang_raw,
    json_extract(l.labels_json, '$.priority')   AS priority_raw,
    json_extract(l.labels_json, '$.action_type') AS action_raw,
    json_extract(l.labels_json, '$.category')   AS category_raw,
    -- Sprint 16 perf: attach_count 改 LEFT JOIN 聚合 (之前用相关子查询, 每行
    -- 一次全表扫描; 500 行 → 500 次扫). 配合 v11 的 (internal_id, is_inline)
    -- 索引, listEnriched 整体延迟从 ~200-500ms 降到 ~10-30ms.
    COALESCE(a.attach_count, 0) AS attach_count
`

function buildEnrichedWhere(opts: ListOpts): WhereBuild {
  const { sql, params } = buildListWhere(opts)
  if (sql.length === 0) return { sql, params }
  // Re-qualify every bare column reference to the `m.` alias so the JOIN
  // doesn't trip on ambiguous columns. Cheap regex — no SQL injection
  // surface because every clause comes from buildListWhere().
  const qualified = sql.replace(
    /\b(mailbox|sync_status|date_received|sender|subject|is_read|is_flagged|notion_page_id)\b/g,
    'm.$1'
  )
  return { sql: qualified, params }
}

function shapeEnrichedItem(row: EnrichedRow): EnrichedEmailMeta {
  return {
    ...shapeListItem(row),
    // v9 — 邮件原生 Importance/X-Priority 头部归一化（reader._parse_importance），
    // 给 EmailRow 的 ❗ 角标用，不再从 ai_priority 推断。
    is_important: asBool(row.is_important),
    snippet: row.snippet_raw && row.snippet_raw.length > 0 ? row.snippet_raw : null,
    lang: mapLanguage(row.lang_raw),
    ai_priority: mapPriority(row.priority_raw),
    ai_action: row.action_raw ?? null,
    // LLM CATEGORY_ENUM literal (e.g. "💼 产品管理"); pass through verbatim so
    // the filter popover can match against the same string the LLM emitted.
    ai_category: row.category_raw ?? null,
    attach_count: row.attach_count ?? 0,
    // Sprint 15 D 块: Notion Processing Status 镜像. EmailRow 用它判 done 三态.
    processing_status: row.processing_status ?? null
  }
}

export function listEmailsEnriched(opts: ListOpts): EnrichedEmailMeta[] {
  const db = getDb()
  const where = buildEnrichedWhere(opts)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const sql = `SELECT ${ENRICHED_LIST_COLS}, ${ENRICHED_EXTRA_COLS}
               FROM email_metadata m
               LEFT JOIN email_body b      ON b.internal_id = m.internal_id
               LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
               LEFT JOIN (
                 SELECT internal_id, COUNT(*) AS attach_count
                 FROM email_attachment WHERE is_inline = 0
                 GROUP BY internal_id
               ) a ON a.internal_id = m.internal_id
               ${where.sql}
               ORDER BY m.date_received DESC NULLS LAST, m.internal_id DESC
               LIMIT ? OFFSET ?`
  const rows = prep(db, sql).all(...where.params, limit, offset) as EnrichedRow[]
  return rows.map(shapeEnrichedItem)
}

export function listMailboxes(): MailboxSummary[] {
  const db = getDb()
  const rows = prep(
    db,
    // Sprint 10 user-acceptance follow-up — added `flagged` + `failed` counts
    // so the Sidebar virtual entries ("已标旗" / "Failed") can show live
    // numbers instead of hardcoded zero. Excludes `skipped` from total so
    // headcounts match what the EmailList actually displays.
    `SELECT mailbox,
            COUNT(*) AS total,
            SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
            SUM(CASE WHEN is_flagged = 1 THEN 1 ELSE 0 END) AS flagged,
            SUM(CASE WHEN sync_status IN ('failed', 'dead_letter') THEN 1 ELSE 0 END) AS failed
       FROM email_metadata
      WHERE mailbox IS NOT NULL AND mailbox != ''
        AND sync_status != 'skipped'
      GROUP BY mailbox
      ORDER BY total DESC`
  ).all() as MailboxRow[]
  return rows
    .filter(
      (r): r is MailboxRow & { mailbox: string } => r.mailbox !== null && r.mailbox.length > 0
    )
    .map((r) => ({
      mailbox: r.mailbox,
      total: r.total ?? 0,
      unread: r.unread ?? 0,
      flagged: r.flagged ?? 0,
      failed: r.failed ?? 0
    }))
}

export function getAIFields(internalId: number): AIFields | null {
  const db = getDb()
  const row = prep(
    db,
    `SELECT ${LIST_COLS},
            processing_status,
            (SELECT labels_json FROM llm_processing WHERE internal_id = ?) AS labels_json,
            (SELECT status     FROM llm_processing WHERE internal_id = ?) AS llm_status
       FROM email_metadata
      WHERE internal_id = ?`
  ).get(internalId, internalId, internalId) as AIFieldsRow | undefined
  if (!row) return null
  const labels = parseLabels(row.labels_json)
  // labels_json fields we promote — see ai_mapping.ts module doc for the
  // schema-vs-reality mismatch on `sentiment`.
  const priorityRaw = labels && typeof labels.priority === 'string' ? labels.priority : null
  const actionRaw = labels && typeof labels.action_type === 'string' ? labels.action_type : null
  const sentimentRaw = labels && typeof labels.sentiment === 'string' ? labels.sentiment : null
  return {
    internal_id: row.internal_id,
    processing_status: row.processing_status ?? null,
    mailbox: row.mailbox ?? null,
    is_read: asBool(row.is_read),
    is_flagged: asBool(row.is_flagged),
    ai_priority: mapPriority(priorityRaw),
    ai_action: actionRaw,
    ai_review_status: mapReviewStatus(row.llm_status),
    sentiment: mapSentiment(sentimentRaw),
    labels_raw: labels
  }
}

// ---- Pin (v8) read path — front-end "置顶" persistence -------------------
//
// SQLite is the source of truth (CLI writes via `mailagent email pin/unpin`
// in write_ops.ts; pm2 mail-sync never touches is_pinned, so there is no
// race). The renderer can SELECT directly through better-sqlite3 since
// the connection is readonly — that path is fast and avoids forking a
// `mailagent email list-pinned` subprocess on every 10s refetch.

interface PinRow {
  internal_id: number
}

export function listPinnedEmailIds(): number[] {
  const db = getDb()
  const rows = prep(
    db,
    `SELECT internal_id FROM email_metadata
      WHERE is_pinned = 1
      ORDER BY pinned_at DESC, internal_id DESC`
  ).all() as PinRow[]
  return rows.map((r) => r.internal_id)
}

// ---- IPC wiring -------------------------------------------------------------

export function registerEmailHandlers(): void {
  ipcMain.handle('email:list', (_evt, opts: ListOpts = {}) => listEmails(opts ?? {}))
  ipcMain.handle('email:listEnriched', (_evt, opts: ListOpts = {}) =>
    listEmailsEnriched(opts ?? {})
  )
  ipcMain.handle('email:listMailboxes', () => listMailboxes())
  ipcMain.handle('email:aiFields', (_evt, internalId: number) => {
    if (!Number.isInteger(internalId) || internalId < 0) {
      throw new TypeError(`email:aiFields expected non-negative integer, got ${String(internalId)}`)
    }
    return getAIFields(internalId)
  })
  ipcMain.handle('email:get', (_evt, internalId: number) => {
    if (!Number.isInteger(internalId) || internalId < 0) {
      throw new TypeError(`email:get expected non-negative integer, got ${String(internalId)}`)
    }
    return getEmail(internalId)
  })
  ipcMain.handle('email:body', (_evt, internalId: number, opts: BodyOpts = {}) => {
    if (!Number.isInteger(internalId) || internalId < 0) {
      throw new TypeError(`email:body expected non-negative integer, got ${String(internalId)}`)
    }
    return getEmailBody(internalId, opts?.format ?? 'markdown')
  })
  ipcMain.handle('email:search', (_evt, opts: SearchOpts) => {
    if (typeof opts?.query !== 'string') {
      throw new TypeError('email:search expected { query: string, … }')
    }
    return searchEmails(opts)
  })
  ipcMain.handle('email:listByThread', (_evt, threadId: string | null) =>
    listEmailsByThread(threadId)
  )
  // v8 — listPinnedIds is a readonly SQLite SELECT, wired here. The
  // write path (email:pin / email:unpin) lives in write_ops.ts and forks
  // the `mailagent email pin / unpin` CLI per the renderer-readonly rule
  // (db.ts comment / REVIEW-LOG C-05).
  ipcMain.handle('email:listPinnedIds', () => listPinnedEmailIds())
}
