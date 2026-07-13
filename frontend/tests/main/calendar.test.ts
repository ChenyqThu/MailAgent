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
import type { DbCalendarRow } from '../../src/electron/main/handlers/calendar-shared'
import {
  __safeSenderTesting,
  __testing,
  expandInWindow,
  runCalendarExpand,
  runEventCreate,
  runEventDelete,
  runEventReplay,
  runEventRsvp,
  runEventUpdate,
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

// Phase 2.1 — calendar:eventRsvp (发 iTIP REPLY 给 organizer)
describe('calendar — runEventRsvp', () => {
  test('accept: positional + write+auth + 120s', async () => {
    mockCallCli.mockResolvedValue({ action: 'sent', to_email: 'org@x.com' })
    await runEventRsvp({ icalUid: 'uid-a', response: 'accept' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'rsvp', 'uid-a', 'accept'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('decline with recurrenceId + source', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventRsvp({
      icalUid: 'uid-x',
      response: 'decline',
      recurrenceId: '2026-05-30T10:00:00Z',
      source: 'caldav'
    })
    expect(mockCallCli).toHaveBeenCalledWith(
      [
        'calendar',
        'rsvp',
        'uid-x',
        'decline',
        '--recurrence-id',
        '2026-05-30T10:00:00Z',
        '--source',
        'caldav'
      ],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('tentative dry-run skips write+auth', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventRsvp({ icalUid: 'uid-y', response: 'tentative', dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'rsvp', 'uid-y', 'tentative', '--dry-run'],
      { write: false, needsAuth: false, timeoutMs: 120_000 }
    )
  })
})

// Phase 2.2 — calendar:eventCreate (CalDAV PUT new event)
describe('calendar — runEventCreate', () => {
  test('minimal: summary + start + end', async () => {
    mockCallCli.mockResolvedValue({ action: 'created', ical_uid: 'new-uid' })
    await runEventCreate({
      summary: 'Sync',
      startIso: '2026-05-30T14:00:00+08:00',
      endIso: '2026-05-30T15:00:00+08:00'
    })
    expect(mockCallCli).toHaveBeenCalledWith(
      [
        'calendar',
        'create',
        '--summary',
        'Sync',
        '--start',
        '2026-05-30T14:00:00+08:00',
        '--end',
        '2026-05-30T15:00:00+08:00'
      ],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('full payload: location + description + attendees + status', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventCreate({
      summary: 'Sync',
      startIso: '2026-05-30T14:00:00Z',
      endIso: '2026-05-30T15:00:00Z',
      location: 'Room A',
      description: 'Q1 plan',
      status: 'TENTATIVE',
      calendarName: 'Work',
      attendees: [
        { email: 'a@x.com', name: 'Alice' },
        { email: 'b@x.com' }
      ]
    })
    expect(mockCallCli).toHaveBeenCalledWith(
      [
        'calendar', 'create',
        '--summary', 'Sync',
        '--start', '2026-05-30T14:00:00Z',
        '--end', '2026-05-30T15:00:00Z',
        '--location', 'Room A',
        '--description', 'Q1 plan',
        '--calendar', 'Work',
        '--status', 'TENTATIVE',
        '--attendee', 'a@x.com,Alice',
        '--attendee', 'b@x.com'
      ],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('attendee with empty email is skipped', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventCreate({
      summary: 'x',
      startIso: '2026-05-30T14:00:00Z',
      endIso: '2026-05-30T15:00:00Z',
      attendees: [{ email: '' }, { email: 'real@x.com' }]
    })
    const args = mockCallCli.mock.calls[0][0]
    expect(args.filter((a) => a === '--attendee')).toHaveLength(1)
  })

  test('Phase 4·#3 — rrule 拼进 --rrule arg (创建周期事件)', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventCreate({
      summary: 'Standup',
      startIso: '2026-05-30T14:00:00Z',
      endIso: '2026-05-30T15:00:00Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO'
    })
    const args = mockCallCli.mock.calls[0][0]
    const i = args.indexOf('--rrule')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('FREQ=WEEKLY;BYDAY=MO')
  })

  test('Phase 4·#2 — isAllDay 拼 --all-day flag', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventCreate({
      summary: '假期',
      startIso: '2026-06-01T00:00:00Z',
      endIso: '2026-06-02T00:00:00Z',
      isAllDay: true
    })
    expect(mockCallCli.mock.calls[0][0]).toContain('--all-day')
  })
})

// Phase 2.3 — calendar:eventUpdate
describe('calendar — runEventUpdate', () => {
  test('uid + summary only', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', summary: 'New title' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'update', 'uid-x', '--summary', 'New title'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('multi field update + noSequenceBump', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({
      icalUid: 'uid-x',
      summary: 'New',
      startIso: '2026-05-30T14:00:00Z',
      endIso: '2026-05-30T15:00:00Z',
      location: 'Room B',
      status: 'CANCELLED',
      noSequenceBump: true
    })
    expect(mockCallCli).toHaveBeenCalledWith(
      [
        'calendar', 'update', 'uid-x',
        '--summary', 'New',
        '--start', '2026-05-30T14:00:00Z',
        '--end', '2026-05-30T15:00:00Z',
        '--location', 'Room B',
        '--status', 'CANCELLED',
        '--no-sequence-bump'
      ],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('empty location explicitly passes empty string', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', location: '' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'update', 'uid-x', '--location', ''],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('Phase 4·#3 — rrule 覆盖拼进 --rrule arg (改整系列)', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', rrule: 'FREQ=DAILY' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'update', 'uid-x', '--rrule', 'FREQ=DAILY'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('Phase 4·#3 — rrule="" 显式空串透传 (删除 RRULE 周期变单次)', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', rrule: '' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'update', 'uid-x', '--rrule', ''],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('Phase 4·#2 — isAllDay=true 拼 --all-day', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', isAllDay: true })
    expect(mockCallCli.mock.calls[0][0]).toContain('--all-day')
  })

  test('Phase 4·#2 — isAllDay=false 拼 --no-all-day', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', isAllDay: false })
    expect(mockCallCli.mock.calls[0][0]).toContain('--no-all-day')
  })

  test('Phase 4·#3c — recurrenceId 拼 --recurrence-id (改这一次)', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({
      icalUid: 'uid-x',
      summary: '改这次',
      recurrenceId: '2026-01-12T09:00:00Z'
    })
    const args = mockCallCli.mock.calls[0][0]
    const i = args.indexOf('--recurrence-id')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('2026-01-12T09:00:00Z')
  })

  test('Phase 4·#3d — splitFuture 拼 --split-future (改未来)', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({
      icalUid: 'uid-x',
      recurrenceId: '2026-02-02T09:00:00Z',
      splitFuture: true
    })
    const args = mockCallCli.mock.calls[0][0]
    expect(args).toContain('--recurrence-id')
    expect(args).toContain('--split-future')
  })

  test('Phase 4·#4 — clearAttendees 拼 --clear-attendees (清空与会者)', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({ icalUid: 'uid-x', clearAttendees: true })
    const args = mockCallCli.mock.calls[0][0]
    expect(args).toContain('--clear-attendees')
    expect(args).not.toContain('--attendee')
  })

  test('Phase 4·#4 — attendees 替换拼 --attendee, 不带 --clear-attendees', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventUpdate({
      icalUid: 'uid-x',
      attendees: [{ email: 'bob@x.com', name: 'Bob' }]
    })
    const args = mockCallCli.mock.calls[0][0]
    expect(args).toContain('--attendee')
    expect(args).not.toContain('--clear-attendees')
  })
})

// Phase 2.3 — calendar:eventDelete
describe('calendar — runEventDelete', () => {
  test('uid + --yes always passed', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventDelete({ icalUid: 'uid-x' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'delete', 'uid-x', '--yes'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('with calendarName flag', async () => {
    mockCallCli.mockResolvedValue({})
    await runEventDelete({ icalUid: 'uid-x', calendarName: 'Work' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'delete', 'uid-x', '--yes', '--calendar', 'Work'],
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

// ============================================================
// P1-1 — expandInWindow duration 语义对齐 src/calendar_sync/expander.py
// (仅 dtend <= dtstart 时兜底 1h; 短于 1h 的周期事件用真实时长)
// ============================================================
describe('calendar — expandInWindow duration (P1-1)', () => {
  // Mon 2026-01-05T09:00Z 起, 30min 周会
  const dtstartUtc = Date.UTC(2026, 0, 5, 9, 0, 0) / 1000
  const windowStartMs = Date.UTC(2026, 0, 5)
  const windowEndMs = Date.UTC(2026, 0, 19)

  function calRow(overrides: Partial<DbCalendarRow> = {}): DbCalendarRow {
    return {
      id: 1,
      ical_uid: 'uid-standup',
      recurrence_id: null,
      sequence: 0,
      summary: 'Standup',
      description: null,
      location: null,
      organizer: null,
      attendees_json: null,
      dtstart_utc: dtstartUtc,
      dtend_utc: dtstartUtc + 30 * 60,
      is_all_day: 0,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      exdates_json: null,
      rdates_json: null,
      status: null,
      response_status: null,
      url: null,
      ics_raw: null,
      source: 'caldav',
      notion_page_id: null,
      related_email_internal_id: null,
      calendar_name: '日历',
      ...overrides
    }
  }

  test('30min RRULE 事件: 每个 occurrence 恰 30 分钟, 不再被拉成 1h', () => {
    const out = expandInWindow(calRow(), windowStartMs, windowEndMs, true)
    expect(out).toHaveLength(2)
    expect(out[0]?.start.toISOString()).toBe('2026-01-05T09:00:00.000Z')
    expect(out[1]?.start.toISOString()).toBe('2026-01-12T09:00:00.000Z')
    for (const occ of out) {
      expect(occ.end.getTime() - occ.start.getTime()).toBe(30 * 60 * 1000)
      expect(occ.isRecurrence).toBe(true)
    }
  })

  test('dtend == dtstart 的 RRULE 事件兜底 1h', () => {
    const out = expandInWindow(calRow({ dtend_utc: dtstartUtc }), windowStartMs, windowEndMs, true)
    expect(out).toHaveLength(2)
    for (const occ of out) {
      expect(occ.end.getTime() - occ.start.getTime()).toBe(60 * 60 * 1000)
    }
  })

  test('缺 dtend (null) 的 RRULE 事件兜底 1h', () => {
    const out = expandInWindow(calRow({ dtend_utc: null }), windowStartMs, windowEndMs, true)
    expect(out).toHaveLength(2)
    for (const occ of out) {
      expect(occ.end.getTime() - occ.start.getTime()).toBe(60 * 60 * 1000)
    }
  })

  test('dtend < dtstart 的 RRULE 事件兜底 1h', () => {
    const out = expandInWindow(
      calRow({ dtend_utc: dtstartUtc - 10 * 60 }),
      windowStartMs,
      windowEndMs,
      true
    )
    expect(out).toHaveLength(2)
    for (const occ of out) {
      expect(occ.end.getTime() - occ.start.getTime()).toBe(60 * 60 * 1000)
    }
  })
})

// ============================================================
// F4 + F17 — assertSafeSender IPC sender frame URL allowlist
// ============================================================
describe('calendar — assertSafeSender (F4 + F17)', () => {
  const { assertSafeSender } = __safeSenderTesting

  function fakeEvent(url: string | undefined): Electron.IpcMainInvokeEvent {
    // 仅塞 senderFrame.url, 其它字段 cast 任意 (assertSafeSender 不读).
    return {
      senderFrame: url === undefined ? null : { url }
    } as unknown as Electron.IpcMainInvokeEvent
  }

  test('allow file:// (production packaged Electron)', () => {
    expect(() =>
      assertSafeSender(fakeEvent('file:///Applications/MailAgent.app/index.html'), 'calendar:test')
    ).not.toThrow()
  })

  test('allow http://localhost (vite dev server)', () => {
    expect(() =>
      assertSafeSender(fakeEvent('http://localhost:5173/'), 'calendar:test')
    ).not.toThrow()
  })

  test('allow http://127.0.0.1', () => {
    expect(() =>
      assertSafeSender(fakeEvent('http://127.0.0.1:5173/'), 'calendar:test')
    ).not.toThrow()
  })

  test('reject http://evil.com (non-allowlist origin)', () => {
    expect(() =>
      assertSafeSender(fakeEvent('http://evil.com/'), 'calendar:test')
    ).toThrow(/Rejected unexpected IPC sender/)
  })

  test('reject empty URL (F17 — Electron lifecycle 早期 / about:blank 中转防护)', () => {
    expect(() =>
      assertSafeSender(fakeEvent(''), 'calendar:test')
    ).toThrow(/Rejected unexpected IPC sender/)
  })

  test('reject null senderFrame (F17 — same defense)', () => {
    expect(() =>
      assertSafeSender(fakeEvent(undefined), 'calendar:test')
    ).toThrow(/Rejected unexpected IPC sender/)
  })

  test('reject https:// off allowlist (e.g. malicious link in webview)', () => {
    expect(() =>
      assertSafeSender(fakeEvent('https://attacker.example.com/'), 'calendar:test')
    ).toThrow()
  })
})
