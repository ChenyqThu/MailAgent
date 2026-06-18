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
import {
  buildSearchPlan,
  buildStructuredFilterPredicates,
  buildTrigramSnippetExpr,
  countCjkChars,
  parseSearchQuery,
  routeTextTerm,
  type FilterPredicate,
  type ParsedSearchQuery,
  type TermRoute,
  type TextTerm
} from '@shared/lib/search_query_parser'
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
  /** Cross-language fixture injection; production omits both fields. */
  now?: string
  tzOffsetMinutes?: number
  /**
   * T7 CJK trigram 路由开关 (镜像 Python EmailRepository(trigram_enabled=))。
   * 仅 smart 模式 + plain-passthrough + query 含 CJK 时才接管 (走并行 trigram 表),
   * 否则落老 unicode61 路径 (P1 行为零回归)。
   * 默认从 process.env.SEARCH_TRIGRAM_ENABLED 读 (与后端同源 flag);
   * 夹具 runner 按 per-case 显式传入。
   */
  trigramEnabled?: boolean
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
  // T5 附件融合：fused 路径 SELECT 出命中来源 + 附件名；body-only / metadata
  // 路径的 SELECT 不含这两列，row 上为 undefined → shapeSearchHit 兜底 'body'/null。
  source?: string | null
  filename?: string | null
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

function shapeSearchHit(row: SearchRow): EmailSearch_SearchHit {
  return {
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
    lang: mapLanguage(row.lang_raw),
    source: row.source === 'attachment' ? 'attachment' : 'body',
    filename: row.source === 'attachment' ? (row.filename ?? null) : null
  }
}

// T5 RRF 融合常量 — 镜像 Python _RRF_K / _RRF_FETCH_*。
const RRF_K = 60.0
const RRF_FETCH_MULTIPLIER = 4
const RRF_FETCH_MIN_EXTRA = 50
const RRF_FETCH_MAX = 1000

interface FusedCandidate {
  row: SearchRow
  rrf_score: number
}

// 镜像 Python _date_sort_value：无值/解析失败给 ±inf（oldest 用 +inf 排末尾，
// 否则 -inf），否则 ISO→秒。Python / SQLite datetime() 把无时区的 naive 时间当
// UTC；而 V8 的 Date.parse 对 naive 时间按本地时区解释 —— 两端必须一致，否则
// sort:date/oldest 融合排序对存量混存时区数据边缘错位。修法：无时区信息
// （结尾无 Z / 无 ±HH:MM offset）→ 视为 UTC（空格转 T 后补 Z）；有时区信息 → 原样解析。
function dateSortValue(value: string | null | undefined, oldest: boolean): number {
  if (!value) return oldest ? Infinity : -Infinity
  const trimmed = value.trim()
  // 时区信息：结尾 Z，或结尾 ±HH:MM / ±HHMM offset。
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
  const normalized = hasTimezone ? trimmed : `${trimmed.replace(' ', 'T')}Z`
  const ms = Date.parse(normalized)
  if (Number.isNaN(ms)) return oldest ? Infinity : -Infinity
  return ms / 1000
}

// 镜像 Python _merge_search_rows_by_rrf：按 internal_id 去重，body 候选
// rrf=1/(60+n)、attachment 候选 rrf=1/(60+n)；同邮件 body+attachment 命中时
// rrf 叠加且保留 body 的 source/snippet/filename（attachment 命中已存在时 continue）。
// 最终 rank=-rrf_score，按 sort 排序后截断到 limit。
function mergeSearchRowsByRrf(
  bodyRows: SearchRow[],
  attachmentRows: SearchRow[],
  sort: string | undefined,
  limit: number
): EmailSearch_SearchHit[] {
  const combined = new Map<number, FusedCandidate>()
  const seenBody = new Set<number>()
  const seenAttachment = new Set<number>()

  for (const row of bodyRows) {
    const internalId = row.internal_id
    if (seenBody.has(internalId)) continue
    seenBody.add(internalId)
    combined.set(internalId, {
      row: { ...row, source: 'body', filename: null, snippet: row.snippet ?? '' },
      rrf_score: 1.0 / (RRF_K + seenBody.size)
    })
  }

  for (const row of attachmentRows) {
    const internalId = row.internal_id
    if (seenAttachment.has(internalId)) continue
    seenAttachment.add(internalId)
    const rrf = 1.0 / (RRF_K + seenAttachment.size)
    const existing = combined.get(internalId)
    if (existing) {
      existing.rrf_score += rrf
      continue
    }
    combined.set(internalId, {
      row: {
        ...row,
        source: 'attachment',
        filename: row.filename ?? null,
        snippet: row.snippet ?? ''
      },
      rrf_score: rrf
    })
  }

  const candidates = [...combined.values()]
  if (sort === 'date') {
    candidates.sort((a, b) => {
      const ad = dateSortValue(a.row.date_received, false)
      const bd = dateSortValue(b.row.date_received, false)
      if (ad !== bd) return bd - ad
      return b.rrf_score - a.rrf_score
    })
  } else if (sort === 'oldest') {
    candidates.sort((a, b) => {
      const ad = dateSortValue(a.row.date_received, true)
      const bd = dateSortValue(b.row.date_received, true)
      if (ad !== bd) return ad - bd
      return b.rrf_score - a.rrf_score
    })
  } else {
    candidates.sort((a, b) => {
      if (a.rrf_score !== b.rrf_score) return b.rrf_score - a.rrf_score
      const ad = dateSortValue(a.row.date_received, false)
      const bd = dateSortValue(b.row.date_received, false)
      return bd - ad
    })
  }

  return candidates
    .slice(0, limit)
    .map((item) => shapeSearchHit({ ...item.row, rank: -item.rrf_score }))
}

function quoteFtsValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

// T6 列级 FTS：列存在时把 payload 包成 FTS5 column filter（`subject : redis`）。
// 镜像 Python _text_term_to_fts / _text_term_to_fts_payload。
function textTermToFts(term: TextTerm): string {
  const expr = textTermToFtsPayload(term)
  if (term.column && expr) return `${term.column} : ${expr}`
  return expr
}

function textTermToFtsPayload(term: TextTerm): string {
  if (term.is_phrase || term.force_quoted || !isSimpleNaturalQuery(term.value)) {
    return quoteFtsValue(term.value)
  }
  return smartQueryTransform(term.value)
}

function buildFtsOrGroup(group: TextTerm[]): string {
  const parts = group.map(textTermToFts).filter((part) => part.length > 0)
  if (parts.length <= 1) return parts[0] ?? ''
  return `(${parts.map((part) => `(${part})`).join(' OR ')})`
}

// T8: term 是否限定到收件人表 (email_recipient_fts) 列。镜像 Python _is_recipient_term。
function isRecipientTerm(term: TextTerm): boolean {
  return term.columnTable === 'recipient'
}

// 单个收件人列 term 编译成 email_recipient_fts 的 MATCH 片段 `<col> : <expr>`。
// 注意用 payload（无列前缀）再手动拼列名，镜像 Python _recipient_match_expr
// （走 _text_term_to_fts_payload 而非 _text_term_to_fts）。
function recipientMatchExpr(term: TextTerm): string {
  const expr = textTermToFtsPayload(term)
  if (!expr || !term.column) return ''
  return `${term.column} : ${expr}`
}

// 该 term 是否要排出 email_body_fts MATCH expr: 收件人列 term 永远排除; P5 trigram
// 启用时裸 CJK 词也排除 (改走 trigram IN-子查询)。flag=false → 仅排收件人 (零回归)。
// 镜像 Python _exclude_from_body_match。
function excludeFromBodyMatch(term: TextTerm, trigramEnabled: boolean): boolean {
  if (isRecipientTerm(term)) return true
  if (trigramEnabled && termHasCjk(term)) return true
  return false
}

function buildPositiveFtsExpr(parsed: ParsedSearchQuery, trigramEnabled = false): string {
  // T8: 收件人列 term 不进 email_body_fts MATCH —— 它们走 email_recipient_fts 的
  // IN-子查询 AND 过滤 (见 buildRecipientPredicates)。P5: trigram 启用时裸 CJK 词也排除
  // (走 trigram IN-子查询)。镜像 Python _build_positive_fts_expr。
  const parts: string[] = []
  for (const term of parsed.fts_terms) {
    if (excludeFromBodyMatch(term, trigramEnabled)) continue
    parts.push(textTermToFts(term))
  }
  for (const group of parsed.fts_or_groups) {
    // OR 组里混入收件人列 term → 整组归 recipient 编译, 不进 body MATCH。
    if (group.some((term) => isRecipientTerm(term))) continue
    // P5: OR 组暂不路由 trigram (规格已注明限制) → 含 CJK 的 OR 组照旧走 unicode61。
    parts.push(buildFtsOrGroup(group))
  }
  return parts.filter((part) => part.length > 0).join(' AND ')
}

function buildNegativeFtsExpr(parsed: ParsedSearchQuery, trigramEnabled = false): string {
  const parts = parsed.neg_fts_terms
    .filter((term) => !excludeFromBodyMatch(term, trigramEnabled))
    .map(textTermToFts)
    .filter((part) => part.length > 0)
  return parts.map((part) => `(${part})`).join(' OR ')
}

// T8: 把收件人列 term 编译成 email_recipient_fts 的 IN-子查询 AND 谓词。
// - 正向 term / 全 recipient 的 OR 组 → m.internal_id IN (SELECT rowid ...)。
// - 负向 term → m.internal_id NOT IN (...) (每个负向收件人 term 各自一条 NOT IN)。
// graceful degrade: recipient_fts 表缺失 (旧库未迁移) → caller 的 try/catch 吞掉
// 该谓词 → 该 term 不约束结果 (不崩, 与 P1 附件 try/catch 同手法)。
// 镜像 Python _build_recipient_predicates。
function buildRecipientPredicates(parsed: ParsedSearchQuery): FilterPredicate[] {
  const predicates: FilterPredicate[] = []

  // 正向单 term。
  for (const term of parsed.fts_terms) {
    if (!isRecipientTerm(term)) continue
    const expr = recipientMatchExpr(term)
    if (!expr) continue
    predicates.push({
      sql:
        'm.internal_id IN (SELECT rowid FROM email_recipient_fts ' +
        'WHERE email_recipient_fts MATCH ?)',
      params: [expr]
    })
  }

  // 正向 OR 组 (全为收件人列 term)：组内 OR 进同一个 MATCH 表达式。
  for (const group of parsed.fts_or_groups) {
    if (!group.some((term) => isRecipientTerm(term))) continue
    const exprs = group.map(recipientMatchExpr).filter((e) => e.length > 0)
    if (exprs.length === 0) continue
    const matchExpr = exprs.map((e) => `(${e})`).join(' OR ')
    predicates.push({
      sql:
        'm.internal_id IN (SELECT rowid FROM email_recipient_fts ' +
        'WHERE email_recipient_fts MATCH ?)',
      params: [matchExpr]
    })
  }

  // 负向 term。
  for (const term of parsed.neg_fts_terms) {
    if (!isRecipientTerm(term)) continue
    const expr = recipientMatchExpr(term)
    if (!expr) continue
    predicates.push({
      sql:
        'm.internal_id NOT IN (SELECT rowid FROM email_recipient_fts ' +
        'WHERE email_recipient_fts MATCH ?)',
      params: [expr]
    })
  }

  return predicates
}

// ============================================================
// P5: parsed 路径里「正向/负向裸全文 CJK 词」也走 trigram (flag-gated)
// 镜像 Python _is_bare_fulltext_term / _term_has_cjk / _cjk_term_in_predicate /
// _build_cjk_trigram_predicates / _collect_cjk_term_warnings / _exclude_from_body_match。
//
// T7 之前只在 plain_passthrough query 启用 trigram; 一旦 query 带字段就走 parsed
// 路径, 裸 CJK 词退回 unicode61 前缀 MATCH, 匹配不到 CJK 串内部子串。修复: trigram
// 启用时把裸 CJK 词改成 trigram 表 IN/NOT-IN 子查询谓词 (与 from:/is:/date AND),
// 并把它们从 body MATCH expr 排除。flag=false → 不启用, parsed 路径逐字节不变 (零回归)。
// ============================================================

// 裸全文 term: 既非 T6 列词 (columnTable='body') 也非 T8 收件人词。
function isBareFulltextTerm(term: TextTerm): boolean {
  return term.column == null && term.columnTable == null
}

function termHasCjk(term: TextTerm): boolean {
  return isBareFulltextTerm(term) && countCjkChars(term.value) > 0
}

// 把一个裸 CJK term 编译成 IN / NOT IN 子查询谓词 (term 内多段 AND)。段路由复用
// routeTextTerm (与 plain trigram 路径同一份分类语义)。无可查段 (整词 1 字 CJK) →
// 返回 null (caller 跳过)。镜像 Python _cjk_term_in_predicate。
function cjkTermInPredicate(term: TextTerm, negate: boolean): FilterPredicate | null {
  const route = routeTextTerm(term.value, smartQueryTransform)
  if (route.route === 'too_short') return null

  const inKw = negate ? 'NOT IN' : 'IN'
  const sqlParts: string[] = []
  const params: unknown[] = []
  for (const latin of route.latinSegments) {
    const expr = smartQueryTransform(latin)
    if (!expr) continue
    sqlParts.push(
      `m.internal_id ${inKw} (SELECT rowid FROM email_body_fts ` + `WHERE email_body_fts MATCH ?)`
    )
    params.push(expr)
  }
  for (const seg of route.cjkSegments) {
    if (seg.route === 'trigram_match') {
      sqlParts.push(
        `m.internal_id ${inKw} (SELECT rowid FROM email_body_fts_trigram ` +
          `WHERE email_body_fts_trigram MATCH ?)`
      )
      params.push(seg.value)
    } else if (seg.route === 'trigram_like') {
      const like = `%${seg.value}%`
      sqlParts.push(
        `m.internal_id ${inKw} (SELECT rowid FROM email_body_fts_trigram ` +
          `WHERE body_markdown LIKE ? OR subject LIKE ? OR sender LIKE ?)`
      )
      params.push(like, like, like)
    }
  }
  if (sqlParts.length === 0) return null
  return { sql: sqlParts.join(' AND '), params }
}

// trigram 启用时, 把 parsed 路径的独立裸 CJK 词编译成 trigram IN/NOT-IN 谓词。
// OR 组含 CJK 暂不在此路由 (规格已注明限制)。镜像 Python _build_cjk_trigram_predicates。
function buildCjkTrigramPredicates(parsed: ParsedSearchQuery): FilterPredicate[] {
  const predicates: FilterPredicate[] = []
  for (const term of parsed.fts_terms) {
    if (!termHasCjk(term)) continue
    const pred = cjkTermInPredicate(term, false)
    if (pred) predicates.push(pred)
  }
  for (const term of parsed.neg_fts_terms) {
    if (!termHasCjk(term)) continue
    const pred = cjkTermInPredicate(term, true)
    if (pred) predicates.push(pred)
  }
  return predicates
}

// 收集 parsed 路径裸 CJK 词的 1 字拦截 warning (cjk_too_short:<字>)。
// 镜像 Python _collect_cjk_term_warnings。
function collectCjkTermWarnings(parsed: ParsedSearchQuery): string[] {
  const warnings: string[] = []
  for (const term of [...parsed.fts_terms, ...parsed.neg_fts_terms]) {
    if (!termHasCjk(term)) continue
    warnings.push(...routeTextTerm(term.value, smartQueryTransform).warnings)
  }
  return warnings
}

// 把所有正向收件人列 term 合成一条 email_recipient_fts MATCH 表达式 (AND 连接)。
// 供 recipient-only 路径直接对 email_recipient_fts MATCH 取 bm25 排名。
// 单 term → (`<col> : <expr>`)；全 recipient 的 OR 组 → ((c1:e1) OR (c2:e2))。
// 无正向收件人 term → 空串 (caller 不走 recipient-only 路径)。
// 镜像 Python _build_positive_recipient_fts_expr。
function buildPositiveRecipientFtsExpr(parsed: ParsedSearchQuery): string {
  const parts: string[] = []
  for (const term of parsed.fts_terms) {
    if (!isRecipientTerm(term)) continue
    const expr = recipientMatchExpr(term)
    if (expr) parts.push(`(${expr})`)
  }
  for (const group of parsed.fts_or_groups) {
    if (!group.some((term) => isRecipientTerm(term))) continue
    const exprs = group.map(recipientMatchExpr).filter((e) => e.length > 0)
    if (exprs.length > 0) parts.push('(' + exprs.map((e) => `(${e})`).join(' OR ') + ')')
  }
  return parts.join(' AND ')
}

// T5 附件融合：附件 FTS 表只索引 text_content（无 subject/sender 列），故附件分支
// 只用未限定列的裸全文词（column===null）构造 MATCH；AND 连接。
// 镜像 Python _build_attachment_positive_fts_expr。
function buildAttachmentPositiveFtsExpr(parsed: ParsedSearchQuery): string {
  const parts: string[] = []
  for (const term of parsed.fts_terms) {
    if (term.column == null) parts.push(textTermToFtsPayload(term))
  }
  for (const group of parsed.fts_or_groups) {
    if (group.every((term) => term.column == null)) parts.push(buildFtsOrGroup(group))
  }
  return parts.filter((part) => part.length > 0).join(' AND ')
}

// 列级正向词在附件分支没有对应列，转而作为 email_body_fts 门控（body gate）。
// T8: 收件人列 term (email_recipient_fts) 不是 body 列 → 排除出 body gate
// (它们在 metadata_predicates 里以独立 IN-子查询约束附件命中)。
// 镜像 Python _build_attachment_body_gate_expr。
function buildAttachmentBodyGateExpr(parsed: ParsedSearchQuery): string {
  const parts: string[] = []
  for (const term of parsed.fts_terms) {
    if (term.column != null && !isRecipientTerm(term)) parts.push(textTermToFts(term))
  }
  for (const group of parsed.fts_or_groups) {
    if (group.length > 0 && group.every((term) => term.column != null && !isRecipientTerm(term))) {
      parts.push(buildFtsOrGroup(group))
    }
  }
  return parts.filter((part) => part.length > 0).join(' AND ')
}

// 镜像 Python _build_attachment_negative_fts_expr（只用裸词，OR 连接）。
function buildAttachmentNegativeFtsExpr(parsed: ParsedSearchQuery): string {
  const parts: string[] = []
  for (const term of parsed.neg_fts_terms) {
    if (term.column == null) parts.push(textTermToFtsPayload(term))
  }
  return parts
    .filter((part) => part.length > 0)
    .map((part) => `(${part})`)
    .join(' OR ')
}

function compileOrFilterGroups(groups: FilterPredicate[][]): FilterPredicate[] {
  const predicates: FilterPredicate[] = []
  for (const group of groups) {
    const sqlParts: string[] = []
    const params: unknown[] = []
    for (const predicate of group) {
      sqlParts.push(`(${predicate.sql})`)
      params.push(...predicate.params)
    }
    if (sqlParts.length > 0) predicates.push({ sql: sqlParts.join(' OR '), params })
  }
  return predicates
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

// 草稿 mailbox 值（落库统一 '草稿箱'；'草稿'/'Drafts' 是 _STANDARD_MAILBOXES
// 的历史别名，保险一并排除）。线程兄弟查询 + 未指定 mailbox 的列表都用它。
// ⚠️ IS NULL 豁免必须带上：SQL 三值逻辑里 `NULL NOT IN (...)` 不成立，少了它
// 历史 mailbox=NULL 行会从所有跨邮箱读面静默消失（codex review MEDIUM）。
const DRAFTS_EXCLUDE_SQL = "(mailbox IS NULL OR mailbox NOT IN ('草稿箱', '草稿', 'Drafts'))"

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
  } else {
    // 未指定 mailbox (= 「所有邮件」/ 跨邮箱视图) 排除草稿：未发出的内容
    // 不混入邮件流（用户验收）。要草稿就显式 mailbox='草稿箱'（草稿箱视图）。
    // serve-api email_views.py 同语义镜像。
    clauses.push(DRAFTS_EXCLUDE_SQL)
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
        AND ${DRAFTS_EXCLUDE_SQL}
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
        AND ${DRAFTS_EXCLUDE_SQL}
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

// ============================================================
// T7: CJK trigram 路由执行 (仅 trigram flag + smart plain-passthrough + 含 CJK)
// 镜像 Python _search_email_bodies_trigram 全套。英文 / 列级 FTS / 附件融合不在此
// 路径 (那些走老 fast-path), 故 P1 行为零回归。
// ============================================================

// 对 FTS5 表 (email_body_fts / email_body_fts_trigram) MATCH, 返回 bm25 升序 rowid。
// 镜像 Python _fts_match_ids。
function trigramFtsMatchIds(db: Database, table: string, ftsExpr: string): number[] {
  if (!ftsExpr) return []
  const sql = `SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) ASC`
  try {
    const rows = prep(db, sql).all(ftsExpr) as Array<{ rowid: number }>
    return rows.map((r) => r.rowid)
  } catch (err) {
    console.warn(`[email:search] invalid ${table} MATCH`, ftsExpr, err)
    return []
  }
}

// 2 字 CJK: trigram 表 body/subject/sender LIKE '%词%' 兜底 (MATCH <3 无召回)。
// 无 bm25, 启发式排序: subject 命中 > sender 命中 > body 命中, 同档按 rowid DESC。
// 镜像 Python _trigram_like_ids。
function trigramLikeIds(db: Database, value: string): number[] {
  const like = `%${value}%`
  const sql = `
    SELECT rowid,
           CASE
               WHEN subject LIKE ? THEN 0
               WHEN sender  LIKE ? THEN 1
               ELSE 2
           END AS boost
      FROM email_body_fts_trigram
     WHERE body_markdown LIKE ? OR subject LIKE ? OR sender LIKE ?
     ORDER BY boost ASC, rowid DESC`
  try {
    const rows = prep(db, sql).all(like, like, like, like, like) as Array<{ rowid: number }>
    return rows.map((r) => r.rowid)
  } catch (err) {
    console.warn('[email:search] trigram LIKE fallback failed', value, err)
    return []
  }
}

// 单个 term 的有序候选 internal_id 列表 (镜像 Python _trigram_term_candidate_ids)。
// - route='unicode': 主表 email_body_fts MATCH (unicodeExpr), bm25 升序。
// - route='trigram': latin 段走 email_body_fts MATCH; CJK 段走 trigram 表 (>=3 MATCH / =2 LIKE)。
//   同 term 多段 AND (交集), 以首段顺序为基准。
function trigramTermCandidateIds(
  db: Database,
  route: TermRoute,
  smartTransform: (q: string) => string
): number[] {
  if (route.route === 'unicode') {
    return trigramFtsMatchIds(db, 'email_body_fts', route.unicodeExpr)
  }

  // trigram term: 收集各段候选, 段间 AND。
  const segmentLists: number[][] = []
  for (const latin of route.latinSegments) {
    segmentLists.push(trigramFtsMatchIds(db, 'email_body_fts', smartTransform(latin)))
  }
  for (const seg of route.cjkSegments) {
    if (seg.route === 'trigram_match') {
      segmentLists.push(trigramFtsMatchIds(db, 'email_body_fts_trigram', seg.value))
    } else if (seg.route === 'trigram_like') {
      segmentLists.push(trigramLikeIds(db, seg.value))
    }
  }

  if (segmentLists.length === 0) return []
  // 段间 AND: 以第一个段的顺序为基准, 仅保留出现在所有段的 id。
  let common = new Set(segmentLists[0]!)
  for (const lst of segmentLists.slice(1)) {
    const next = new Set(lst)
    common = new Set([...common].filter((iid) => next.has(iid)))
  }
  if (common.size === 0) return []
  return segmentLists[0]!.filter((iid) => common.has(iid))
}

// 在 email_metadata 上对候选 id 套结构化谓词 (mailbox / date), 返回允许集。
// 镜像 Python _filter_ids_by_metadata。
function trigramFilterIdsByMetadata(
  db: Database,
  ids: Set<number>,
  predicates: FilterPredicate[]
): Set<number> {
  if (ids.size === 0) return new Set()
  if (predicates.length === 0) return new Set(ids)
  const idList = [...ids]
  const placeholders = idList.map(() => '?').join(',')
  let sql = `SELECT m.internal_id FROM email_metadata m WHERE m.internal_id IN (${placeholders})`
  const params: unknown[] = [...idList]
  for (const predicate of predicates) {
    sql += ` AND (${predicate.sql})`
    params.push(...predicate.params)
  }
  const rows = prep(db, sql).all(...params) as Array<{ internal_id: number }>
  return new Set(rows.map((r) => r.internal_id))
}

// 给 top-N trigram 命中生成 snippet (高亮 + fallback)。镜像 Python _build_trigram_snippets。
// ① snippet 表达式非空 → email_body_fts_trigram MATCH + rowid IN top 取 snippet() 高亮片段。
// ② 表达式为空, 或某 id 未被 ① 命中 (只 2 字 LIKE 命中) → fallback: body_markdown 前 ~80 字符。
// snippet() 只能在带 MATCH 的查询里用; fallback 摘要不经 snippet()。
function buildTrigramSnippets(
  db: Database,
  topIds: number[],
  routes: TermRoute[]
): Map<number, string> {
  const result = new Map<number, string>()
  if (topIds.length === 0) return result
  const expr = buildTrigramSnippetExpr(routes)
  if (expr) {
    const placeholders = topIds.map(() => '?').join(',')
    const sql = `SELECT rowid,
                        snippet(email_body_fts_trigram, 0, '<mark>', '</mark>', '…', 24) AS snippet
                   FROM email_body_fts_trigram
                  WHERE rowid IN (${placeholders}) AND email_body_fts_trigram MATCH ?`
    try {
      const rows = prep(db, sql).all(...topIds, expr) as Array<{
        rowid: number
        snippet: string | null
      }>
      for (const r of rows) {
        if (r.snippet) result.set(r.rowid, r.snippet)
      }
    } catch (err) {
      console.warn('[email:search] trigram snippet MATCH failed', expr, err)
    }
  }

  const missing = topIds.filter((iid) => !result.has(iid))
  if (missing.length > 0) {
    const placeholders = missing.map(() => '?').join(',')
    const rows = prep(
      db,
      `SELECT rowid, body_markdown FROM email_body_fts_trigram WHERE rowid IN (${placeholders})`
    ).all(...missing) as Array<{ rowid: number; body_markdown: string | null }>
    for (const r of rows) {
      result.set(r.rowid, (r.body_markdown ?? '').slice(0, 80))
    }
  }
  return result
}

// 按 RRF 分数 + date 排序取 top-N, 查 metadata 拼 hit。
// rank = -rrf_score (越小越相关), snippet 由 buildTrigramSnippets 生成 (高亮 + fallback)。
// 镜像 Python _build_trigram_hits。
function buildTrigramHits(
  db: Database,
  rrfScores: Map<number, number>,
  limit: number,
  routes: TermRoute[]
): EmailSearch_SearchHit[] {
  if (rrfScores.size === 0) return []
  const idList = [...rrfScores.keys()]
  const placeholders = idList.map(() => '?').join(',')
  const rows = prep(
    db,
    `SELECT internal_id,
            COALESCE(subject, '') AS subject,
            COALESCE(sender, '')  AS sender,
            date_received, mailbox, notion_page_id
       FROM email_metadata
      WHERE internal_id IN (${placeholders})`
  ).all(...idList) as Array<{
    internal_id: number
    subject: string
    sender: string
    date_received: string | null
    mailbox: string | null
    notion_page_id: string | null
  }>
  const metaById = new Map(rows.map((r) => [r.internal_id, r]))

  // Python sort key = (rrf_score, dateSortValue(oldest=False)), reverse=True →
  // rrf_score DESC, 再 date DESC。缺 metadata 行的 date 视为 -inf (排末尾)。
  const ordered = [...rrfScores.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1]
    const ad = dateSortValue(metaById.get(a[0])?.date_received, false)
    const bd = dateSortValue(metaById.get(b[0])?.date_received, false)
    return bd - ad
  })
  const top = ordered.slice(0, limit).filter(([iid]) => metaById.has(iid))
  const topIds = top.map(([iid]) => iid)
  const snippetById = buildTrigramSnippets(db, topIds, routes)

  const hits: EmailSearch_SearchHit[] = []
  for (const [iid, score] of top) {
    const r = metaById.get(iid)!
    hits.push(
      shapeSearchHit({
        internal_id: iid,
        subject: r.subject,
        sender: r.sender,
        date_received: r.date_received,
        mailbox: r.mailbox,
        rank: -score,
        snippet: snippetById.get(iid) ?? '',
        notion_page_id: r.notion_page_id,
        priority_raw: null,
        lang_raw: null,
        source: 'body',
        filename: null
      })
    )
  }
  return hits
}

/**
 * 裸全文 query 的 CJK trigram 路由 (镜像 Python _search_email_bodies_trigram)。
 * 返回 null = 不接管, 回退老 unicode fast-path; 返回 hits (含空数组) = 接管。
 * 与 Python 一致: routes 为空 (全部 term too_short) → 返回空结果 (非 null), warning 透传。
 */
function searchEmailBodiesTrigram(
  db: Database,
  query: string,
  structuredPredicates: FilterPredicate[],
  parseWarnings: string[],
  limit: number
): EmailSearch_SearchHit[] {
  const terms = query.split(/\s+/).filter((t) => t.length > 0)
  const { routes, warnings: planWarnings } = buildSearchPlan(terms, smartQueryTransform)
  // plan warning 透传 (cjk_too_short:<词> 等)。parseWarnings 由 caller 维护 (含结构化)。
  parseWarnings.push(...planWarnings)

  // 全部 term 被拦截 (例如纯单字 CJK query '我') → 不查, 返回空 + warning。
  if (routes.length === 0) return []

  // 每个 term 一个有序候选 internal_id 列表 (rank 用 list 内位置算 RRF)。
  const perTermIds: number[][] = []
  for (const route of routes) {
    const ids = trigramTermCandidateIds(db, route, smartQueryTransform)
    if (ids.length === 0) return [] // 任一 term 无候选 → AND 交集为空。
    perTermIds.push(ids)
  }

  // AND 交集 (rowid 必须出现在每个 term 的候选集里)。
  let common = new Set(perTermIds[0]!)
  for (const ids of perTermIds.slice(1)) {
    const next = new Set(ids)
    common = new Set([...common].filter((iid) => next.has(iid)))
  }
  if (common.size === 0) return []

  // metadata 过滤 (mailbox / date)。
  const allowed = trigramFilterIdsByMetadata(db, common, structuredPredicates)
  if (allowed.size === 0) return []

  // RRF 融合: 每个 term 列表里命中的 id 贡献 1/(k + rank)。
  const rrfScores = new Map<number, number>()
  for (const ids of perTermIds) {
    let rank = 0
    for (const iid of ids) {
      if (!allowed.has(iid)) continue
      rank += 1
      rrfScores.set(iid, (rrfScores.get(iid) ?? 0) + 1.0 / (RRF_K + rank))
    }
  }

  return buildTrigramHits(db, rrfScores, limit, routes)
}

export function searchEmails(opts: SearchOpts): SearchResult {
  const total_indexed = getEmailBodyFtsCount()
  if (!opts.query || opts.query.trim().length === 0) {
    return { items: [], total_indexed }
  }
  const mode: 'smart' | 'raw' = opts.mode ?? 'smart'
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)

  const structured = buildStructuredFilterPredicates({
    mailbox: opts.mailbox,
    sinceDate: opts.since,
    untilDate: opts.until,
    now: opts.now,
    tzOffsetMinutes: opts.tzOffsetMinutes
  })
  const parseWarnings: string[] = [...structured.warnings]

  // FTS5 bm25 returns negative scores where smaller (more negative) = more
  // relevant. We re-emit the value as-is per email-search.schema.json
  // convention ("bm25 score - 越小越相关").
  //
  // Search-module 1:1 mockup-search.html — LEFT JOIN llm_processing pulls
  // priority + language out of labels_json so the palette EmailHitRow
  // renders priority chip + lang-pip without a per-hit follow-up IPC.
  // LEFT (not INNER) so emails the LLM hasn't classified yet still appear
  // — those land with null priority + 'unknown' lang.
  const runFtsSearch = (
    effectiveQuery: string,
    filters: FilterPredicate[],
    negFtsExpr?: string,
    sort?: string
  ): EmailSearch_SearchHit[] => {
    let sql = `
    SELECT
      m.internal_id           AS internal_id,
      m.subject               AS subject,
      m.sender                AS sender,
      m.date_received         AS date_received,
      m.mailbox               AS mailbox,
      bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank,
      snippet(email_body_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
      m.notion_page_id        AS notion_page_id,
      COALESCE(m.ai_priority,
        CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.priority') END
      ) AS priority_raw,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.language') END AS lang_raw
    FROM email_body_fts
    JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
    LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
    WHERE email_body_fts MATCH ?`
    const params: unknown[] = [effectiveQuery]
    for (const predicate of filters) {
      sql += ` AND (${predicate.sql})`
      params.push(...predicate.params)
    }
    if (negFtsExpr) {
      sql +=
        ' AND m.internal_id NOT IN (' +
        'SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)'
      params.push(negFtsExpr)
    }
    const orderBy =
      sort === 'date'
        ? 'ORDER BY datetime(m.date_received) DESC'
        : sort === 'oldest'
          ? 'ORDER BY datetime(m.date_received) ASC'
          : 'ORDER BY rank ASC, datetime(m.date_received) DESC'
    sql += `
    ${orderBy}
    LIMIT ?`
    params.push(limit)
    try {
      const rows = prep(db, sql).all(...params) as SearchRow[]
      return rows.map(shapeSearchHit)
    } catch (err) {
      console.warn('[email:search] invalid FTS5 query', effectiveQuery, err)
      return []
    }
  }

  // T8 recipient-only 排名路径: FROM email_recipient_fts MATCH + JOIN metadata。
  // bm25 升序 (最相关在前) + date_received DESC tie-break。snippet 留空 (收件人命中
  // 不产正文 snippet, 前端按 body 兜底)。graceful degrade: email_recipient_fts 表缺失
  // (旧库未迁移) → MATCH 抛 → try/catch 接住 → 返回 [] (与 P1 附件 try/catch 同手法)。
  // 镜像 Python _search_recipient_fts_ranked。
  const runRecipientFtsRanked = (
    recipientFtsExpr: string,
    metadataPredicates: FilterPredicate[],
    negBodyFtsExpr: string
  ): EmailSearch_SearchHit[] => {
    if (!recipientFtsExpr || limit <= 0) return []
    let sql = `
    SELECT
      m.internal_id           AS internal_id,
      COALESCE(m.subject, '') AS subject,
      COALESCE(m.sender, '')  AS sender,
      m.date_received         AS date_received,
      m.mailbox               AS mailbox,
      m.notion_page_id        AS notion_page_id,
      ''                      AS snippet,
      bm25(email_recipient_fts) AS rank
    FROM email_recipient_fts
    JOIN email_metadata m ON m.internal_id = email_recipient_fts.rowid
    WHERE email_recipient_fts MATCH ?`
    const params: unknown[] = [recipientFtsExpr]
    for (const predicate of metadataPredicates) {
      sql += ` AND (${predicate.sql})`
      params.push(...predicate.params)
    }
    if (negBodyFtsExpr) {
      sql +=
        ' AND m.internal_id NOT IN (' +
        'SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)'
      params.push(negBodyFtsExpr)
    }
    // sort:date / sort:oldest 不会进这条路径 (caller 已判 sort∉{date,oldest})；
    // 这里恒按 bm25 相关度排，date DESC tie-break。镜像 Python ORDER BY rank, date DESC。
    sql += ' ORDER BY rank ASC, datetime(m.date_received) DESC LIMIT ?'
    params.push(limit)
    try {
      const rows = prep(db, sql).all(...params) as SearchRow[]
      return rows.map((row) =>
        shapeSearchHit({
          ...row,
          priority_raw: null,
          lang_raw: null,
          source: 'body',
          filename: null
        })
      )
    } catch (err) {
      console.warn(
        '[email:search] recipient FTS unavailable or invalid query',
        recipientFtsExpr,
        err
      )
      return []
    }
  }

  const runMetadataSearch = (
    filters: FilterPredicate[],
    negFtsExpr?: string,
    sort?: string
  ): EmailSearch_SearchHit[] => {
    let sql = `
    SELECT
      m.internal_id           AS internal_id,
      m.subject               AS subject,
      m.sender                AS sender,
      m.date_received         AS date_received,
      m.mailbox               AS mailbox,
      0.0                     AS rank,
      ''                      AS snippet,
      m.notion_page_id        AS notion_page_id,
      COALESCE(m.ai_priority,
        CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.priority') END
      ) AS priority_raw,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.language') END AS lang_raw
    FROM email_metadata m
    LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
    WHERE 1 = 1`
    const params: unknown[] = []
    for (const predicate of filters) {
      sql += ` AND (${predicate.sql})`
      params.push(...predicate.params)
    }
    if (negFtsExpr) {
      sql +=
        ' AND m.internal_id NOT IN (' +
        'SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)'
      params.push(negFtsExpr)
    }
    const orderBy =
      sort === 'oldest'
        ? 'ORDER BY datetime(m.date_received) ASC'
        : 'ORDER BY datetime(m.date_received) DESC'
    sql += `
    ${orderBy}
    LIMIT ?`
    params.push(limit)
    try {
      const rows = prep(db, sql).all(...params) as SearchRow[]
      return rows.map(shapeSearchHit)
    } catch (err) {
      console.warn('[email:search] invalid FTS5 query', negFtsExpr, err)
      return []
    }
  }

  // ---- T5 附件融合搜索（镜像 Python _search_email_bodies_fused 全套）----------
  // body FTS + attachment FTS 两路候选各取 candidate window，按 email 级 RRF
  // (k=60) 融合去重。对外 rank=-rrf_score 保持「越小越相关」直觉。

  const ftsBranchOrderBy = (sort?: string): string => {
    if (sort === 'date') return 'datetime(m.date_received) DESC'
    if (sort === 'oldest') return 'datetime(m.date_received) ASC'
    return 'rank ASC, datetime(m.date_received) DESC'
  }

  const fetchBodyFtsRows = (
    ftsExpr: string,
    filters: FilterPredicate[],
    negBodyFtsExpr: string,
    sort: string | undefined,
    candidateLimit: number
  ): SearchRow[] => {
    let sql = `
    SELECT
      m.internal_id           AS internal_id,
      m.subject               AS subject,
      m.sender                AS sender,
      m.date_received         AS date_received,
      m.mailbox               AS mailbox,
      bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank,
      snippet(email_body_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
      m.notion_page_id        AS notion_page_id,
      'body'                  AS source,
      NULL                    AS filename,
      COALESCE(m.ai_priority,
        CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.priority') END
      ) AS priority_raw,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.language') END AS lang_raw
    FROM email_body_fts
    JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
    LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
    WHERE email_body_fts MATCH ?`
    const params: unknown[] = [ftsExpr]
    for (const predicate of filters) {
      sql += ` AND (${predicate.sql})`
      params.push(...predicate.params)
    }
    if (negBodyFtsExpr) {
      sql +=
        ' AND m.internal_id NOT IN (' +
        'SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)'
      params.push(negBodyFtsExpr)
    }
    sql += ` ORDER BY ${ftsBranchOrderBy(sort)} LIMIT ?`
    params.push(candidateLimit)
    try {
      return prep(db, sql).all(...params) as SearchRow[]
    } catch (err) {
      console.warn('[email:search] invalid body FTS5 query', ftsExpr, err)
      return []
    }
  }

  const fetchAttachmentFtsRows = (
    ftsExpr: string,
    filters: FilterPredicate[],
    bodyGateFtsExpr: string,
    negBodyFtsExpr: string,
    negAttachmentFtsExpr: string,
    sort: string | undefined,
    candidateLimit: number
  ): SearchRow[] => {
    let sql = `
    SELECT
      m.internal_id           AS internal_id,
      m.subject               AS subject,
      m.sender                AS sender,
      m.date_received         AS date_received,
      m.mailbox               AS mailbox,
      bm25(email_attachment_fts) AS rank,
      snippet(email_attachment_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
      m.notion_page_id        AS notion_page_id,
      'attachment'            AS source,
      COALESCE(a.filename, '') AS filename,
      COALESCE(m.ai_priority,
        CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.priority') END
      ) AS priority_raw,
      CASE WHEN json_valid(l.labels_json) THEN json_extract(l.labels_json, '$.language') END AS lang_raw
    FROM email_attachment_fts
    JOIN email_attachment a ON a.id = email_attachment_fts.rowid
    JOIN email_metadata m ON m.internal_id = a.internal_id
    LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
    WHERE email_attachment_fts MATCH ?`
    const params: unknown[] = [ftsExpr]
    for (const predicate of filters) {
      sql += ` AND (${predicate.sql})`
      params.push(...predicate.params)
    }
    if (bodyGateFtsExpr) {
      sql +=
        ' AND m.internal_id IN (' + 'SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)'
      params.push(bodyGateFtsExpr)
    }
    if (negBodyFtsExpr) {
      sql +=
        ' AND m.internal_id NOT IN (' +
        'SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)'
      params.push(negBodyFtsExpr)
    }
    if (negAttachmentFtsExpr) {
      sql +=
        ' AND a.id NOT IN (' +
        'SELECT rowid FROM email_attachment_fts WHERE email_attachment_fts MATCH ?)'
      params.push(negAttachmentFtsExpr)
    }
    sql += ` ORDER BY ${ftsBranchOrderBy(sort)} LIMIT ?`
    params.push(candidateLimit)
    try {
      return prep(db, sql).all(...params) as SearchRow[]
    } catch (err) {
      console.warn('[email:search] attachment FTS unavailable or invalid query', ftsExpr, err)
      return []
    }
  }

  const runFusedSearch = (
    bodyFtsExpr: string,
    attachmentFtsExpr: string,
    filters: FilterPredicate[],
    negBodyFtsExpr: string,
    negAttachmentFtsExpr: string,
    attachmentBodyGateExpr: string,
    sort?: string
  ): EmailSearch_SearchHit[] => {
    if (!bodyFtsExpr || limit <= 0) return []
    const candidateLimit = Math.min(
      Math.max(limit * RRF_FETCH_MULTIPLIER, limit + RRF_FETCH_MIN_EXTRA),
      RRF_FETCH_MAX
    )
    const bodyRows = fetchBodyFtsRows(bodyFtsExpr, filters, negBodyFtsExpr, sort, candidateLimit)
    const attachmentRows = attachmentFtsExpr
      ? fetchAttachmentFtsRows(
          attachmentFtsExpr,
          filters,
          attachmentBodyGateExpr,
          negBodyFtsExpr,
          negAttachmentFtsExpr,
          sort,
          candidateLimit
        )
      : []
    return mergeSearchRowsByRrf(bodyRows, attachmentRows, sort, limit)
  }

  let items: EmailSearch_SearchHit[]
  let transformedQuery = opts.query

  if (mode === 'raw') {
    items = runFtsSearch(opts.query, structured.predicates)
  } else {
    const parsed = parseSearchQuery(opts.query, {
      now: opts.now,
      tzOffsetMinutes: opts.tzOffsetMinutes
    })
    parseWarnings.unshift(...parsed.warnings)

    // T7: flag=True 且 smart plain-passthrough query 含 CJK → 走 trigram 路由 (CJK 子串增强)。
    // flag=False 或纯非 CJK → 落入下面老 unicode61 fast-path (逐字节零回归)。
    // 镜像 Python search_email_bodies_with_meta 里 plain_passthrough 分支的 trigram 接入。
    const trigramEnabled = opts.trigramEnabled ?? process.env.SEARCH_TRIGRAM_ENABLED === 'true'
    if (parsed.is_plain_passthrough && trigramEnabled && countCjkChars(opts.query) > 0) {
      // trigram 路由接管 (含空结果): plan warning 透传, transformed_query 留原 query。
      items = searchEmailBodiesTrigram(db, opts.query, structured.predicates, parseWarnings, limit)
    } else if (parsed.is_plain_passthrough) {
      // smart plain-passthrough：附件维度复用 transformed（镜像 Python smart 入口
      // _search_email_bodies_fused(body=transformed, attachment=transformed)）。
      transformedQuery = smartQueryTransform(opts.query)
      items = runFusedSearch(transformedQuery, transformedQuery, structured.predicates, '', '', '')
    } else {
      const ftsExpr = buildPositiveFtsExpr(parsed, trigramEnabled)
      const negFtsExpr = buildNegativeFtsExpr(parsed, trigramEnabled)
      // T8: 收件人列 term (to~:/cc~:/from~:) 编译成 email_recipient_fts 的 IN-子查询谓词;
      // 正向排名表达式给 recipient-only 路径用。镜像 Python recipient_predicates /
      // positive_recipient_expr。
      const recipientPredicates = buildRecipientPredicates(parsed)
      // P5: trigram 启用时, parsed 路径里的裸 CJK 词编译成 trigram IN/NOT-IN 谓词
      // (与 from:/is:/date AND); 同步收 1 字 CJK 拦截 warning。flag=false → 空。
      // 镜像 Python _build_cjk_trigram_predicates / _collect_cjk_term_warnings。
      const cjkTrigramPredicates = trigramEnabled ? buildCjkTrigramPredicates(parsed) : []
      if (trigramEnabled) parseWarnings.push(...collectCjkTermWarnings(parsed))
      const positiveRecipientExpr = buildPositiveRecipientFtsExpr(parsed)
      const negFiltersCompiled: FilterPredicate[] = parsed.neg_filters.map((predicate) => ({
        sql: `NOT (${predicate.sql})`,
        params: predicate.params
      }))
      const filters: FilterPredicate[] = [
        ...parsed.filters,
        ...compileOrFilterGroups(parsed.or_filter_groups),
        ...structured.predicates,
        ...recipientPredicates,
        ...cjkTrigramPredicates,
        ...negFiltersCompiled
      ]

      if (!ftsExpr && !negFtsExpr && filters.length === 0) {
        items = []
      } else if (ftsExpr) {
        // 有正向全文词 → fused（body + attachment）。附件正向 expr 只含裸词，
        // 列级词转为 body gate；neg 双路。recipient 列词以 IN-子查询谓词进 filters。
        // 镜像 Python fts 分支。
        transformedQuery = ftsExpr
        items = runFusedSearch(
          ftsExpr,
          buildAttachmentPositiveFtsExpr(parsed),
          filters,
          negFtsExpr,
          buildAttachmentNegativeFtsExpr(parsed),
          buildAttachmentBodyGateExpr(parsed),
          parsed.sort
        )
      } else if (positiveRecipientExpr && parsed.sort !== 'date' && parsed.sort !== 'oldest') {
        // T8 recipient-only 路径: 无正文裸词/列词, 但有正向收件人列 term → 直接查
        // email_recipient_fts MATCH 取 bm25 排名 (recipient 命中相关度)。
        // sort:date / sort:oldest 仍走下面纯过滤分支按时间排 (与 body 路径语义一致)。
        // 排名用的那条正向收件人谓词不再重复进 metadata filter (避免双查)，但其余结构化
        // 谓词 + 负向收件人 term 仍作 AND 过滤。镜像 Python elif positive_recipient_expr 分支。
        const otherPredicates: FilterPredicate[] = [
          ...parsed.filters,
          ...compileOrFilterGroups(parsed.or_filter_groups),
          ...structured.predicates,
          // P5: 收件人排名路径里裸 CJK 词的 trigram 约束仍要 AND (如 to~:alice 评审)。
          ...cjkTrigramPredicates,
          ...negFiltersCompiled
        ]
        // 负向收件人 term 仍要 AND 过滤掉。
        for (const term of parsed.neg_fts_terms) {
          if (!isRecipientTerm(term)) continue
          const negExpr = recipientMatchExpr(term)
          if (!negExpr) continue
          otherPredicates.push({
            sql:
              'm.internal_id NOT IN (SELECT rowid FROM email_recipient_fts ' +
              'WHERE email_recipient_fts MATCH ?)',
            params: [negExpr]
          })
        }
        transformedQuery = positiveRecipientExpr
        items = runRecipientFtsRanked(positiveRecipientExpr, otherPredicates, negFtsExpr)
      } else {
        items = runMetadataSearch(filters, negFtsExpr, parsed.sort)
      }
    }
  }

  const result: SearchResult = { items, total_indexed, mode }
  if (mode === 'smart' || transformedQuery !== opts.query) {
    result.transformed_query = transformedQuery
  }
  if (parseWarnings.length > 0) result.parse_warnings = parseWarnings
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

// ============================================================
// P4a perf: trigram / recipient FTS 冷启动预热
// ============================================================
// 问题: 2 字 CJK (如 "立项") 走 email_body_fts_trigram 的 body_markdown/subject/sender
// LIKE '%词%' = 全表扫 (~7700 行)。冷缓存首查实测 ~1.4s, 热 ~0.3s。≥3 字 MATCH / 英文
// 都 <0.01s, 唯独 2 字 LIKE 受冷页拖累。
// 缓解: DB 就绪后异步跑一次轻量全扫, 把 trigram + recipient 两表的 body/列页读进 OS/SQLite
// 页缓存, 让用户首次 2 字 CJK 查询不撞冷盘。匹配不到的 sentinel 词 (zzwarm) → 0 行返回但
// 仍触页。module 级 warmed flag 守只跑一次; 失败静默 (try/catch)。**绝不阻塞** —— index.ts
// 用 setImmediate fire-and-forget 调用, 不在开窗/首帧关键路径上 await。
let _ftsWarmed = false

export function warmSearchFtsCache(): void {
  if (_ftsWarmed) return
  _ftsWarmed = true
  try {
    const db = getDb()
    // sentinel 匹配不到任何行, 但 LIKE '%...%' 仍强制全表扫 → 触页进缓存。
    prep(
      db,
      `SELECT count(*) AS n FROM email_body_fts_trigram
        WHERE body_markdown LIKE '% zzwarm%' OR subject LIKE '% zzwarm%' OR sender LIKE '% zzwarm%'`
    ).get()
    prep(
      db,
      `SELECT count(*) AS n FROM email_recipient_fts
        WHERE to_addr LIKE '% zzwarm%' OR cc_addr LIKE '% zzwarm%' OR sender_name LIKE '% zzwarm%'`
    ).get()
  } catch (err) {
    // 表缺失 (旧库未迁) / db 未就绪 / 任何异常 → 静默跳过, 预热是纯增益不该影响功能。
    console.warn('[email:search] FTS warm skipped', err)
  }
}

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
