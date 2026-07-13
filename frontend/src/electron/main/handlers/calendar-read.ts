// Phase 3 §P1-c — calendar read handlers (eventsList/Get + sync-status + recurring discover).
// 直读 SQLite (better-sqlite3 + npm rrule 展开), ~5ms 路径. 不调 CalDAV 不 fork CLI.

// rrule 是 CJS 包, ESM 下没 named export — 必须 default import 再解构.
import rrulePkg from 'rrule'

import { callCli } from '../cli_runner'
import { getDb } from '../db'
import { type DbCalendarRow, READ_TIMEOUT_MS, epochToIso, parseJsonArray } from './calendar-shared'

const { rrulestr } = rrulePkg

// ============================================================
// Recurring discover
// ============================================================

export interface RecurringInviteItem {
  /** vEvent UID (RFC 5545) — Phase 2.4 Replay 用此调 calendar:eventReplay,
   *  跟 source 无关 (任何 source 都可 replay). */
  ical_uid: string
  /** Source email (the meeting invite carrier). Phase 1.5 caldav-only events = 0. */
  internal_id: number
  subject: string | null
  organizer: string | null
  rrule: string | null
  /** Notion calendar page (if synced). */
  notion_page_id: string | null
  first_occurrence: string | null
  last_occurrence: string | null
  occurrence_count: number | null
  date_received: string | null
}

export interface RecurringDiscoverOpts {
  since?: string
}

interface CliSeries {
  series_uid: string
  master_dtstart: string | null
  summary: string | null
  sender: string | null
  organizer: string | null
  rrule: string | null
  method: string | null
  internal_ids: number[]
}

export async function runRecurringDiscover(
  opts: RecurringDiscoverOpts = {}
): Promise<RecurringInviteItem[]> {
  const args = ['calendar', 'recurring', 'discover']
  if (opts.since) args.push('--since', opts.since)
  const out = await callCli(args, { timeoutMs: READ_TIMEOUT_MS })

  // Phase 1.5: CLI 返 {series: [...], total_series, ...}; 老 handler 找 .items
  // 拿不到 → 永远空. 这里把 CLI series 映射到 frontend RecurringInviteItem shape.
  let series: CliSeries[] = []
  if (Array.isArray(out)) {
    series = out as CliSeries[]
  } else if (out && typeof out === 'object') {
    const obj = out as { series?: unknown; items?: unknown }
    if (Array.isArray(obj.series)) series = obj.series as CliSeries[]
    else if (Array.isArray(obj.items)) series = obj.items as CliSeries[]
  }

  return series.map((s) => ({
    // Phase 2.4: ical_uid 是 series_uid (= vEvent UID), Replay 按钮用这个调
    // calendar:eventReplay (任何 source 都可). 老 internal_id 字段保留作 legacy
    // (caldav-only events 永远是 0, email_ics events 是真邮件 id).
    ical_uid: s.series_uid,
    internal_id: s.internal_ids?.[0] ?? 0,
    subject: s.summary,
    organizer: s.organizer ?? s.sender,
    rrule: s.rrule,
    notion_page_id: null,
    first_occurrence: s.master_dtstart,
    last_occurrence: null,
    occurrence_count: s.internal_ids?.length ?? null,
    date_received: null
  }))
}

// ============================================================
// Phase 3 §3.1 — Calendar SSoT 直读 (events list/get + sync state)
// ============================================================

/** RRULE 展开后的单 occurrence (前端日历 timeline 渲染拿到的). */
export interface CalendarEventOccurrence {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  /** ISO UTC datetime — 前端 toLocaleString 转本地 TZ. */
  occurrence_start_iso: string
  occurrence_end_iso: string
  is_recurrence_instance: boolean
  is_all_day: boolean
  calendar_name: string
  organizer: string
  attendees: Array<{ email: string; name?: string; response?: string; role?: string }>
  location: string
  url: string
  status: string
  response_status: string
  source: 'caldav' | 'email_ics' | 'legacy_calendar_app'
  notion_page_id: string | null
  related_email_internal_id: number | null
}

/** calendar_event 表完整 row (event-get 输出, 含 dtstart_iso 等 raw 字段). */
export interface CalendarEventRow {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  description: string
  location: string
  organizer: string
  attendees: Array<{ email: string; name?: string; response?: string; role?: string }>
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

function rowToCalendarEventRow(r: DbCalendarRow): CalendarEventRow {
  return {
    id: r.id,
    ical_uid: r.ical_uid,
    recurrence_id: r.recurrence_id,
    sequence: r.sequence,
    summary: r.summary ?? '',
    description: r.description ?? '',
    location: r.location ?? '',
    organizer: r.organizer ?? '',
    attendees: parseJsonArray(r.attendees_json),
    dtstart_iso: epochToIso(r.dtstart_utc),
    dtend_iso: epochToIso(r.dtend_utc),
    is_all_day: !!r.is_all_day,
    rrule: r.rrule ?? '',
    exdates: parseJsonArray<string>(r.exdates_json),
    rdates: parseJsonArray<string>(r.rdates_json),
    status: r.status ?? '',
    response_status: r.response_status ?? '',
    url: r.url ?? '',
    calendar_name: r.calendar_name ?? '',
    source: r.source,
    notion_page_id: r.notion_page_id,
    related_email_internal_id: r.related_email_internal_id,
    ics_raw: r.ics_raw ?? ''
  }
}

/**
 * 展开单 row 的 RRULE 到窗口内 occurrences.
 *
 * 跟 src/calendar_sync/expander.py 的 expand_in_window 等价行为:
 * - 无 RRULE → 单次 event, overlap 窗口才返
 * - 有 RRULE → rrule lib 展开, 套用 EXDATE 跳过, RDATE 额外加, MAX_COUNT 保护
 */
const MAX_OCCURRENCES_PER_RRULE = 500

export function expandInWindow(
  row: DbCalendarRow,
  windowStartMs: number,
  windowEndMs: number,
  expandRecurrences: boolean
): Array<{ start: Date; end: Date; isRecurrence: boolean }> {
  const dtstartMs = row.dtstart_utc * 1000
  const dtendMs = row.dtend_utc != null ? row.dtend_utc * 1000 : dtstartMs + 60 * 60 * 1000
  // 对齐 expander.py:75 — 仅 dtend<=dtstart 时兜底 1h, 短于 1h 的周期事件用真实时长
  const durationMs = dtendMs > dtstartMs ? dtendMs - dtstartMs : 60 * 60 * 1000

  if (!row.rrule || !expandRecurrences) {
    if (dtstartMs < windowEndMs && dtendMs > windowStartMs) {
      return [{ start: new Date(dtstartMs), end: new Date(dtendMs), isRecurrence: false }]
    }
    return []
  }

  let rruleStr = row.rrule.trim()
  if (rruleStr.toUpperCase().startsWith('RRULE:')) {
    rruleStr = rruleStr.slice(6)
  }
  let rule: ReturnType<typeof rrulestr>
  try {
    rule = rrulestr(`RRULE:${rruleStr}`, { dtstart: new Date(dtstartMs) })
  } catch {
    if (dtstartMs < windowEndMs && dtendMs > windowStartMs) {
      return [{ start: new Date(dtstartMs), end: new Date(dtendMs), isRecurrence: false }]
    }
    return []
  }

  const expandAfter = new Date(windowStartMs - durationMs)
  const expandBefore = new Date(windowEndMs)
  let candidates: Date[] = []
  try {
    candidates = rule.between(expandAfter, expandBefore, true)
  } catch {
    candidates = []
  }

  if (candidates.length > MAX_OCCURRENCES_PER_RRULE) {
    candidates = candidates.slice(0, MAX_OCCURRENCES_PER_RRULE)
  }

  const exdateSet = new Set<number>()
  for (const ex of parseJsonArray<string>(row.exdates_json)) {
    const t = Date.parse(ex)
    if (!Number.isNaN(t)) exdateSet.add(Math.floor(t / 1000))
  }
  for (const rd of parseJsonArray<string>(row.rdates_json)) {
    const t = Date.parse(rd)
    if (!Number.isNaN(t) && t >= windowStartMs && t < windowEndMs) {
      candidates.push(new Date(t))
    }
  }

  const seen = new Set<number>()
  const result: Array<{ start: Date; end: Date; isRecurrence: boolean }> = []
  candidates.sort((a, b) => a.getTime() - b.getTime())
  for (const occStart of candidates) {
    const occStartMs = occStart.getTime()
    const occStartSec = Math.floor(occStartMs / 1000)
    if (exdateSet.has(occStartSec)) continue
    if (seen.has(occStartSec)) continue
    seen.add(occStartSec)
    const occEndMs = occStartMs + durationMs
    if (occStartMs < windowEndMs && occEndMs > windowStartMs) {
      result.push({
        start: new Date(occStartMs),
        end: new Date(occEndMs),
        isRecurrence: true
      })
    }
  }
  return result
}

export interface EventsListOpts {
  fromIso?: string
  toIso?: string
  calendarName?: string
  source?: 'caldav' | 'email_ics' | 'legacy_calendar_app'
  expandRecurrences?: boolean
  limit?: number
}

export function runEventsList(opts: EventsListOpts = {}): CalendarEventOccurrence[] {
  const expand = opts.expandRecurrences !== false
  const limit = opts.limit ?? 1000

  const now = new Date()
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const windowStartMs = opts.fromIso ? Date.parse(opts.fromIso) : todayUtc
  const windowEndMs = opts.toIso ? Date.parse(opts.toIso) : windowStartMs + 7 * 24 * 60 * 60 * 1000
  if (Number.isNaN(windowStartMs) || Number.isNaN(windowEndMs) || windowEndMs <= windowStartMs) {
    return []
  }

  const db = getDb()
  const clauses = ['deleted_at IS NULL']
  const params: Array<string | number> = []
  if (opts.source) {
    clauses.push('source = ?')
    params.push(opts.source)
  }
  if (opts.calendarName) {
    clauses.push('calendar_name = ?')
    params.push(opts.calendarName)
  }
  const sql = `
    SELECT id, ical_uid, recurrence_id, sequence, summary, description, location,
           organizer, attendees_json, dtstart_utc, dtend_utc, is_all_day,
           rrule, exdates_json, rdates_json, status, response_status, url,
           ics_raw, source, notion_page_id, related_email_internal_id, calendar_name
    FROM calendar_event WHERE ${clauses.join(' AND ')}
    ORDER BY dtstart_utc ASC
  `
  let rows: DbCalendarRow[] = []
  try {
    rows = db.prepare(sql).all(...params) as DbCalendarRow[]
  } catch (e) {
    console.warn('[calendar:eventsList] query failed (calendar_event table missing?):', e)
    return []
  }

  const occurrences: CalendarEventOccurrence[] = []
  for (const r of rows) {
    const expanded = expandInWindow(r, windowStartMs, windowEndMs, expand)
    for (const occ of expanded) {
      occurrences.push({
        id: r.id,
        ical_uid: r.ical_uid,
        recurrence_id: r.recurrence_id,
        sequence: r.sequence,
        summary: r.summary ?? '',
        occurrence_start_iso: occ.start.toISOString(),
        occurrence_end_iso: occ.end.toISOString(),
        is_recurrence_instance: occ.isRecurrence,
        is_all_day: !!r.is_all_day,
        calendar_name: r.calendar_name ?? '',
        organizer: r.organizer ?? '',
        attendees: parseJsonArray(r.attendees_json),
        location: r.location ?? '',
        url: r.url ?? '',
        status: r.status ?? '',
        response_status: r.response_status ?? '',
        source: r.source as CalendarEventOccurrence['source'],
        notion_page_id: r.notion_page_id,
        related_email_internal_id: r.related_email_internal_id
      })
      if (occurrences.length >= limit) break
    }
    if (occurrences.length >= limit) break
  }

  occurrences.sort(
    (a, b) => Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
  )
  return occurrences
}

export interface EventGetOpts {
  icalUid: string
  recurrenceId?: string | null
  source?: 'caldav' | 'email_ics' | 'legacy_calendar_app'
}

export function runEventGet(opts: EventGetOpts): CalendarEventRow | null {
  const db = getDb()
  const source = opts.source ?? 'caldav'
  let row: DbCalendarRow | undefined
  try {
    row = db
      .prepare(
        `SELECT id, ical_uid, recurrence_id, sequence, summary, description, location,
                organizer, attendees_json, dtstart_utc, dtend_utc, is_all_day,
                rrule, exdates_json, rdates_json, status, response_status, url,
                ics_raw, source, notion_page_id, related_email_internal_id, calendar_name
         FROM calendar_event
         WHERE ical_uid = ? AND source = ?
           AND COALESCE(recurrence_id, '') = COALESCE(?, '')
           AND deleted_at IS NULL
         LIMIT 1`
      )
      .get(opts.icalUid, source, opts.recurrenceId ?? null) as DbCalendarRow | undefined
  } catch (e) {
    console.warn('[calendar:eventGet] query failed:', e)
    return null
  }
  return row ? rowToCalendarEventRow(row) : null
}

export function runSyncStatus(): CalendarSyncStateItem[] {
  const db = getDb()
  try {
    const rows = db
      .prepare(
        `SELECT calendar_name, ctag, sync_token,
                last_full_sync_at, last_incremental_sync_at, last_error
         FROM calendar_sync_state ORDER BY calendar_name`
      )
      .all() as Array<{
      calendar_name: string
      ctag: string | null
      sync_token: string | null
      last_full_sync_at: number | null
      last_incremental_sync_at: number | null
      last_error: string | null
    }>
    return rows.map((r) => ({
      calendar_name: r.calendar_name,
      ctag: r.ctag,
      sync_token: r.sync_token,
      last_full_sync_at_iso: epochToIso(r.last_full_sync_at),
      last_incremental_sync_at_iso: epochToIso(r.last_incremental_sync_at),
      last_error: r.last_error
    }))
  } catch (e) {
    console.warn('[calendar:syncStatus] query failed:', e)
    return []
  }
}

export function runCalendarNames(): string[] {
  const db = getDb()
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT calendar_name FROM calendar_event
         WHERE calendar_name != '' AND deleted_at IS NULL
         ORDER BY calendar_name`
      )
      .all() as Array<{ calendar_name: string }>
    return rows.map((r) => r.calendar_name)
  } catch (e) {
    console.warn('[calendar:calendarNames] query failed:', e)
    return []
  }
}
