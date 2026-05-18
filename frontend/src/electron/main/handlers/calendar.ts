// Sprint 6 §2.2 — calendar (recurring meeting) IPC handlers.
//
// Surface for `/calendar` route:
//   - calendar:recurringDiscover — `mailagent calendar recurring discover --since DATE`
//   - calendar:recurringReplay   — `mailagent calendar recurring replay --internal-id N`
//                                  (write+auth)
//   - calendar:expand            — `mailagent calendar expand` (write+auth, expansion tick)

import { ipcMain } from 'electron'

import { CliError, callCli } from '../cli_runner'

type WriteEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string }

function envelopeFromCli<T>(p: Promise<unknown>): Promise<WriteEnvelope<T>> {
  return p.then(
    (data): WriteEnvelope<T> => ({ ok: true, data: data as T }),
    (err: unknown): WriteEnvelope<T> => {
      if (err instanceof CliError) {
        return { ok: false, code: err.errorCode, message: err.message, hint: err.hint }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, code: 'E_DISPATCH', message }
    }
  )
}

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
}

export const __testing = {
  runRecurringDiscover,
  runRecurringReplay,
  runCalendarExpand,
  envelopeFromCli
}
