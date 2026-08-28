import type { Database } from 'better-sqlite3'
import { ipcMain } from 'electron'

import { getDb } from '../db'
import type { ContactSuggestion } from '@shared/api/types'
import { isSentMailbox } from '@shared/lib/mailboxSemantics'

interface ContactSuggestOpts {
  q?: string
  limit?: number
  exclude?: string | string[]
}

interface ContactSourceRow {
  sender: string | null
  sender_name: string | null
  to_addr: string | null
  cc_addr: string | null
  mailbox: string | null
  date_received: string | null
}

interface ContactAggregate {
  email: string
  name?: string
  score: number
  last_seen?: string
  lastSeenMs: number
  nameSeenMs: number
}

/**
 * 通讯录 (contact / contact_email, DB v54) 的一行「人 × 地址」。
 *
 * 🔴 判据只能是「表在不在 / 查出来有没有行」；通讯录 venue 已恒启用，
 * 两表与运行时开关解耦恒在。
 */
interface DirectoryRow {
  display_name: string | null
  formal_name: string | null
  organization: string | null
  name_variants_json: string | null
  email_normalized: string
  former_at: number | null
  excluded: number
}

/**
 * 补全候选（内部形状）。`fields` = 子串匹配面，`tokens` = 前缀匹配面 —— 两者
 * 都在建候选时算好，排序里不再做字符串切分。
 */
interface Candidate {
  email: string
  name?: string
  /** 通讯录 organization —— 只用于展示（补全行的次要标识），不参与排序。 */
  org?: string
  score: number
  last_seen?: string
  lastSeenMs: number
  /** 通讯录里标了「曾用邮箱」(contact_email.former_at)。恒排在主邮箱之后。 */
  former: boolean
  fields: string[]
  tokens: string[]
}

const CACHE_TTL_MS = 10 * 60 * 1000
/**
 * 合流结果的短 TTL（沿用 `/chat/config` 快照那档 15s）。通讯录是小表、改名要
 * 「几乎立刻」在 compose 里生效，所以不能跟着邮件头聚合那份 10 分钟缓存走；
 * 但每次敲键都重做一遍 O(全部候选) 的合流也不必要。
 */
const DIRECTORY_TTL_MS = 15 * 1000
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const NAME_TOKEN_RE = /[\s,.;:()"'<>]+/
const LOCAL_TOKEN_RE = /[._%+-]+/

/**
 * 通讯录 lane 的取数（🔴 与 Python 侧 `_CONTACT_DIRECTORY_SQL` 逐字同款 ——
 * 远程 web 走 `GET /api/email/contacts`，两份实现必须同步改，否则桌面与远程
 * web 的补全语义会劈叉）。
 *
 * 三类排除（merged_into / hidden_at / is_self）不在 WHERE 里直接筛掉，而是
 * 带回 `excluded` 标位：它们同时还要把**邮件头聚合出来的同一地址**压下去
 * （合并走的旧身份 / owner 隐藏掉的噪音 / 自己的历史别名都不该再进候选）。
 */
const DIRECTORY_SQL = `SELECT c.display_name AS display_name,
       c.formal_name AS formal_name,
       c.organization AS organization,
       c.name_variants_json AS name_variants_json,
       ce.email_normalized AS email_normalized,
       ce.former_at AS former_at,
       CASE WHEN c.merged_into IS NOT NULL OR c.hidden_at IS NOT NULL
                 OR c.is_self = 1 THEN 1 ELSE 0 END AS excluded
  FROM contact c
  JOIN contact_email ce ON ce.contact_id = c.id`

let cache: { expiresAt: number; items: Candidate[] } | null = null
// `source` = 建这份合流用的历史 lane 数组本体；历史缓存一被清（测试 / TTL 到期
// 重建）身份就变，合流缓存随之失效，两份缓存不会各自过期到互相矛盾。
let mergedCache: { expiresAt: number; items: Candidate[]; source: Candidate[] } | null = null

function normalizeLimit(limit: number | undefined): number {
  const raw = limit ?? NaN
  if (!Number.isFinite(raw)) return 8
  return Math.min(Math.max(Math.trunc(raw), 1), 50)
}

function normalizeName(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').replace(/^["']+|["']+$/g, '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function dateMs(value: string | null | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function parseAddressSegment(segment: string): { email: string; name?: string } | null {
  const angle = /^(.*?)<([^>]+)>/.exec(segment)
  if (angle) {
    const rawEmail = EMAIL_RE.exec(angle[2] ?? '')?.[0]
    if (!rawEmail) return null
    return {
      email: rawEmail.toLowerCase(),
      name: normalizeName(angle[1])
    }
  }

  const emailMatch = EMAIL_RE.exec(segment)
  if (!emailMatch) return null
  const rawName = segment.slice(0, emailMatch.index).trim()
  return {
    email: emailMatch[0].toLowerCase(),
    name: normalizeName(rawName)
  }
}

function parseAddressList(
  value: string | null | undefined
): Array<{ email: string; name?: string }> {
  if (!value) return []
  return value
    .split(',')
    .map((segment) => parseAddressSegment(segment.trim()))
    .filter((entry): entry is { email: string; name?: string } => entry !== null)
}

function upsertContact(
  contacts: Map<string, ContactAggregate>,
  entry: { email: string; name?: string } | null,
  scoreDelta: number,
  dateReceived: string | null
): void {
  if (!entry) return
  const seenMs = dateMs(dateReceived)
  const current =
    contacts.get(entry.email) ??
    ({
      email: entry.email,
      score: 0,
      lastSeenMs: 0,
      nameSeenMs: 0
    } satisfies ContactAggregate)

  current.score += scoreDelta
  if (seenMs >= current.lastSeenMs) {
    current.lastSeenMs = seenMs
    if (dateReceived) current.last_seen = dateReceived
  }
  if (entry.name && seenMs >= current.nameSeenMs) {
    current.name = entry.name
    current.nameSeenMs = seenMs
  }
  contacts.set(entry.email, current)
}

function excludeSet(exclude: string | string[] | undefined): Set<string> {
  const values = Array.isArray(exclude) ? exclude : exclude ? [exclude] : []
  return new Set(
    values
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
}

function isPrefixMatch(item: Candidate, q: string): boolean {
  if (!q) return false
  return item.tokens.some((token) => token.startsWith(q))
}

function emailTokens(email: string): string[] {
  const localPart = email.split('@')[0] ?? ''
  return [localPart, ...localPart.split(LOCAL_TOKEN_RE)].filter(Boolean)
}

function nameTokens(value: string | null | undefined): string[] {
  const lowered = (value ?? '').toLowerCase()
  if (!lowered) return []
  return lowered.split(NAME_TOKEN_RE).filter(Boolean)
}

function pushField(fields: string[], value: string | null | undefined): void {
  const lowered = (value ?? '').trim().toLowerCase()
  if (lowered) fields.push(lowered)
}

function parseNameVariants(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

export function aggregateContactSuggestions(db: Database): ContactSuggestion[] {
  const rows = db
    .prepare(
      `SELECT sender, sender_name, to_addr, cc_addr, mailbox, date_received
         FROM email_metadata`
    )
    .all() as ContactSourceRow[]

  const contacts = new Map<string, ContactAggregate>()
  for (const row of rows) {
    const sender = parseAddressSegment(row.sender ?? '')
    upsertContact(
      contacts,
      sender ? { email: sender.email, name: normalizeName(row.sender_name) ?? sender.name } : null,
      1,
      row.date_received
    )

    const recipientScore = isSentMailbox(row.mailbox) ? 3 : 1
    for (const entry of parseAddressList(row.to_addr)) {
      upsertContact(contacts, entry, recipientScore, row.date_received)
    }
    for (const entry of parseAddressList(row.cc_addr)) {
      upsertContact(contacts, entry, recipientScore, row.date_received)
    }
  }

  return Array.from(contacts.values()).map((item) => ({
    email: item.email,
    ...(item.name ? { name: item.name } : {}),
    score: item.score,
    ...(item.last_seen ? { last_seen: item.last_seen } : {})
  }))
}

function historyCandidate(item: ContactSuggestion): Candidate {
  const fields: string[] = []
  pushField(fields, item.email)
  pushField(fields, item.name)
  return {
    email: item.email,
    ...(item.name ? { name: item.name } : {}),
    score: item.score,
    ...(item.last_seen ? { last_seen: item.last_seen } : {}),
    lastSeenMs: dateMs(item.last_seen),
    former: false,
    fields,
    tokens: [...emailTokens(item.email), ...nameTokens(item.name)]
  }
}

/** 邮件头聚合（全表扫 email_metadata，贵）→ 10 分钟缓存。 */
function historyCorpus(db: Database): Candidate[] {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.items
  try {
    const items = aggregateContactSuggestions(db).map(historyCandidate)
    cache = { expiresAt: now + CACHE_TTL_MS, items }
    return items
  } catch (err) {
    console.warn('[email:contactSuggest] aggregation failed', err)
    return []
  }
}

/**
 * 通讯录 lane 取数 —— 走的是 15s 那档短 TTL（`DIRECTORY_TTL_MS`），不跟邮件头
 * 聚合那份 10 分钟缓存：contact 是小表，而刚在通讯录里改完名的人应当马上在
 * compose 里显示新名字。
 *
 * 表不存在（老库升上来 / 精简 schema 的测试库）或查询异常 → 返回 []，历史 lane
 * 一个字节不受影响。
 */
function directoryRows(db: Database): DirectoryRow[] {
  try {
    const present = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
          WHERE type = 'table' AND name IN ('contact', 'contact_email')`
      )
      .get() as { n: number } | undefined
    if ((present?.n ?? 0) < 2) return []
    return db.prepare(DIRECTORY_SQL).all() as DirectoryRow[]
  } catch (err) {
    console.warn('[email:contactSuggest] directory lookup failed', err)
    return []
  }
}

/**
 * 两条 lane 合流（按归一 email 去重）：通讯录侧的 display_name / 组织 /
 * 曾用地址覆盖邮件头猜出来的名字，往来频度 score 仍由历史 lane 提供。
 */
function buildCandidates(history: Candidate[], rows: DirectoryRow[]): Candidate[] {
  const suppressed = new Set<string>()
  const directory: DirectoryRow[] = []
  for (const row of rows) {
    const email = (row.email_normalized ?? '').trim().toLowerCase()
    if (!email) continue
    if (row.excluded) suppressed.add(email)
    else directory.push(row)
  }

  const byEmail = new Map<string, Candidate>()
  for (const item of history) {
    if (suppressed.has(item.email)) continue
    byEmail.set(item.email, item)
  }

  for (const row of directory) {
    const email = row.email_normalized.trim().toLowerCase()
    const prev = byEmail.get(email)
    // 通讯录的名字优先；display_name 空则退 formal_name，再退邮件头学到的名字。
    const name = normalizeName(row.display_name) ?? normalizeName(row.formal_name) ?? prev?.name
    const variants = parseNameVariants(row.name_variants_json)

    // 可搜面 = 邮件头名字（保留：改名前的老叫法仍能搜到）+ 通讯录四字段，与
    // `GET /api/contacts?q=` 的口径一致（display_name / formal_name / organization /
    // name_variants / email）。
    const fields: string[] = []
    pushField(fields, email)
    pushField(fields, prev?.name)
    pushField(fields, row.display_name)
    pushField(fields, row.formal_name)
    pushField(fields, row.organization)
    for (const variant of variants) pushField(fields, variant)

    const tokens = [
      ...emailTokens(email),
      ...nameTokens(prev?.name),
      ...nameTokens(row.display_name),
      ...nameTokens(row.formal_name),
      ...nameTokens(row.organization),
      ...variants.flatMap((variant) => nameTokens(variant))
    ]

    const org = normalizeName(row.organization)

    byEmail.set(email, {
      email,
      ...(name ? { name } : {}),
      ...(org ? { org } : {}),
      score: prev?.score ?? 0,
      ...(prev?.last_seen ? { last_seen: prev.last_seen } : {}),
      lastSeenMs: prev?.lastSeenMs ?? 0,
      former: row.former_at != null,
      fields,
      tokens
    })
  }

  return [...byEmail.values()]
}

function candidateCorpus(db: Database): Candidate[] {
  const history = historyCorpus(db)
  const now = Date.now()
  if (mergedCache && mergedCache.expiresAt > now && mergedCache.source === history) {
    return mergedCache.items
  }
  const items = buildCandidates(history, directoryRows(db))
  mergedCache = { expiresAt: now + DIRECTORY_TTL_MS, items, source: history }
  return items
}

export function contactSuggest(opts: ContactSuggestOpts = {}): ContactSuggestion[] {
  const q = (opts.q ?? '').trim().toLowerCase()
  const limit = normalizeLimit(opts.limit)
  const excluded = excludeSet(opts.exclude)
  const items = candidateCorpus(getDb()).filter((item) => !excluded.has(item.email))
  const matched = q ? items.filter((item) => item.fields.some((f) => f.includes(q))) : items

  return [...matched]
    .sort((a, b) => {
      // ① 强命中（任一身份 token 前缀命中）优先 —— 通讯录的名字/组织进了 token
      //    面，所以「零往来但名字对得上」的人能排上来；
      // ② 曾用邮箱恒沉到主邮箱之后；
      // ③ 同档内仍按往来频度 score 排 —— 高频联系人不会被通讯录条目挤下去。
      const prefixDelta = Number(isPrefixMatch(b, q)) - Number(isPrefixMatch(a, q))
      if (prefixDelta !== 0) return prefixDelta
      if (a.former !== b.former) return a.former ? 1 : -1
      if (b.score !== a.score) return b.score - a.score
      if (b.lastSeenMs !== a.lastSeenMs) return b.lastSeenMs - a.lastSeenMs
      return a.email.localeCompare(b.email)
    })
    .slice(0, limit)
    .map((item) => ({
      email: item.email,
      ...(item.name ? { name: item.name } : {}),
      ...(item.org ? { org: item.org } : {}),
      score: item.score,
      ...(item.last_seen ? { last_seen: item.last_seen } : {})
    }))
}

export function resetContactSuggestCache(): void {
  cache = null
  mergedCache = null
}

export function registerContactHandlers(): void {
  ipcMain.handle('email:contactSuggest', (_evt, opts: ContactSuggestOpts = {}) =>
    contactSuggest(opts)
  )
}
