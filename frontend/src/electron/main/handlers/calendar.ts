// Phase 3 §P1-c — calendar handler 入口 + 注册 + re-export.
//
// 实现拆到 3 个子文件:
// - calendar-read.ts     — eventsList / eventGet / syncStatus / calendarNames /
//                          recurringDiscover (better-sqlite3 直读, ~5ms)
// - calendar-write.ts    — eventReplay / eventRsvp / eventCreate / Update /
//                          Delete / recurringReplay (fork CLI write+auth+120s)
// - calendar-sync.ts     — syncTrigger / expand (fork CLI write+auth+120s)
// - calendar-shared.ts   — safeIpcHandle / assertSafeSender / 时区/JSON helpers
//
// 本文件:
// 1. registerCalendarHandlers() — ipcMain 通道注册 (主进程入口调)
// 2. re-export 子文件的 run* 函数 + 类型给测试 / 其它模块用
// 3. __testing / __safeSenderTesting — vitest 用的内部 hook
//
// 老 Sprint 6 IPC channel (recurringDiscover / recurringReplay / expand) 保留作
// /calendar/recurring 运维页用. 新 Phase 3 SSoT 通道走 better-sqlite3 直读.

import { assertSafeSender, safeIpcHandle } from './calendar-shared'

import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'

// Read handlers + types
import {
  expandInWindow,
  runCalendarNames,
  runEventGet,
  runEventsList,
  runRecurringDiscover,
  runSyncStatus,
  type CalendarEventOccurrence,
  type CalendarEventRow,
  type CalendarSyncStateItem,
  type EventGetOpts,
  type EventsListOpts,
  type RecurringDiscoverOpts,
  type RecurringInviteItem
} from './calendar-read'

// Write handlers + types
import {
  runEventCreate,
  runEventDelete,
  runEventReplay,
  runEventRsvp,
  runEventUpdate,
  runRecurringReplay,
  type EventAttendeeInput,
  type EventCreateOpts,
  type EventDeleteOpts,
  type EventReplayOpts,
  type EventRsvpOpts,
  type EventUpdateOpts,
  type RecurringReplayOpts,
  type RsvpResponse
} from './calendar-write'

// Sync handlers + types
import {
  runCalendarExpand,
  runSyncNow,
  type CalendarExpandOpts,
  type SyncNowOpts
} from './calendar-sync'

// Re-export everything that callers (other handlers / tests / IPC bridge) need.
export {
  expandInWindow,
  runCalendarExpand,
  runCalendarNames,
  runEventCreate,
  runEventDelete,
  runEventGet,
  runEventReplay,
  runEventRsvp,
  runEventsList,
  runEventUpdate,
  runRecurringDiscover,
  runRecurringReplay,
  runSyncNow,
  runSyncStatus
}

export type {
  CalendarEventOccurrence,
  CalendarEventRow,
  CalendarExpandOpts,
  CalendarSyncStateItem,
  EventAttendeeInput,
  EventCreateOpts,
  EventDeleteOpts,
  EventGetOpts,
  EventReplayOpts,
  EventRsvpOpts,
  EventUpdateOpts,
  EventsListOpts,
  RecurringDiscoverOpts,
  RecurringInviteItem,
  RecurringReplayOpts,
  RsvpResponse,
  SyncNowOpts
}

export function registerCalendarHandlers(): void {
  safeIpcHandle('calendar:recurringDiscover', async (_evt, ...args) =>
    runRecurringDiscover((args[0] as RecurringDiscoverOpts) ?? {})
  )
  safeIpcHandle(
    'calendar:recurringReplay',
    async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
      const opts = args[0] as RecurringReplayOpts | undefined
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
  safeIpcHandle('calendar:expand', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    return envelopeFromCli(runCalendarExpand((args[0] as CalendarExpandOpts) ?? {}))
  })

  // Phase 3 §3.1 — SSoT 直读 handlers (better-sqlite3 + npm rrule)
  safeIpcHandle('calendar:eventsList', async (_evt, ...args) =>
    runEventsList((args[0] as EventsListOpts) ?? {})
  )
  safeIpcHandle('calendar:eventGet', async (_evt, ...args): Promise<CalendarEventRow | null> => {
    const opts = args[0] as EventGetOpts | undefined
    if (!opts || !opts.icalUid) return null
    return runEventGet(opts)
  })
  safeIpcHandle('calendar:syncStatus', async () => runSyncStatus())
  safeIpcHandle('calendar:calendarNames', async () => runCalendarNames())
  safeIpcHandle(
    'calendar:syncTrigger',
    async (_evt, ...args): Promise<WriteEnvelope<unknown>> =>
      envelopeFromCli(runSyncNow((args[0] as SyncNowOpts) ?? {}))
  )
  // Phase 2.4 — calendar:eventReplay (基于 calendar_event 重导出 Notion)
  safeIpcHandle('calendar:eventReplay', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    const opts = args[0] as EventReplayOpts | undefined
    if (!opts || !opts.icalUid) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'calendar:eventReplay requires icalUid'
      }
    }
    return envelopeFromCli(runEventReplay(opts))
  })
  // Phase 2.1 — calendar:eventRsvp (发 iTIP REPLY 给 organizer)
  safeIpcHandle('calendar:eventRsvp', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    const opts = args[0] as EventRsvpOpts | undefined
    if (!opts || !opts.icalUid) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'calendar:eventRsvp requires icalUid'
      }
    }
    if (!opts.response || !['accept', 'tentative', 'decline'].includes(opts.response)) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: `calendar:eventRsvp response must be accept/tentative/decline, got ${opts.response}`
      }
    }
    return envelopeFromCli(runEventRsvp(opts))
  })
  // Phase 2.2 — calendar:eventCreate (CalDAV PUT 新建事件)
  safeIpcHandle('calendar:eventCreate', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    const opts = args[0] as EventCreateOpts | undefined
    if (!opts || !opts.summary || !opts.startIso || !opts.endIso) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'calendar:eventCreate requires summary + startIso + endIso'
      }
    }
    return envelopeFromCli(runEventCreate(opts))
  })
  // Phase 2.3 — calendar:eventUpdate (CalDAV PUT 更新事件)
  safeIpcHandle('calendar:eventUpdate', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    const opts = args[0] as EventUpdateOpts | undefined
    if (!opts || !opts.icalUid) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'calendar:eventUpdate requires icalUid'
      }
    }
    return envelopeFromCli(runEventUpdate(opts))
  })
  // Phase 2.3 — calendar:eventDelete (CalDAV DELETE 删除事件)
  safeIpcHandle('calendar:eventDelete', async (_evt, ...args): Promise<WriteEnvelope<unknown>> => {
    const opts = args[0] as EventDeleteOpts | undefined
    if (!opts || !opts.icalUid) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'calendar:eventDelete requires icalUid'
      }
    }
    return envelopeFromCli(runEventDelete(opts))
  })
}

// F4 export for unit testing the sender check
export const __safeSenderTesting = { assertSafeSender }

export const __testing = {
  runRecurringDiscover,
  runRecurringReplay,
  runCalendarExpand,
  runEventsList,
  runEventGet,
  runSyncStatus,
  runCalendarNames,
  runSyncNow,
  runEventReplay,
  runEventRsvp,
  runEventCreate,
  runEventUpdate,
  runEventDelete,
  expandInWindow,
  envelopeFromCli
}
