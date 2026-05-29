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
  /**
   * PR-2a — CJK-aware FTS5 query 改写策略.
   *   'smart' (default): 自然语言关键词 → smartQueryTransform 改写
   *     ('产品' → '(产品* OR (产* AND 品*))' 等), 解决 unicode61 chunk-level
   *     token 中文搜索命不中的洞.
   *   'raw': 不改写, 用户已 explicit FTS5 syntax (双引号/通配/AND/OR/NOT 等).
   * 含 FTS5 特殊字符的 query 即使 mode='smart' 也会自动判定 raw passthrough.
   */
  mode?: 'smart' | 'raw'
}

// ── PR-2a: FTS5 query smart transform — CJK-aware natural-language → FTS5 ──
//
// 跟 src/repository/email_repository.py:smart_query_transform 算法保持一致,
// 测试也对齐 (Python TestSmartQueryTransform / TS smartQueryTransform suite).
// 改其中一边时记得同步另一边, 否则 chat tool 跟 CLI / webhook 行为分叉.

const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT'])

function isCjkChar(c: string): boolean {
  if (!c) return false
  const cp = c.codePointAt(0)
  if (cp === undefined) return false
  // CJK Unified Ideographs + Extension A + Extension B-F + 假名 + 谚文
  if (cp >= 0x4e00 && cp <= 0x9fff) return true
  if (cp >= 0x3400 && cp <= 0x4dbf) return true
  if (cp >= 0x20000 && cp <= 0x2fa1f) return true
  if (cp >= 0x3040 && cp <= 0x30ff) return true
  if (cp >= 0xac00 && cp <= 0xd7af) return true
  return false
}

function isSimpleNaturalQuery(q: string): boolean {
  // 仅含 alphanum / space / CJK → smart 改写; 含 punct / FTS5 syntax → raw
  for (const c of q) {
    if (/[\p{L}\p{N}]/u.test(c)) continue
    if (/\s/.test(c)) continue
    if (isCjkChar(c)) continue
    return false
  }
  return true
}

function wrapTokenCjkAware(tok: string): string {
  if (!tok) return ''
  // 按字符类切 segment
  const segments: Array<{ isCjk: boolean; seg: string }> = []
  let currentCjk: boolean | null = null
  let current = ''
  for (const c of tok) {
    const cCjk = isCjkChar(c)
    if (currentCjk === null) {
      currentCjk = cCjk
      current = c
    } else if (cCjk === currentCjk) {
      current += c
    } else {
      segments.push({ isCjk: currentCjk, seg: current })
      current = c
      currentCjk = cCjk
    }
  }
  if (current && currentCjk !== null) {
    segments.push({ isCjk: currentCjk, seg: current })
  }

  const wrapSeg = ({ isCjk, seg }: { isCjk: boolean; seg: string }): string => {
    if (!isCjk) return seg
    if ([...seg].length === 1) return `${seg}*`
    const chars = [...seg].map((c) => `${c}*`)
    return `(${seg}* OR (${chars.join(' AND ')}))`
  }

  if (segments.length === 1) return wrapSeg(segments[0]!)
  return '(' + segments.map(wrapSeg).join(' AND ') + ')'
}

export function smartQueryTransform(query: string): string {
  if (!query || !query.trim()) return query
  const q = query.trim()
  if (!isSimpleNaturalQuery(q)) return q
  const tokens = q.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.some((t) => FTS5_OPERATORS.has(t))) return q
  const wrapped = tokens.map(wrapTokenCjkAware).filter((w) => w.length > 0)
  if (wrapped.length === 0) return q
  if (wrapped.length === 1) return wrapped[0]!
  return wrapped.join(' AND ')
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
  if (opts.internalIds && opts.internalIds.length > 0) {
    // 实测 pinned 数量 < 100, 远低于 SQLite 默认 999 param cap. 真的超了
    // better-sqlite3 会抛, 调用方截断.
    const placeholders = opts.internalIds.map(() => '?').join(',')
    clauses.push(`internal_id IN (${placeholders})`)
    params.push(...opts.internalIds)
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

/**
 * Batch sibling fetch — ONE SQL for many thread_ids, replacing the
 * per-thread fan-out the renderer used to fire (EmailList kicked one IPC +
 * one query per visible thread; 800 rows → hundreds of round-trips
 * serialised on the main process, the dominant source of list-scroll jank).
 * Returns a map keyed by thread_id with the SAME ascending date order /
 * shape as listEmailsByThread, so the renderer's supplement-merge logic is
 * unchanged. Unknown / empty ids are dropped; threads with no rows are
 * simply absent from the map.
 */
export function listEmailsByThreads(
  threadIds: ReadonlyArray<string> | null | undefined
): Record<string, EmailList_EmailListItem[]> {
  if (!Array.isArray(threadIds)) return {}
  // De-dupe + drop empties — don't trust the caller to pre-clean; keeps the
  // IN(...) placeholder count tight and the statement-cache slots bounded.
  const ids = Array.from(
    new Set(threadIds.filter((t): t is string => typeof t === 'string' && t.length > 0))
  )
  if (ids.length === 0) return {}
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = prep(
    db,
    `SELECT ${LIST_COLS}
       FROM email_metadata
      WHERE thread_id IN (${placeholders})
      ORDER BY thread_id ASC, date_received ASC NULLS LAST, internal_id ASC`
  ).all(...ids) as EmailMetadataRow[]
  const out: Record<string, EmailList_EmailListItem[]> = {}
  for (const row of rows) {
    const item = shapeListItem(row)
    const tid = item.thread_id
    if (tid === null || tid === undefined || tid === '') continue
    ;(out[tid] ??= []).push(item)
  }
  return out
}

export function listEmails(opts: ListOpts): EmailList_EmailListItem[] {
  const db = getDb()
  const where = buildListWhere(opts)
  // 前端 EmailList.MAX_PAGES * PAGE_SIZE = 3000, backend cap 必须 ≥ 它,
  // 否则 fetchLimit > 500 后 backend 截到 500 → all.length < fetchLimit
  // → reachedEnd 误判 true → 滚到底不再触发分页. SQLite 拿 3000 行 ~50ms,
  // IPC 序列化 ~100-200ms, 仍可接受.
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 3000)
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
  const mode: 'smart' | 'raw' = opts.mode ?? 'smart'
  // PR-2a: smart 模式按 CJK-aware 规则改写; 'raw' / 含 FTS5 special char 时 passthrough
  const effectiveQuery = mode === 'smart' ? smartQueryTransform(opts.query) : opts.query
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
      COALESCE(m.ai_priority,
        CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.priority') END
      ) AS priority_raw,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.language') END AS lang_raw
    FROM email_body_fts
    JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
    LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
    WHERE email_body_fts MATCH ?
    ${filterSql}
    ORDER BY rank ASC
    LIMIT ?`
  const rows = prep(db, sql).all(effectiveQuery, ...filterParams, limit) as SearchRow[]
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
  const result: SearchResult = { items, total_indexed, mode }
  if (effectiveQuery !== opts.query) {
    result.transformed_query = effectiveQuery
  }
  return result
}

// ---- Enriched list + mailbox + AI fields (renderer-only views) -------------

interface EnrichedRow extends EmailMetadataRow {
  // Sprint 19 perf — list query no longer reads the body_markdown blob for a
  // snippet (substr 仍要把整块 blob 读进内存; 800 行 → ~1.5s 阻塞同步主进程,
  // 列表/archive/全局卡顿主因). 改成只判断 body 行是否存在 (PK join, 不读 blob,
  // ~100ms), snippet 由 email:listSnippets 按可见行懒取。
  has_body_raw: number | null
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
  llm_model: string | null
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

// CASE WHEN json_valid(...) 守卫: labels_json 在罕见场景下会是 malformed JSON
// (LLM 输出超长被截断 / 写入路径异常), SQLite json_extract 遇到非法值会抛
// "malformed JSON" 整个 query 失败 → listEnriched 整页崩, 前端永远拉不到数据.
// 加 json_valid 包一层, 非法 row 返回 NULL (该行 AI 字段空着, 但不影响其他行).
const ENRICHED_EXTRA_COLS = `
    -- Sprint 19 perf: 不再 substr(body_markdown) (读整块 blob, 800 行 ~1.5s);
    -- 只判存在 (b.internal_id PK join, 不触 blob). snippet 走 email:listSnippets 懒取。
    (b.internal_id IS NOT NULL) AS has_body_raw,
    CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.language')   END AS lang_raw,
    -- v14: priority / action_type 走主表列 (走索引) + COALESCE fallback labels_json
    -- 兼容存量未 backfill 邮件. 全量 backfill 后 json_extract 路径可退役.
    COALESCE(m.ai_priority,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.priority') END
    ) AS priority_raw,
    COALESCE(m.ai_action,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.action_type') END
    ) AS action_raw,
    CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.category')   END AS category_raw,
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
    /\b(mailbox|sync_status|date_received|sender|subject|is_read|is_flagged|notion_page_id|internal_id)\b/g,
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
    // Sprint 19 — snippet 懒取 (email:listSnippets), 列表查询不再读 body blob。
    // has_body 立即可知, 用于 EmailList 行高 (避免 snippet 到达后行高跳变)。
    snippet: null,
    has_body: row.has_body_raw === 1,
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
  // 渲染层视图永不显示 skipped 邮件 — 两类: ① 发件箱里 AppleScript 时代
  // sent-box-unreachable 降级的遗留行 (davmail cutover 后发件箱不再同步,
  // 这些是陈旧死数据); ② 收件箱 pre-SYNC_START_DATE 日期过滤行。listMailboxes
  // 计数 SQL 同样 `sync_status != 'skipped'` (见该函数 + line 注释), 这里对齐
  // 避免「sidebar badge 358 但列表显示 1288」的口径错位 (用户反馈发件箱过滤不对)。
  // 仅当调用方没显式查某个 status 时附加, 保留显式 status 查询 (含查 skipped) 原义。
  const skippedGuard =
    opts.status === undefined
      ? where.sql.length === 0
        ? "WHERE m.sync_status != 'skipped'"
        : `${where.sql} AND m.sync_status != 'skipped'`
      : where.sql
  // 前端 EmailList.MAX_PAGES * PAGE_SIZE = 3000, backend cap 必须 ≥ 它,
  // 否则 fetchLimit > 500 后 backend 截到 500 → all.length < fetchLimit
  // → reachedEnd 误判 true → 滚到底不再触发分页. SQLite 拿 3000 行 ~50ms,
  // IPC 序列化 ~100-200ms, 仍可接受.
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 3000)
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
               ${skippedGuard}
               ORDER BY m.date_received DESC NULLS LAST, m.internal_id DESC
               LIMIT ? OFFSET ?`
  const rows = prep(db, sql).all(...where.params, limit, offset) as EnrichedRow[]
  return rows.map(shapeEnrichedItem)
}

/**
 * Sprint 19 — 按 internal_id 批量取正文 snippet (substr body_markdown 前 100 字)。
 * listEnriched 已不再读 body blob (~1.5s @800 行, 阻塞同步主进程), 前端改对
 * 【可见行】调本接口懒取 (~15-40 行 ~12ms), 列表秒出、卡顿消除。返回
 * {internal_id: snippet} map; 无 body / 空 snippet 的 id 不出现在 map 里。
 */
export function listEmailSnippets(
  internalIds: ReadonlyArray<number> | null | undefined
): Record<number, string> {
  if (!Array.isArray(internalIds)) return {}
  const ids = Array.from(
    new Set(internalIds.filter((n): n is number => Number.isInteger(n) && n >= 0))
  )
  if (ids.length === 0) return {}
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = prep(
    db,
    `SELECT internal_id, substr(body_markdown, 1, 100) AS snippet
       FROM email_body
      WHERE internal_id IN (${placeholders})`
  ).all(...ids) as Array<{ internal_id: number; snippet: string | null }>
  const out: Record<number, string> = {}
  for (const r of rows) {
    if (typeof r.snippet === 'string' && r.snippet.length > 0) out[r.internal_id] = r.snippet
  }
  return out
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
            (SELECT status     FROM llm_processing WHERE internal_id = ?) AS llm_status,
            (SELECT model      FROM llm_processing WHERE internal_id = ?) AS llm_model
       FROM email_metadata
      WHERE internal_id = ?`
  ).get(internalId, internalId, internalId, internalId) as AIFieldsRow | undefined
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
    // AI 模型/来源标识来自 llm_processing.model 列 (如 'claude-sonnet-4-6' /
    // 'external:notion'), 不在 labels_json — 头部右侧用它显示来源。
    ai_model: row.llm_model ?? null,
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
  ipcMain.handle('email:listByThreads', (_evt, threadIds: string[] | null) =>
    listEmailsByThreads(threadIds)
  )
  ipcMain.handle('email:listSnippets', (_evt, internalIds: number[] | null) =>
    listEmailSnippets(internalIds)
  )
  // v8 — listPinnedIds is a readonly SQLite SELECT, wired here. The
  // write path (email:pin / email:unpin) lives in write_ops.ts and forks
  // the `mailagent email pin / unpin` CLI per the renderer-readonly rule
  // (db.ts comment / REVIEW-LOG C-05).
  ipcMain.handle('email:listPinnedIds', () => listPinnedEmailIds())
}
