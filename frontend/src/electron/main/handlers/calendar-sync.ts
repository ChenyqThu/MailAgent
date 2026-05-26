// Phase 3 §P1-c — calendar sync trigger + recurring expansion handlers.
// 都 fork CLI, write+auth+120s timeout.

import { callCli } from '../cli_runner'
import { WRITE_TIMEOUT_MS } from './calendar-shared'

// ============================================================
// sync-now (admin/debug 触发 CalDAV → SQLite 全/增量 sync)
// ============================================================

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

// ============================================================
// expand (周期会议 Notion mirror 滚动展开 — 单次 tick)
// ============================================================

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
