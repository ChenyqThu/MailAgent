export interface TextTerm {
  value: string
  is_phrase?: boolean
  force_quoted?: boolean
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

const FIELD_RE = /^([A-Za-z_]+):(.*)$/
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

const IS_FILTERS: Record<string, FilterPredicate> = {
  read: { sql: 'COALESCE(m.is_read, 0) = ?', params: [1] },
  unread: { sql: 'COALESCE(m.is_read, 0) = ?', params: [0] },
  flagged: { sql: 'COALESCE(m.is_flagged, 0) = ?', params: [1] },
  unflagged: { sql: 'COALESCE(m.is_flagged, 0) = ?', params: [0] },
  pinned: { sql: 'COALESCE(m.is_pinned, 0) = ?', params: [1] },
  important: { sql: 'COALESCE(m.is_important, 0) = ?', params: [1] }
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

export function parseSearchQuery(query: string, opts: ParseOptions = {}): ParsedSearchQuery {
  const originalQuery = query ?? ''
  try {
    const localOffset = localTimezoneOffset(opts.tzOffsetMinutes)
    const now = coerceNow(opts.now, localOffset)
    const { tokens, warnings } = tokenizeSearchQuery(originalQuery)
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
    return FIELD_ALIASES[match[1]!.toLowerCase()] !== undefined
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
