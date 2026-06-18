export interface TextTerm {
  value: string
  is_phrase?: boolean
  force_quoted?: boolean
  // column 标记该 term 限定到哪个 FTS5 列。columnTable 标记该列属于哪张 FTS5 表
  // （T6 的 body/subject/sender 属 email_body_fts；T8 的 to_addr/cc_addr/sender_name
  // 属并行表 email_recipient_fts）。裸全文 term 两者都为 undefined。镜像 Python TextTerm。
  column?: 'body_markdown' | 'subject' | 'sender' | 'to_addr' | 'cc_addr' | 'sender_name'
  columnTable?: 'body' | 'recipient'
}

export interface FilterPredicate {
  sql: string
  params: unknown[]
}

export interface ParsedSearchQuery {
  original_query: string
  fts_terms: TextTerm[]
  fts_or_groups: TextTerm[][]
  neg_fts_terms: TextTerm[]
  filters: FilterPredicate[]
  or_filter_groups: FilterPredicate[][]
  neg_filters: FilterPredicate[]
  warnings: string[]
  is_plain_passthrough: boolean
  sort?: 'relevance' | 'date' | 'oldest'
}

interface Unit {
  kind: 'text' | 'filter'
  value: TextTerm | FilterPredicate
  negated: boolean
}

type Element = Unit | 'OR'

interface ParseOptions {
  now?: Date | string | null
  tzOffsetMinutes?: number | null
}

const FIELD_RE = /^([A-Za-z_]+~?):(.*)$/
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/
const RELATIVE_RE = /^([1-9]\d*)([dwmy])$/i

const FIELD_ALIASES: Record<string, string> = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  subject: 'subject',
  mailbox: 'mailbox',
  in: 'mailbox',
  after: 'after',
  since: 'after',
  before: 'before',
  until: 'before',
  date: 'date',
  on: 'date',
  newer_than: 'newer_than',
  older_than: 'older_than',
  is: 'is',
  has: 'has',
  priority: 'priority'
}

// T6 列级 FTS：把 `body:` / `subject~:` / `sender~:` 映射到 email_body_fts 列名。
// `subject~:` / `sender~:` 用 ~ 后缀与既有 `subject:` / `from:` LIKE 过滤区分；
// `body:` 无对应 LIKE 字段故不带 ~。镜像 Python _FTS_COLUMN_ALIASES。
const FTS_COLUMN_ALIASES: Record<string, 'body_markdown' | 'subject' | 'sender'> = {
  body: 'body_markdown',
  'subject~': 'subject',
  'sender~': 'sender'
}

// T8: email_recipient_fts 并行表的列级 FTS 语法（收件人全文化, ②保守）。
// to~:/cc~:/from~: 查 email_recipient_fts（与 T6 的 body:/subject~:/sender~: 不同表），
// 与既有 to:/cc:/from: 的 LIKE 硬过滤并存、语义不变。镜像 Python _FTS_RECIPIENT_COLUMN_ALIASES。
const FTS_RECIPIENT_COLUMN_ALIASES: Record<string, 'to_addr' | 'cc_addr' | 'sender_name'> = {
  'to~': 'to_addr',
  'cc~': 'cc_addr',
  'from~': 'sender_name'
}

const MAILBOX_ALIASES: Record<string, string> = {
  inbox: '收件箱',
  sent: '发件箱',
  archive: '存档',
  drafts: '草稿箱'
}

const PRIORITY_ALIASES: Record<string, string> = {
  urgent: '紧急',
  紧急: '紧急',
  important: '重要',
  重要: '重要',
  normal: '一般',
  一般: '一般',
  low: '低',
  低: '低'
}

const SORT_ALIASES: Record<string, string> = {
  relevance: 'relevance',
  date: 'date',
  newest: 'date',
  oldest: 'oldest'
}

const IS_FILTERS: Record<string, FilterPredicate> = {
  read: { sql: 'COALESCE(m.is_read, 0) = ?', params: [1] },
  unread: { sql: 'COALESCE(m.is_read, 0) = ?', params: [0] },
  // T4: 正向用 `m.col = 1` 命中 partial index；反向/unread 保留 COALESCE 兼容 NULL。
  flagged: { sql: 'm.is_flagged = ?', params: [1] },
  unflagged: { sql: 'COALESCE(m.is_flagged, 0) = ?', params: [0] },
  pinned: { sql: 'm.is_pinned = ?', params: [1] },
  important: { sql: 'm.is_important = ?', params: [1] }
}

export function tokenizeSearchQuery(query: string): { tokens: string[]; warnings: string[] } {
  const tokens: string[] = []
  const warnings: string[] = []
  let buf = ''
  let inQuote = false

  for (const c of query) {
    if (c === '"') {
      inQuote = !inQuote
      buf += c
      continue
    }
    if (/\s/.test(c) && !inQuote) {
      if (buf.length > 0) {
        tokens.push(buf)
        buf = ''
      }
      continue
    }
    buf += c
  }

  if (buf.length > 0) tokens.push(buf)
  if (inQuote) {
    warnings.push('unclosed_quote')
    return { tokens: query.trim().length === 0 ? [] : query.trim().split(/\s+/), warnings }
  }
  return { tokens, warnings }
}

function isRegisteredFieldToken(token: string): boolean {
  const body = token.startsWith('-') && token.length > 1 ? token.slice(1) : token
  const match = FIELD_RE.exec(body)
  if (match === null) return false
  const name = match[1]!.toLowerCase()
  return (
    FIELD_ALIASES[name] !== undefined ||
    FTS_COLUMN_ALIASES[name] !== undefined ||
    FTS_RECIPIENT_COLUMN_ALIASES[name] !== undefined ||
    name === 'sort'
  )
}

/** T2: 识别 `sort:` 排序覆盖 token。返回 matched + 规范化值（null=非法值，已记 warning）。 */
function parseSortToken(
  token: string,
  warnings: string[]
): { matched: boolean; value: string | null } {
  const match = FIELD_RE.exec(token)
  if (match === null || match[1]!.toLowerCase() !== 'sort') return { matched: false, value: null }
  const raw = stripOuterQuotes(match[2] ?? '')
    .trim()
    .toLowerCase()
  const canonical = SORT_ALIASES[raw]
  if (!canonical) {
    warnings.push(raw ? `unknown_value:sort:${raw}` : 'empty_value:sort')
    return { matched: true, value: null }
  }
  return { matched: true, value: canonical }
}

/**
 * T0 容错：把孤立的 `field:`（冒号后空值）与紧跟的下一个文本 token 合并。
 * `from: echo` → `from:echo`、`-from: echo` → `-from:echo`、
 * `from: "Zhang San"` → `from:"Zhang San"`。下列情况不合并（保持现状丢弃 +
 * `empty_value` warning）：孤立 `field:` 在末尾、下一个 token 是另一个字段过滤器、
 * 或下一个 token 是孤立 `OR`。
 */
function mergeDanglingFields(tokens: string[]): string[] {
  const merged: string[] = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    const body = tok.startsWith('-') && tok.length > 1 ? tok.slice(1) : tok
    const match = FIELD_RE.exec(body)
    const name = match !== null ? match[1]!.toLowerCase() : ''
    if (
      match !== null &&
      match[2] === '' &&
      // 已注册字段、列级 FTS 字段（含收件人 to~:/cc~:/from~:）或 sort
      // （排序指令也享受冒号后空格容错）
      (FIELD_ALIASES[name] !== undefined ||
        FTS_COLUMN_ALIASES[name] !== undefined ||
        FTS_RECIPIENT_COLUMN_ALIASES[name] !== undefined ||
        name === 'sort') &&
      i + 1 < tokens.length &&
      tokens[i + 1] !== 'OR' &&
      !isRegisteredFieldToken(tokens[i + 1]!)
    ) {
      merged.push(tok + tokens[i + 1]!)
      i += 2
      continue
    }
    merged.push(tok)
    i += 1
  }
  return merged
}

export function parseSearchQuery(query: string, opts: ParseOptions = {}): ParsedSearchQuery {
  const originalQuery = query ?? ''
  try {
    const localOffset = localTimezoneOffset(opts.tzOffsetMinutes)
    const now = coerceNow(opts.now, localOffset)
    const { tokens: rawTokens, warnings } = tokenizeSearchQuery(originalQuery)
    const tokens = mergeDanglingFields(rawTokens)
    const parsed = emptyParsed(originalQuery, warnings)
    if (tokens.length === 0) {
      parsed.is_plain_passthrough = true
      return parsed
    }

    const elements: Element[] = []
    let sawSyntax = false
    for (const token of tokens) {
      if (token === 'OR') {
        elements.push('OR')
        sawSyntax = true
        continue
      }
      const sortResult = parseSortToken(token, parsed.warnings)
      if (sortResult.matched) {
        sawSyntax = true
        if (sortResult.value !== null && parsed.sort === undefined) {
          parsed.sort = sortResult.value as 'relevance' | 'date' | 'oldest'
        }
        continue
      }
      const { unit, sawSyntax: tokenSawSyntax } = classifyToken(
        token,
        parsed.warnings,
        now,
        localOffset
      )
      sawSyntax = sawSyntax || tokenSawSyntax
      if (unit) elements.push(unit)
    }

    applyOrGroups(elements, parsed)
    parsed.is_plain_passthrough = isPlainPassthrough(parsed, sawSyntax)
    return parsed
  } catch {
    return {
      ...emptyParsed(originalQuery, ['parse_error']),
      fts_terms: originalQuery ? [{ value: originalQuery }] : [],
      is_plain_passthrough: true
    }
  }
}

export function buildStructuredFilterPredicates(opts: {
  mailbox?: string | null
  sinceDate?: string | null
  untilDate?: string | null
  now?: Date | string | null
  tzOffsetMinutes?: number | null
}): { predicates: FilterPredicate[]; warnings: string[] } {
  const warnings: string[] = []
  const predicates: FilterPredicate[] = []
  const localOffset = localTimezoneOffset(opts.tzOffsetMinutes)
  coerceNow(opts.now, localOffset)

  if (opts.mailbox) predicates.push({ sql: 'm.mailbox = ?', params: [opts.mailbox] })
  if (opts.sinceDate) {
    const pred = datePredicate('after', opts.sinceDate, warnings, localOffset)
    if (pred) predicates.push(pred)
  }
  if (opts.untilDate) {
    const pred = datePredicate('before', opts.untilDate, warnings, localOffset)
    if (pred) predicates.push(pred)
  }
  return { predicates, warnings }
}

export function escapeLikeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function queryHasRegisteredSearchSyntax(query: string): boolean {
  const { tokens } = tokenizeSearchQuery(query)
  return tokens.some((token) => {
    if (token === 'OR') return true
    if (token.startsWith('-') && token.length > 1) return true
    const body = token.startsWith('-') && token.length > 1 ? token.slice(1) : token
    const match = FIELD_RE.exec(body)
    if (!match) return false
    const name = match[1]!.toLowerCase()
    return (
      FIELD_ALIASES[name] !== undefined ||
      FTS_COLUMN_ALIASES[name] !== undefined ||
      FTS_RECIPIENT_COLUMN_ALIASES[name] !== undefined ||
      name === 'sort'
    )
  })
}

function emptyParsed(originalQuery: string, warnings: string[] = []): ParsedSearchQuery {
  return {
    original_query: originalQuery,
    fts_terms: [],
    fts_or_groups: [],
    neg_fts_terms: [],
    filters: [],
    or_filter_groups: [],
    neg_filters: [],
    warnings: [...warnings],
    is_plain_passthrough: false
  }
}

function classifyToken(
  token: string,
  warnings: string[],
  now: Date,
  localOffsetMinutes: number
): { unit: Unit | null; sawSyntax: boolean } {
  let negated = false
  let body = token
  let sawSyntax = false
  if (body.startsWith('-') && body.length > 1) {
    negated = true
    body = body.slice(1)
    sawSyntax = true
  }

  const fieldMatch = FIELD_RE.exec(body)
  if (fieldMatch) {
    const fieldName = fieldMatch[1]!.toLowerCase()
    const rawValue = fieldMatch[2] ?? ''
    // T6 列级 FTS（email_body_fts）+ T8 收件人列 FTS（email_recipient_fts 并行表）：
    // 在 FIELD_ALIASES 之前命中 FTS 列分支，编译成全文 text unit（带 column + columnTable），
    // 不是 LIKE filter。镜像 Python _classify_token 的 fts_column / recipient_column 分支。
    const ftsColumn = FTS_COLUMN_ALIASES[fieldName]
    const recipientColumn = FTS_RECIPIENT_COLUMN_ALIASES[fieldName]
    if (ftsColumn !== undefined || recipientColumn !== undefined) {
      sawSyntax = true
      const value = stripOuterQuotes(rawValue)
      if (value === '') {
        warnings.push(`empty_value:${fieldName}`)
        return { unit: null, sawSyntax }
      }
      const column = ftsColumn !== undefined ? ftsColumn : recipientColumn!
      const columnTable: 'body' | 'recipient' = ftsColumn !== undefined ? 'body' : 'recipient'
      return {
        unit: {
          kind: 'text',
          value: { value, is_phrase: isQuoted(rawValue), column, columnTable },
          negated
        },
        sawSyntax
      }
    }
    const canonical = FIELD_ALIASES[fieldName]
    if (!canonical) {
      return {
        unit: { kind: 'text', value: { value: body, force_quoted: true }, negated },
        sawSyntax: true
      }
    }

    sawSyntax = true
    const value = stripOuterQuotes(rawValue)
    if (value === '') {
      warnings.push(`empty_value:${fieldName}`)
      return { unit: null, sawSyntax }
    }
    const predicate = buildFilterPredicate(canonical, value, warnings, now, localOffsetMinutes)
    if (!predicate) return { unit: null, sawSyntax }
    return { unit: { kind: 'filter', value: predicate, negated }, sawSyntax }
  }

  if (isQuoted(body)) {
    const value = stripOuterQuotes(body)
    if (value === '') {
      warnings.push('empty_text')
      return { unit: null, sawSyntax }
    }
    return { unit: { kind: 'text', value: { value, is_phrase: true }, negated }, sawSyntax }
  }

  return { unit: { kind: 'text', value: { value: body }, negated }, sawSyntax }
}

function applyOrGroups(elements: Element[], parsed: ParsedSearchQuery): void {
  let i = 0
  while (i < elements.length) {
    const element = elements[i]
    if (element === 'OR') {
      parsed.warnings.push('dangling_or')
      i += 1
      continue
    }

    if (i + 1 < elements.length && elements[i + 1] === 'OR') {
      const chain: Unit[] = [element]
      let j = i
      let dangling = false
      while (j + 1 < elements.length && elements[j + 1] === 'OR') {
        if (j + 2 >= elements.length || elements[j + 2] === 'OR') {
          dangling = true
          j += 1
          break
        }
        chain.push(elements[j + 2] as Unit)
        j += 2
      }

      const invalidReason = orInvalidReason(chain)
      if (dangling) parsed.warnings.push('dangling_or')
      if (invalidReason) {
        parsed.warnings.push(invalidReason)
        for (const unit of chain) appendUnit(parsed, unit)
      } else if (chain[0]!.kind === 'text') {
        parsed.fts_or_groups.push(chain.map((unit) => unit.value as TextTerm))
      } else {
        parsed.or_filter_groups.push(chain.map((unit) => unit.value as FilterPredicate))
      }
      i = j + 1
      continue
    }

    appendUnit(parsed, element)
    i += 1
  }
}

function orInvalidReason(chain: Unit[]): string | null {
  if (chain.some((unit) => unit.negated)) return 'unsupported_or:negated'
  const firstKind = chain[0]?.kind
  if (chain.some((unit) => unit.kind !== firstKind)) return 'unsupported_or:cross_class'
  return null
}

function appendUnit(parsed: ParsedSearchQuery, unit: Unit): void {
  if (unit.kind === 'text') {
    if (unit.negated) parsed.neg_fts_terms.push(unit.value as TextTerm)
    else parsed.fts_terms.push(unit.value as TextTerm)
    return
  }
  if (unit.negated) parsed.neg_filters.push(unit.value as FilterPredicate)
  else parsed.filters.push(unit.value as FilterPredicate)
}

function isPlainPassthrough(parsed: ParsedSearchQuery, sawSyntax: boolean): boolean {
  return (
    !sawSyntax &&
    parsed.filters.length === 0 &&
    parsed.or_filter_groups.length === 0 &&
    parsed.neg_filters.length === 0 &&
    parsed.fts_or_groups.length === 0 &&
    parsed.neg_fts_terms.length === 0
  )
}

function buildFilterPredicate(
  field: string,
  value: string,
  warnings: string[],
  now: Date,
  localOffsetMinutes: number
): FilterPredicate | null {
  if (field === 'from') {
    const pattern = likePattern(value)
    return {
      sql:
        "(COALESCE(m.sender, '') LIKE ? ESCAPE '\\' " +
        "OR COALESCE(m.sender_name, '') LIKE ? ESCAPE '\\')",
      params: [pattern, pattern]
    }
  }
  if (field === 'to') return likePredicate('m.to_addr', value)
  if (field === 'cc') return likePredicate('m.cc_addr', value)
  if (field === 'subject') return likePredicate('m.subject', value)
  if (field === 'mailbox')
    return likePredicate('m.mailbox', MAILBOX_ALIASES[value.toLowerCase()] ?? value)
  if (field === 'after' || field === 'before') {
    return datePredicate(field, value, warnings, localOffsetMinutes)
  }
  if (field === 'date') {
    const start = coerceSearchDateTime(value, localOffsetMinutes, false)
    const end = coerceSearchDateTime(value, localOffsetMinutes, true)
    if (!start || !end) {
      warnings.push(`invalid_date:${field}:${value}`)
      return null
    }
    return {
      sql: 'datetime(m.date_received) >= datetime(?) AND datetime(m.date_received) < datetime(?)',
      params: [toUtcSqliteValue(start), toUtcSqliteValue(end)]
    }
  }
  if (field === 'newer_than' || field === 'older_than') {
    return relativeDatePredicate(field, value, warnings, now)
  }
  if (field === 'is') {
    const predicate = IS_FILTERS[value.toLowerCase()]
    if (!predicate) warnings.push(`unknown_value:is:${value}`)
    return predicate ? { sql: predicate.sql, params: [...predicate.params] } : null
  }
  if (field === 'has') {
    if (value.toLowerCase() !== 'attachment') {
      warnings.push(`unknown_value:has:${value}`)
      return null
    }
    return {
      sql:
        'EXISTS (SELECT 1 FROM email_attachment a ' +
        'WHERE a.internal_id = m.internal_id AND COALESCE(a.is_inline, 0) = 0)',
      params: []
    }
  }
  if (field === 'priority') {
    return likePredicate('m.ai_priority', PRIORITY_ALIASES[value.toLowerCase()] ?? value)
  }
  return null
}

function likePredicate(column: string, value: string): FilterPredicate {
  return {
    sql: `COALESCE(${column}, '') LIKE ? ESCAPE '\\'`,
    params: [likePattern(value)]
  }
}

function likePattern(value: string): string {
  return `%${escapeLikeValue(value)}%`
}

function datePredicate(
  field: 'after' | 'before',
  value: string,
  warnings: string[],
  localOffsetMinutes: number
): FilterPredicate | null {
  const dt = coerceSearchDateTime(value, localOffsetMinutes, field === 'before')
  if (!dt) {
    warnings.push(`invalid_date:${field}:${value}`)
    return null
  }
  const op = field === 'after' ? '>=' : '<'
  return {
    sql: `datetime(m.date_received) ${op} datetime(?)`,
    params: [toUtcSqliteValue(dt)]
  }
}

function relativeDatePredicate(
  field: 'newer_than' | 'older_than',
  value: string,
  warnings: string[],
  now: Date
): FilterPredicate | null {
  const match = RELATIVE_RE.exec(value)
  if (!match) {
    warnings.push(`invalid_relative_date:${field}:${value}`)
    return null
  }
  const count = Number.parseInt(match[1]!, 10)
  const unit = match[2]!.toLowerCase() as 'd' | 'w' | 'm' | 'y'
  const daysByUnit = { d: 1, w: 7, m: 30, y: 365 }
  const threshold = new Date(now.getTime() - count * daysByUnit[unit] * 24 * 60 * 60 * 1000)
  const op = field === 'newer_than' ? '>=' : '<'
  return {
    sql: `datetime(m.date_received) ${op} datetime(?)`,
    params: [toUtcSqliteValue(threshold)]
  }
}

function coerceSearchDateTime(
  value: string,
  localOffsetMinutes: number,
  endOfDay: boolean
): Date | null {
  const raw = value.trim()
  if (DATE_ONLY_RE.test(raw)) {
    const [year, month, day] = raw.split('-').map((part) => Number.parseInt(part, 10))
    if (!isValidDateParts(year, month, day, 0, 0, 0)) return null
    const dayOffset = endOfDay ? 1 : 0
    return new Date(
      Date.UTC(year, month - 1, day + dayOffset, 0, 0, 0) - localOffsetMinutes * 60_000
    )
  }

  const match = DATE_TIME_RE.exec(raw)
  if (!match) return null
  const year = Number.parseInt(match[1]!, 10)
  const month = Number.parseInt(match[2]!, 10)
  const day = Number.parseInt(match[3]!, 10)
  const hour = Number.parseInt(match[4]!, 10)
  const minute = Number.parseInt(match[5]!, 10)
  const second = match[6] ? Number.parseInt(match[6], 10) : 0
  if (!isValidDateParts(year, month, day, hour, minute, second)) return null

  let offsetMinutes = localOffsetMinutes
  if (match[7]) offsetMinutes = 0
  if (match[8] && match[9] && match[10]) {
    const sign = match[8] === '-' ? -1 : 1
    offsetMinutes = sign * (Number.parseInt(match[9], 10) * 60 + Number.parseInt(match[10], 10))
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000)
}

function coerceNow(now: Date | string | null | undefined, localOffsetMinutes: number): Date {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now
  if (typeof now === 'string') {
    const coerced = coerceSearchDateTime(now, localOffsetMinutes, false)
    if (coerced) return coerced
  }
  return new Date()
}

function localTimezoneOffset(tzOffsetMinutes: number | null | undefined): number {
  if (typeof tzOffsetMinutes === 'number' && Number.isFinite(tzOffsetMinutes)) {
    return tzOffsetMinutes
  }
  return -new Date().getTimezoneOffset()
}

function toUtcSqliteValue(dt: Date): string {
  return `${dt.toISOString().slice(0, 19)}+00:00`
}

function isValidDateParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): boolean {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day &&
    dt.getUTCHours() === hour &&
    dt.getUTCMinutes() === minute &&
    dt.getUTCSeconds() === second
  )
}

function isQuoted(value: string): boolean {
  return value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"'
}

function stripOuterQuotes(value: string): string {
  return isQuoted(value) ? value.slice(1, -1) : value
}

// ============================================================
// T7: CJK trigram 查询计划器 (flag-gated, 镜像 Python build_search_plan)
// ============================================================
//
// 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md 方案②。
// 对每个「裸全文 term」按 CJK 占比 + CJK 长度分路由 (与 email_repository.py 的
// _count_cjk_chars / _split_cjk_segments / _route_text_term / build_search_plan 逐字节对齐):
//   - 无 CJK (纯英文/数字/符号)  → unicode (主表 email_body_fts MATCH + smartQueryTransform)
//   - CJK >= 3 字                → trigram_match (email_body_fts_trigram MATCH)
//   - CJK = 2 字                 → trigram_like (trigram 表 body/subject/sender LIKE '%词%')
//   - CJK = 1 字                → too_short (不查 + warning cjk_too_short:<词>)
//   - 中英混合 (CJK + Latin 同 term) → mixed (英文段 unicode 候选 ∩ 中文段 trigram 候选)
// 实测硬约束: trigram MATCH < 3 Unicode 字符无召回, 故 1/2 字中文不能走 MATCH。

// isCjkChar 必须与 Python _is_cjk_char (email_repository.py) + email.ts isCjkChar 同范围。
function isCjkCharPlan(c: string): boolean {
  if (!c) return false
  const cp = c.codePointAt(0)
  if (cp === undefined) return false
  if (cp >= 0x4e00 && cp <= 0x9fff) return true // CJK Unified Ideographs
  if (cp >= 0x3400 && cp <= 0x4dbf) return true // CJK Extension A
  if (cp >= 0x20000 && cp <= 0x2fa1f) return true // CJK Extension B-F
  if (cp >= 0x3040 && cp <= 0x30ff) return true // Hiragana / Katakana
  if (cp >= 0xac00 && cp <= 0xd7af) return true // Hangul Syllables
  return false
}

/** 统计字符串里 CJK 字符数 (镜像 Python _count_cjk_chars)。按码点遍历。 */
export function countCjkChars(value: string): number {
  let n = 0
  for (const c of value) {
    if (isCjkCharPlan(c)) n += 1
  }
  return n
}

/** 按 CJK / 非 CJK 边界切 segment, 返回 [{isCjk, segment}, ...] (镜像 Python _split_cjk_segments)。 */
export function splitCjkSegments(value: string): Array<{ isCjk: boolean; segment: string }> {
  const segments: Array<{ isCjk: boolean; segment: string }> = []
  let currentCjk: boolean | null = null
  let current = ''
  for (const c of value) {
    const cCjk = isCjkCharPlan(c)
    if (currentCjk === null) {
      currentCjk = cCjk
      current = c
    } else if (cCjk === currentCjk) {
      current += c
    } else {
      segments.push({ isCjk: currentCjk, segment: current })
      current = c
      currentCjk = cCjk
    }
  }
  if (current && currentCjk !== null) {
    segments.push({ isCjk: currentCjk, segment: current })
  }
  return segments
}

export type CjkSegmentRouteKind = 'trigram_match' | 'trigram_like' | 'too_short'

/** 单个 CJK segment 的路由 (镜像 Python _CjkSegmentRoute)。 */
export interface CjkSegmentRoute {
  value: string
  route: CjkSegmentRouteKind
}

export type TermRouteKind = 'unicode' | 'trigram' | 'too_short'

/**
 * 一个裸全文 term 的路由计划 (镜像 Python _TermRoute)。
 *   'unicode'   —— 纯非 CJK term, unicode_expr 为 smartQueryTransform 结果。
 *   'trigram'   —— 含 CJK term, 由 cjkSegments + latinSegments 组合。
 *   'too_short' —— 整 term 只有 1 个 CJK 字 (无别的内容), 拦截 + warning。
 */
export interface TermRoute {
  original: string
  route: TermRouteKind
  /** route='unicode' 时的 FTS5 expr (smartQueryTransform 结果)。 */
  unicodeExpr: string
  /** 混合 term 里的拉丁段 (走 unicode61)。 */
  latinSegments: string[]
  cjkSegments: CjkSegmentRoute[]
  warnings: string[]
}

/**
 * 把一个裸全文 term 分类成 TermRoute (T7 路由核心, 镜像 Python _route_text_term)。
 * smartQueryTransform 由 caller 注入 (定义在 email.ts, 与 Python 同算法)。
 */
export function routeTextTerm(
  value: string,
  smartQueryTransform: (q: string) => string
): TermRoute {
  const cjkCount = countCjkChars(value)
  if (cjkCount === 0) {
    return {
      original: value,
      route: 'unicode',
      unicodeExpr: smartQueryTransform(value),
      latinSegments: [],
      cjkSegments: [],
      warnings: []
    }
  }

  const segments = splitCjkSegments(value)
  const latinSegments: string[] = []
  const cjkSegments: CjkSegmentRoute[] = []
  const warnings: string[] = []
  for (const { isCjk, segment } of segments) {
    if (!isCjk) {
      if (segment.trim()) latinSegments.push(segment)
      continue
    }
    const segLen = [...segment].length
    if (segLen >= 3) {
      cjkSegments.push({ value: segment, route: 'trigram_match' })
    } else if (segLen === 2) {
      cjkSegments.push({ value: segment, route: 'trigram_like' })
    } else {
      // segLen === 1
      cjkSegments.push({ value: segment, route: 'too_short' })
      warnings.push(`cjk_too_short:${segment}`)
    }
  }

  // 整 term 只有 1 个 CJK 字 (无拉丁段, 无其它可查 CJK 段) → 拦截整 term。
  const queryableCjk = cjkSegments.filter((s) => s.route !== 'too_short')
  if (latinSegments.length === 0 && queryableCjk.length === 0) {
    return {
      original: value,
      route: 'too_short',
      unicodeExpr: '',
      latinSegments: [],
      cjkSegments: [],
      warnings
    }
  }

  return {
    original: value,
    route: 'trigram',
    unicodeExpr: '',
    latinSegments,
    cjkSegments: queryableCjk,
    warnings
  }
}

/**
 * 把裸全文 term 列表编译成路由计划 + 收集 warning (镜像 Python build_search_plan)。
 * 返回 { routes, warnings }。routes 只含可查 term (route in {'unicode','trigram'});
 * 'too_short' term 被丢弃但其 warning 进 warnings。
 */
export function buildSearchPlan(
  terms: string[],
  smartQueryTransform: (q: string) => string
): { routes: TermRoute[]; warnings: string[] } {
  const routes: TermRoute[] = []
  const warnings: string[] = []
  for (const term of terms) {
    if (!term) continue
    const route = routeTextTerm(term, smartQueryTransform)
    warnings.push(...route.warnings)
    if (route.route === 'too_short') continue
    routes.push(route)
  }
  return { routes, warnings }
}

/** 把一个 token 包成 FTS5 短语字面量 `"token"` (内部双引号转义为 `""`)。镜像 Python _quote_fts_token。 */
function quoteFtsToken(token: string): string {
  return '"' + token.replace(/"/g, '""') + '"'
}

/**
 * 从路由计划构造「snippet 匹配表达式」(供 email_body_fts_trigram MATCH 高亮)。
 * 镜像 Python build_trigram_snippet_expr。
 *
 * trigram 分词器要求 token >= 3 字符才有召回, 故只收:
 *   - latin 段 (英文/数字, 来自 unicode term 的 original 或 trigram term 的 latinSegments),
 *     按 `[A-Za-z0-9]+` 抽词后取 length>=3 的。
 *   - CJK 段中 route==='trigram_match' (>=3 字) 的整段。
 * 2 字 CJK (trigram_like) 与 1 字 CJK 不进表达式 (MATCH<3 无效)。
 * 各 token 包成 FTS5 短语并以 `OR` 连接; 全部不可 MATCH → 返回 ''。
 */
export function buildTrigramSnippetExpr(routes: TermRoute[]): string {
  const tokens: string[] = []
  for (const route of routes) {
    if (route.route === 'unicode') {
      tokens.push(...(route.original.match(/[A-Za-z0-9]+/g) ?? []).filter((t) => t.length >= 3))
    } else if (route.route === 'trigram') {
      for (const latin of route.latinSegments) {
        tokens.push(...(latin.match(/[A-Za-z0-9]+/g) ?? []).filter((t) => t.length >= 3))
      }
      for (const seg of route.cjkSegments) {
        if (seg.route === 'trigram_match') tokens.push(seg.value)
      }
    }
  }
  if (tokens.length === 0) return ''
  return tokens.map(quoteFtsToken).join(' OR ')
}
