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

const CACHE_TTL_MS = 10 * 60 * 1000
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

let cache: { expiresAt: number; items: ContactSuggestion[] } | null = null

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

function isPrefixMatch(item: ContactSuggestion, q: string): boolean {
  if (!q) return false
  const localPart = item.email.split('@')[0] ?? ''
  if (localPart.startsWith(q)) return true
  if (localPart.split(/[._%+-]+/).some((part) => part.startsWith(q))) return true
  const name = item.name?.toLowerCase() ?? ''
  return name.split(/[\s,.;:()"'<>]+/).some((part) => part.startsWith(q))
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

function contactCorpus(db: Database): ContactSuggestion[] {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.items
  try {
    const items = aggregateContactSuggestions(db)
    cache = { expiresAt: now + CACHE_TTL_MS, items }
    return items
  } catch (err) {
    console.warn('[email:contactSuggest] aggregation failed', err)
    return []
  }
}

export function contactSuggest(opts: ContactSuggestOpts = {}): ContactSuggestion[] {
  const q = (opts.q ?? '').trim().toLowerCase()
  const limit = normalizeLimit(opts.limit)
  const excluded = excludeSet(opts.exclude)
  const items = contactCorpus(getDb()).filter((item) => !excluded.has(item.email))
  const matched = q
    ? items.filter(
        (item) =>
          item.email.toLowerCase().includes(q) || (item.name ?? '').toLowerCase().includes(q)
      )
    : items

  return [...matched]
    .sort((a, b) => {
      const prefixDelta = Number(isPrefixMatch(b, q)) - Number(isPrefixMatch(a, q))
      if (prefixDelta !== 0) return prefixDelta
      if (b.score !== a.score) return b.score - a.score
      const bDate = dateMs(b.last_seen)
      const aDate = dateMs(a.last_seen)
      if (bDate !== aDate) return bDate - aDate
      return a.email.localeCompare(b.email)
    })
    .slice(0, limit)
}

export function resetContactSuggestCache(): void {
  cache = null
}

export function registerContactHandlers(): void {
  ipcMain.handle('email:contactSuggest', (_evt, opts: ContactSuggestOpts = {}) =>
    contactSuggest(opts)
  )
}
