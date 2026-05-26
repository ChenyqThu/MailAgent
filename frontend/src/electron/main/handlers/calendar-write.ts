// Phase 3 §P1-c — calendar write handlers (event CRUD + RSVP + replay).
// 全部 fork CLI (callCli, needsAuth=true, 120s timeout), 不直接调 CalDAV.

import { callCli } from '../cli_runner'
import { WRITE_TIMEOUT_MS } from './calendar-shared'

// ============================================================
// Recurring replay (legacy email_ics path)
// ============================================================

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

// ============================================================
// Phase 2.4 — calendar:eventReplay (基于 calendar_event 行重导出 Notion)
// ============================================================

export interface EventReplayOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** 非空 = replay 单次跳脱 occurrence; 留空 = 主事件 (含 RRULE 整系列). */
  recurrenceId?: string | null
  /** 限定 source; 留空 = 按 caldav → email_ics → legacy 顺序自动查. */
  source?: 'caldav' | 'email_ics' | 'legacy_calendar_app'
  /** 仅查 row 列 plan, 不写 Notion (无需 auth). */
  dryRun?: boolean
}

export async function runEventReplay(opts: EventReplayOpts): Promise<unknown> {
  const args = ['calendar', 'replay', opts.icalUid]
  if (opts.recurrenceId) {
    args.push('--recurrence-id', opts.recurrenceId)
  }
  if (opts.source) {
    args.push('--source', opts.source)
  }
  if (opts.dryRun) args.push('--dry-run')
  return callCli(args, {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

// ============================================================
// Phase 2.1 — calendar:eventRsvp (发 iTIP REPLY 给 organizer)
// 通过 DavMail SMTP submission 把 text/calendar; method=REPLY 邮件发到组织者,
// Outlook/Exchange Calendar Assistant 解析后更新 organizer 端 attendee 的 PARTSTAT.
// ============================================================

export type RsvpResponse = 'accept' | 'tentative' | 'decline'

export interface EventRsvpOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** accept / tentative / decline (CLI 端 case-insensitive + 同义词). */
  response: RsvpResponse
  /** 非空 = RSVP 单次跳脱 occurrence; 留空 = 整系列. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = caldav → email_ics → legacy 自动查. */
  source?: 'caldav' | 'email_ics' | 'legacy_calendar_app'
  /** True = 仅查 row + 拼 plan, 不发 SMTP (无需 auth). */
  dryRun?: boolean
}

export async function runEventRsvp(opts: EventRsvpOpts): Promise<unknown> {
  const args = ['calendar', 'rsvp', opts.icalUid, opts.response]
  if (opts.recurrenceId) {
    args.push('--recurrence-id', opts.recurrenceId)
  }
  if (opts.source) {
    args.push('--source', opts.source)
  }
  if (opts.dryRun) args.push('--dry-run')
  return callCli(args, {
    write: !opts.dryRun,
    needsAuth: !opts.dryRun,
    timeoutMs: WRITE_TIMEOUT_MS
  })
}

// ============================================================
// Phase 2.2/2.3 — calendar event CRUD (CalDAV PUT/DELETE)
// 直接改 Exchange 端日历资源 (跟 RSVP 是不同语义: owner ops vs attendee reply).
// ============================================================

export interface EventAttendeeInput {
  email: string
  name?: string
}

export interface EventCreateOpts {
  summary: string
  /** ISO datetime with tz (必填); e.g. '2026-05-30T14:00:00+08:00' or 'Z' 结尾. */
  startIso: string
  endIso: string
  location?: string
  description?: string
  attendees?: EventAttendeeInput[]
  /** 目标 calendar 名; 留空 = 默认 (Outlook 主日历). */
  calendarName?: string
  /** 默认 CONFIRMED. */
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
  /** Phase 4·#3 — RFC 5545 RRULE; 留空 = 单次. */
  rrule?: string
  /** Phase 4·#2 — 全天事件 (start/end 用 UTC midnight Z + end exclusive). */
  isAllDay?: boolean
}

export async function runEventCreate(opts: EventCreateOpts): Promise<unknown> {
  const args = [
    'calendar',
    'create',
    '--summary',
    opts.summary,
    '--start',
    opts.startIso,
    '--end',
    opts.endIso
  ]
  if (opts.location) args.push('--location', opts.location)
  if (opts.description) args.push('--description', opts.description)
  if (opts.calendarName) args.push('--calendar', opts.calendarName)
  if (opts.status) args.push('--status', opts.status)
  if (opts.rrule) args.push('--rrule', opts.rrule)
  if (opts.isAllDay) args.push('--all-day')
  for (const a of opts.attendees || []) {
    if (!a.email) continue
    args.push('--attendee', a.name ? `${a.email},${a.name}` : a.email)
  }
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export interface EventUpdateOpts {
  icalUid: string
  /** All optional — 不传 = 保留原值. */
  summary?: string
  startIso?: string
  endIso?: string
  location?: string
  description?: string
  attendees?: EventAttendeeInput[]
  /** Phase 4·#4 — 显式清空所有与会者 (前端删光 chips); 与 attendees 互斥. */
  clearAttendees?: boolean
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
  calendarName?: string
  /** Phase 4·#3 — 改整系列 RRULE: 不传=保留; 'FREQ=...' 覆盖; '' 删除. */
  rrule?: string
  /** Phase 4·#2 — 全天状态: 不传=保持; true=全天; false=定时. */
  isAllDay?: boolean
  /** Phase 4·#3c — 改这一次 occurrence (ISO datetime); 留空 = 改整系列. */
  recurrenceId?: string
  /** Phase 4·#3d — 改未来: 配合 recurrenceId split 成新 series. */
  splitFuture?: boolean
  /** 默认 SEQUENCE +1 (RFC 5545 标准). */
  noSequenceBump?: boolean
}

export async function runEventUpdate(opts: EventUpdateOpts): Promise<unknown> {
  const args = ['calendar', 'update', opts.icalUid]
  if (opts.summary !== undefined) args.push('--summary', opts.summary)
  if (opts.startIso !== undefined) args.push('--start', opts.startIso)
  if (opts.endIso !== undefined) args.push('--end', opts.endIso)
  if (opts.location !== undefined) args.push('--location', opts.location)
  if (opts.description !== undefined) args.push('--description', opts.description)
  if (opts.status !== undefined) args.push('--status', opts.status)
  if (opts.calendarName) args.push('--calendar', opts.calendarName)
  if (opts.rrule !== undefined) args.push('--rrule', opts.rrule)
  if (opts.isAllDay !== undefined) {
    args.push(opts.isAllDay ? '--all-day' : '--no-all-day')
  }
  if (opts.recurrenceId) args.push('--recurrence-id', opts.recurrenceId)
  if (opts.splitFuture) args.push('--split-future')
  if (opts.noSequenceBump) args.push('--no-sequence-bump')
  // Phase 4·#4 — 清空与会者 (前端删光 chips); 与 --attendee 互斥 (前端逻辑保证).
  if (opts.clearAttendees) args.push('--clear-attendees')
  for (const a of opts.attendees || []) {
    if (!a.email) continue
    args.push('--attendee', a.name ? `${a.email},${a.name}` : a.email)
  }
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}

export interface EventDeleteOpts {
  icalUid: string
  calendarName?: string
}

export async function runEventDelete(opts: EventDeleteOpts): Promise<unknown> {
  const args = ['calendar', 'delete', opts.icalUid, '--yes']
  if (opts.calendarName) args.push('--calendar', opts.calendarName)
  return callCli(args, { write: true, needsAuth: true, timeoutMs: WRITE_TIMEOUT_MS })
}
