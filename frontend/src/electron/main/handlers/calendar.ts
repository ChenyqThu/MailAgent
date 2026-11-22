// Legacy calendar Notion-mirror IPC handlers (recurringDiscover / recurringReplay / expand).
// Modern Calendar SSoT read/write endpoints route directly to loopback serve-api via
// ElectronApi.calendar (= HttpApi.calendar).

import { callCli } from '../cli_runner'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'
import {
  assertSafeSender,
  READ_TIMEOUT_MS,
  safeIpcHandle,
  WRITE_TIMEOUT_MS
} from './calendar-shared'

export interface RecurringInviteItem {
  ical_uid: string
  internal_id: number
  subject: string | null
  organizer: string | null
  rrule: string | null
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

export interface RecurringReplayOpts {
  internalId?: number
  ids?: number[]
  dryRun?: boolean
}

export interface CalendarExpandOpts {
  horizonWeeks?: number
  dryRun?: boolean
}

export async function runRecurringDiscover(
  opts: RecurringDiscoverOpts = {}
): Promise<RecurringInviteItem[]> {
  const args = ['calendar', 'recurring', 'discover']
  if (opts.since) args.push('--since', opts.since)
  const out = await callCli(args, { timeoutMs: READ_TIMEOUT_MS })

  let series: CliSeries[] = []
  if (Array.isArray(out)) {
    series = out as CliSeries[]
  } else if (out && typeof out === 'object') {
    const obj = out as { series?: unknown; items?: unknown }
    if (Array.isArray(obj.series)) series = obj.series as CliSeries[]
    else if (Array.isArray(obj.items)) series = obj.items as CliSeries[]
  }

  return series.map((s) => ({
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

export function registerCalendarHandlers(): void {
  safeIpcHandle('calendar:recurringDiscover', async (_evt, ...args) =>
    runRecurringDiscover((args[0] as RecurringDiscoverOpts) ?? {})
  )
  safeIpcHandle(
    'calendar:recurringReplay',
    async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
      const opts = args[0] as RecurringReplayOpts | undefined
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
  safeIpcHandle('calendar:expand', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    return envelopeFromCli(runCalendarExpand((args[0] as CalendarExpandOpts) ?? {}))
  })
}

export const __safeSenderTesting = { assertSafeSender }

export const __testing = {
  runRecurringDiscover,
  runRecurringReplay,
  runCalendarExpand,
  envelopeFromCli
}
