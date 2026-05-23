// Sprint 6 §2.2 — calendar IPC handler contract.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli } = vi.hoisted(() => ({ mockCallCli: vi.fn() }))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
      '../../src/electron/main/cli_runner'
    )
  return { ...actual, callCli: mockCallCli }
})

import { CliError } from '../../src/electron/main/cli_runner'
import {
  __testing,
  runCalendarExpand,
  runEventReplay,
  runRecurringDiscover,
  runRecurringReplay
} from '../../src/electron/main/handlers/calendar'

beforeEach(() => {
  mockCallCli.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('calendar — runRecurringDiscover', () => {
  test('no opts → no flags', async () => {
    mockCallCli.mockResolvedValue([])
    await runRecurringDiscover()
    expect(mockCallCli).toHaveBeenCalledWith(['calendar', 'recurring', 'discover'], {
      timeoutMs: 30_000
    })
  })

  test('since flag forwarded', async () => {
    mockCallCli.mockResolvedValue([])
    await runRecurringDiscover({ since: '2026-01-01' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'discover', '--since', '2026-01-01'],
      { timeoutMs: 30_000 }
    )
  })

  test('maps CLI series shape → RecurringInviteItem (Phase 1.5)', async () => {
    mockCallCli.mockResolvedValue({
      series: [
        {
          series_uid: 'uid-weekly',
          master_dtstart: '2026-05-22T09:00:00+00:00',
          summary: 'Weekly sync',
          sender: 'boss@example.com',
          organizer: 'boss@example.com',
          rrule: 'FREQ=WEEKLY;COUNT=10',
          method: 'REQUEST',
          internal_ids: [53120, 53121]
        }
      ],
      total_series: 1
    })
    const out = await runRecurringDiscover()
    expect(out).toEqual([
      {
        // Phase 2.4 — ical_uid = series_uid (= vEvent UID) for new eventReplay path
        ical_uid: 'uid-weekly',
        internal_id: 53120,
        subject: 'Weekly sync',
        organizer: 'boss@example.com',
        rrule: 'FREQ=WEEKLY;COUNT=10',
        notion_page_id: null,
        first_occurrence: '2026-05-22T09:00:00+00:00',
        last_occurrence: null,
        occurrence_count: 2,
        date_received: null
      }
    ])
  })

  test('caldav-only event (internal_ids=[0]) maps to internal_id=0', async () => {
    mockCallCli.mockResolvedValue({
      series: [
        {
          series_uid: 'uid-caldav-only',
          master_dtstart: '2026-04-24T00:30:00+00:00',
          summary: 'SaaS 项目双周对齐会议',
          sender: '',
          organizer: '',
          rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
          method: 'REQUEST',
          internal_ids: [0]
        }
      ],
      total_series: 1
    })
    const out = await runRecurringDiscover()
    expect(out).toHaveLength(1)
    expect(out[0]?.internal_id).toBe(0)
    expect(out[0]?.subject).toBe('SaaS 项目双周对齐会议')
    // Phase 2.4: caldav-only events 也有 ical_uid (= series_uid),
    // Replay 走 eventReplay 不再因 internal_id=0 被禁
    expect(out[0]?.ical_uid).toBe('uid-caldav-only')
  })

  test('legacy {items} shape still works (back-compat)', async () => {
    mockCallCli.mockResolvedValue({
      items: [
        {
          series_uid: 'uid-1',
          master_dtstart: null,
          summary: 'legacy',
          sender: null,
          organizer: null,
          rrule: null,
          method: null,
          internal_ids: [42]
        }
      ]
    })
    const out = await runRecurringDiscover()
    expect(out).toHaveLength(1)
    expect(out[0]?.internal_id).toBe(42)
  })

  test('returns [] for malformed object', async () => {
    mockCallCli.mockResolvedValue({ other: 1 })
    expect(await runRecurringDiscover()).toEqual([])
  })
})

describe('calendar — runRecurringReplay', () => {
  test('internalId path: write+auth + 120s', async () => {
    mockCallCli.mockResolvedValue({})
    await runRecurringReplay({ internalId: 42 })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'replay', '--internal-id', '42'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('ids path: joins with comma', async () => {
    mockCallCli.mockResolvedValue({})
    await runRecurringReplay({ ids: [1, 2, 3] })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'replay', '--ids', '1,2,3'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('dry-run skips write+auth + adds --dry-run', async () => {
    mockCallCli.mockResolvedValue({})
    await runRecurringReplay({ internalId: 42, dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'replay', '--internal-id', '42', '--dry-run'],
      { write: false, needsAuth: false, timeoutMs: 120_000 }
    )
  })
})

// Phase 2.4 — calendar:eventReplay (基于 calendar_event 行重导出 Notion)
describe('calendar — runEventReplay', () => {
  test('icalUid only: positional + write+auth + 120s', async () => {
    mockCallCli.mockResolvedValue({ action: 'created', page_id: 'p1' })
    await runEventReplay({ icalUid: 'uid-abc' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'replay', 'uid-abc'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('with recurrenceId + source', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventReplay({
      icalUid: 'uid-x',
      recurrenceId: '2026-05-30T10:00:00Z',
      source: 'caldav'
    })
    expect(mockCallCli).toHaveBeenCalledWith(
      [
        'calendar',
        'replay',
        'uid-x',
        '--recurrence-id',
        '2026-05-30T10:00:00Z',
        '--source',
        'caldav'
      ],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('dry-run skips write+auth + adds --dry-run', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventReplay({ icalUid: 'uid-x', dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'replay', 'uid-x', '--dry-run'],
      { write: false, needsAuth: false, timeoutMs: 120_000 }
    )
  })

  test('source=email_ics is passed through', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventReplay({ icalUid: 'u', source: 'email_ics' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'replay', 'u', '--source', 'email_ics'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })
})

describe('calendar — runCalendarExpand', () => {
  test('default: write+auth no horizon', async () => {
    mockCallCli.mockResolvedValue({})
    await runCalendarExpand()
    expect(mockCallCli).toHaveBeenCalledWith(['calendar', 'expand'], {
      write: true,
      needsAuth: true,
      timeoutMs: 120_000
    })
  })

  test('horizonWeeks + dryRun', async () => {
    mockCallCli.mockResolvedValue({})
    await runCalendarExpand({ horizonWeeks: 4, dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'expand', '--horizon-weeks', '4', '--dry-run'],
      { write: false, needsAuth: false, timeoutMs: 120_000 }
    )
  })
})

describe('calendar — envelope', () => {
  test('rolls CliError into ok:false with code', async () => {
    const env = await __testing.envelopeFromCli(
      Promise.reject(new CliError('E_PM2_CONFLICT', 9, undefined))
    )
    expect(env).toMatchObject({ ok: false, code: 'E_PM2_CONFLICT' })
  })

  test('rolls success into ok:true', async () => {
    const env = await __testing.envelopeFromCli(Promise.resolve({ replayed: 1 }))
    expect(env).toEqual({ ok: true, data: { replayed: 1 } })
  })
})
