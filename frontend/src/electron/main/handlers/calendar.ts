// Sprint 6 §2.2 — calendar (recurring meeting) IPC handlers.
// Phase 3 §3.1 (frontend-view-silly-knuth.md) — 扩展 5 个 calendar SSoT handler:
//   - calendar:eventsList      — 直读 SQLite calendar_event, RRULE 展开窗口内 occurrences
//   - calendar:eventGet        — 单 event 详情 (by ical_uid + recurrence_id + source)
//   - calendar:syncStatus      — 读 calendar_sync_state 表
//   - calendar:syncTrigger     — 手动跑一次 `mailagent calendar sync-now` (write+auth)
//   - calendar:calendarNames   — distinct calendar_name 列表
//
// 老 Sprint 6 handler (recurringDiscover / recurringReplay / expand) 保留作 /calendar/recurring
// 运维页用. 新 handler 走 better-sqlite3 直读 (Sprint 16 模式), ~5ms 路径; 写命令仍 fork CLI.

import { ipcMain } from 'electron'
// rrule 是 CJS 包, ESM 下没 named export — 必须 default import 再解构.
import rrulePkg from 'rrule'

import { callCli } from '../cli_runner'
import { getDb } from '../db'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'

const { rrulestr } = rrulePkg

const READ_TIMEOUT_MS = 30_000
const WRITE_TIMEOUT_MS = 120_000

export interface RecurringInviteItem {
  /** Source email (the meeting invite carrier). */
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

export async function runRecurringDiscover(
  opts: RecurringDiscoverOpts = {}
): Promise<RecurringInviteItem[]> {
  const args = ['calendar', 'recurring', 'discover']
  if (opts.since) args.push('--since', opts.since)
  const out = await callCli(args, { timeoutMs: READ_TIMEOUT_MS })
  if (Array.isArray(out)) return out as RecurringInviteItem[]
  if (out && typeof out === 'object' && Array.isArray((out as { items?: unknown }).items)) {
    return (out as { items: RecurringInviteItem[] }).items
  }
  return []
}

export interface RecurringReplayOpts {
  internalId?: number
  ids?: number[]
  dryRun?: boolean
}

export async function runRecurringReplay(opts: RecurringReplayOpts): Promise<unknown> {
  const args = ['calendar', 'recurring', 'replay']
  if (opts.internalId !== undefined) {
    args.push('--internal-id', String(opts.internalId))
  } else if (opts.ids && opts.ids.length > 0) {
    args.push('--ids', opts.ids.join(','))
  }
  if (opts.dryRun) args.push('--dry-run')
  return callCli(args, {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

export interface CalendarExpandOpts {
  horizonWeeks?: number
  dryRun?: boolean
}

export async function runCalendarExpand(opts: CalendarExpandOpts = {}): Promise<unknown> {
  const args = ['calendar', 'expand']
  if (opts.horizonWeeks !== undefined) {
    args.push('--horizon-weeks', String(opts.horizonWeeks))
  }
  if (opts.dryRun) args.push('--dry-run')
  return callCli(args, {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

// ============================================================
// Phase 3 §3.1 — Calendar SSoT IPC handlers (better-sqlite3 直读)
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

interface DbCalendarRow {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string | null
  description: string | null
  location: string | null
  organizer: string | null
  attendees_json: string | null
  dtstart_utc: number
  dtend_utc: number | null
  is_all_day: number
  rrule: string | null
  exdates_json: string | null
  rdates_json: string | null
  status: string | null
  response_status: string | null
  url: string | null
  ics_raw: string | null
  source: string
  notion_page_id: string | null
  related_email_internal_id: number | null
  calendar_name: string | null
}

function epochToIso(epoch: number | null): string | null {
  if (epoch == null || Number.isNaN(epoch)) return null
  return new Date(epoch * 1000).toISOString()
}

function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
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
 *
 * 注意: rrule lib 接受 Date 对象 (本机 TZ 解释), 但服务端 dtstart 是 UTC epoch.
 * 我们在 Date 构造时直接用 epoch ms (UTC 准的), 展开结果也是 UTC Date.
 */
const MAX_OCCURRENCES_PER_RRULE = 500

function expandInWindow(
  row: DbCalendarRow,
  windowStartMs: number,
  windowEndMs: number,
  expandRecurrences: boolean
): Array<{ start: Date; end: Date; isRecurrence: boolean }> {
  const dtstartMs = row.dtstart_utc * 1000
  const dtendMs = row.dtend_utc != null ? row.dtend_utc * 1000 : dtstartMs + 60 * 60 * 1000
  const durationMs = Math.max(dtendMs - dtstartMs, 60 * 60 * 1000)

  if (!row.rrule || !expandRecurrences) {
    // 单次 — overlap 判断
    if (dtstartMs < windowEndMs && dtendMs > windowStartMs) {
      return [{ start: new Date(dtstartMs), end: new Date(dtendMs), isRecurrence: false }]
    }
    return []
  }

  // RRULE 展开
  let rruleStr = row.rrule.trim()
  if (rruleStr.toUpperCase().startsWith('RRULE:')) {
    rruleStr = rruleStr.slice(6)
  }
  let rule: ReturnType<typeof rrulestr>
  try {
    rule = rrulestr(`RRULE:${rruleStr}`, { dtstart: new Date(dtstartMs) })
  } catch {
    // 解析失败 — fallback 单次
    if (dtstartMs < windowEndMs && dtendMs > windowStartMs) {
      return [{ start: new Date(dtstartMs), end: new Date(dtendMs), isRecurrence: false }]
    }
    return []
  }

  // 拉窗口内 candidates (rrule.between 不含 dtstart 默认; 用 after - duration 防漏)
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

  // EXDATE 跳过 (秒级精度匹配)
  const exdateSet = new Set<number>()
  for (const ex of parseJsonArray<string>(row.exdates_json)) {
    const t = Date.parse(ex)
    if (!Number.isNaN(t)) exdateSet.add(Math.floor(t / 1000))
  }
  // RDATE 额外加
  for (const rd of parseJsonArray<string>(row.rdates_json)) {
    const t = Date.parse(rd)
    if (!Number.isNaN(t) && t >= windowStartMs && t < windowEndMs) {
      candidates.push(new Date(t))
    }
  }

  // 去重 + 排序 + 过滤
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
  const windowEndMs = opts.toIso
    ? Date.parse(opts.toIso)
    : windowStartMs + 7 * 24 * 60 * 60 * 1000
  if (
    Number.isNaN(windowStartMs) ||
    Number.isNaN(windowEndMs) ||
    windowEndMs <= windowStartMs
  ) {
    return []
  }

  // Pull all non-deleted rows in same date range OR with RRULE — for simplicity,
  // pull every active row (typical user <2000 calendar events) + let expander filter.
  // Optimization: WHERE dtstart_utc < we OR rrule != '' — Phase 4 if needed.
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
    // schema 未升级或表不存在 (用户尚未启用 calendar_sync_enabled), 返回空
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
    (a, b) =>
      Date.parse(a.occurrence_start_iso) - Date.parse(b.occurrence_start_iso)
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

export interface SyncNowOpts {
  full?: boolean
  calendarName?: string
}

export async function runSyncNow(opts: SyncNowOpts = {}): Promise<unknown> {
  const args = ['calendar', 'sync-now']
  if (opts.full === false) args.push('--incremental')
  if (opts.calendarName) args.push('--calendar', opts.calendarName)
  return callCli(args, {
    write: true,
    needsAuth: true,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

export function registerCalendarHandlers(): void {
  ipcMain.handle(
    'calendar:recurringDiscover',
    async (_evt, opts: RecurringDiscoverOpts = {}): Promise<RecurringInviteItem[]> => {
      return runRecurringDiscover(opts ?? {})
    }
  )
  ipcMain.handle(
    'calendar:recurringReplay',
    async (_evt, opts: RecurringReplayOpts): Promise<WriteEnvelope<unknown>> => {
      // Require at least one of internalId / ids — empty replay would just
      // burn a subprocess so we fail early.
      if (opts == null || (opts.internalId === undefined && (!opts.ids || opts.ids.length === 0))) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'calendar:recurringReplay requires internalId or ids[]'
        }
      }
      return envelopeFromCli(runRecurringReplay(opts))
    }
  )
  ipcMain.handle(
    'calendar:expand',
    async (_evt, opts: CalendarExpandOpts = {}): Promise<WriteEnvelope<unknown>> => {
      return envelopeFromCli(runCalendarExpand(opts ?? {}))
    }
  )

  // Phase 3 §3.1 — SSoT 直读 handlers (better-sqlite3 + npm rrule)
  ipcMain.handle(
    'calendar:eventsList',
    async (_evt, opts: EventsListOpts = {}): Promise<CalendarEventOccurrence[]> => {
      return runEventsList(opts ?? {})
    }
  )
  ipcMain.handle(
    'calendar:eventGet',
    async (_evt, opts: EventGetOpts): Promise<CalendarEventRow | null> => {
      if (!opts || !opts.icalUid) return null
      return runEventGet(opts)
    }
  )
  ipcMain.handle(
    'calendar:syncStatus',
    async (): Promise<CalendarSyncStateItem[]> => runSyncStatus()
  )
  ipcMain.handle(
    'calendar:calendarNames',
    async (): Promise<string[]> => runCalendarNames()
  )
  ipcMain.handle(
    'calendar:syncTrigger',
    async (_evt, opts: SyncNowOpts = {}): Promise<WriteEnvelope<unknown>> => {
      return envelopeFromCli(runSyncNow(opts ?? {}))
    }
  )
}

export const __testing = {
  runRecurringDiscover,
  runRecurringReplay,
  runCalendarExpand,
  runEventsList,
  runEventGet,
  runSyncStatus,
  runCalendarNames,
  runSyncNow,
  expandInWindow,
  envelopeFromCli
}
