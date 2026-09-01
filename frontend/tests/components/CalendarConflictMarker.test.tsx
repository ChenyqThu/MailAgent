// @vitest-environment happy-dom
//
// task 08-27 P5 — 时间冲突标识的渲染面接线: 日/周时间轴事件块 (.evt) 与议程行
// (.ag-row) 都从 lib/conflict 的同一份判据取标, 且 mail↔mail 之外的一律不标。
//
// 判据本身的边界 (半开区间 / 状态排除 / 全天跨天不参与) 在
// tests/shared/calendar-conflict.test.ts 逐条覆盖; 这里只验「视图确实按那份判据
// 打标」—— 两处都做, 是因为它们各自建候选 (日列内 vs 整个窗口), 接错一处不会被
// 另一处发现。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

const { agendaState, eventsState, openSpy, navSpy } = vi.hoisted(() => ({
  agendaState: { data: [] as AgendaEntry[] },
  eventsState: { data: [] as CalendarEventOccurrence[] },
  openSpy: vi.fn(),
  navSpy: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown, vars?: Record<string, unknown>) => {
      let s = typeof dflt === 'string' ? dflt : String(_k)
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replaceAll(`{${k}}`, String(v))
        }
      }
      return s
    }
  })
}))

vi.mock('@shared/lib/gsap', () => ({
  DUR: { fast: 0.12, base: 0.22, slow: 0.38 },
  gsap: { from: vi.fn() },
  useGSAP: () => {}
}))
vi.mock('@shared/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }))

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/shared/components/calendar/hooks/useCalendarEvents')
    >()
  return {
    ...actual,
    useCalendarEventsInWindow: () => ({
      data: eventsState.data,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn()
    }),
    useCalendarSyncStatus: () => ({ data: [], isLoading: false, refetch: vi.fn() })
  }
})

vi.mock('@shared/components/calendar/hooks/useCalendarAgenda', () => ({
  useCalendarAgenda: () => ({
    data: agendaState.data,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn()
  }),
  localOlsonTz: () => 'UTC'
}))

vi.mock('@shared/components/matters/navigation', () => ({
  useMatterNavigation: { getState: () => ({ open: openSpy }) }
}))

vi.mock('@shared/navigation/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/navigation/registry')>()
  return { ...actual, navigateToNavEntry: navSpy }
})

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

import { AgendaView } from '../../src/shared/components/calendar/views/AgendaView'
import { DayView } from '../../src/shared/components/calendar/views/DayView'
import { useAgendaDetail } from '../../src/shared/state/calendar-agenda-detail'
import {
  useCalendarView,
  DEFAULT_SOURCE_TOGGLES,
  emptyExclusions
} from '../../src/shared/state/calendar-view'

function todayAt(hour: number, minute = 0): Date {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d
}

let occSeq = 0
function mkOcc(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  occSeq += 1
  return {
    id: occSeq,
    ical_uid: `uid-cf-${occSeq}`,
    recurrence_id: null,
    sequence: 0,
    summary: '会议',
    occurrence_start_iso: todayAt(10).toISOString(),
    occurrence_end_iso: todayAt(11).toISOString(),
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: 'Work',
    organizer: 'me@example.test',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: 'ACCEPTED',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null,
    ...over
  }
}

let seq = 0
function mkEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  seq += 1
  return {
    id: `cf-${seq}`,
    source: 'mail',
    hot: false,
    title: `条目 ${seq}`,
    startIso: todayAt(9).toISOString(),
    endIso: todayAt(10).toISOString(),
    allDay: false,
    multiDay: false,
    ...over
  }
}

/** 一对压在一起的会 (10:00-11:00 与 10:30-11:30) + 一场无关的 (14:00-15:00)。 */
function overlappingPairPlusLoner(): void {
  eventsState.data = [
    mkOcc({ id: 11, ical_uid: 'uid-cf-11', summary: '评审会' }),
    mkOcc({
      id: 12,
      ical_uid: 'uid-cf-12',
      summary: '客户电话',
      occurrence_start_iso: todayAt(10, 30).toISOString(),
      occurrence_end_iso: todayAt(11, 30).toISOString()
    }),
    mkOcc({
      id: 13,
      ical_uid: 'uid-cf-13',
      summary: '独自一场',
      occurrence_start_iso: todayAt(14).toISOString(),
      occurrence_end_iso: todayAt(15).toISOString()
    })
  ]
  agendaState.data = [
    mkEntry({
      title: '评审会',
      eventId: 11,
      icalUid: 'uid-cf-11',
      startIso: todayAt(10).toISOString(),
      endIso: todayAt(11).toISOString()
    }),
    mkEntry({
      title: '客户电话',
      eventId: 12,
      icalUid: 'uid-cf-12',
      startIso: todayAt(10, 30).toISOString(),
      endIso: todayAt(11, 30).toISOString()
    }),
    mkEntry({
      title: '独自一场',
      eventId: 13,
      icalUid: 'uid-cf-13',
      startIso: todayAt(14).toISOString(),
      endIso: todayAt(15).toISOString()
    })
  ]
}

afterEach(() => {
  cleanup()
  useAgendaDetail.getState().close()
  openSpy.mockReset()
  navSpy.mockReset()
  agendaState.data = []
  eventsState.data = []
  useCalendarView.setState({
    sources: { ...DEFAULT_SOURCE_TOGGLES },
    excluded: emptyExclusions()
  })
})

describe('日视图时间轴事件块的冲突标识', () => {
  test('压在一起的两场各出一枚标识, 不冲突的那场没有', () => {
    overlappingPairPlusLoner()
    const { container } = render(<DayView onSelect={vi.fn()} />)

    const marked = Array.from(container.querySelectorAll('.evt')).filter((el) =>
      el.querySelector('.cal-conflict')
    )
    expect(marked).toHaveLength(2)
    expect(marked.map((el) => el.querySelector('.e-title')?.textContent)).toEqual([
      '评审会',
      '客户电话'
    ])
    // 标识说得出「与几场重叠」, 不是一个没有信息的感叹号
    expect(marked[0].querySelector('.cal-conflict')?.getAttribute('aria-label')).toBe(
      '与 1 场日程重叠'
    )
  })

  test('事项截止落在会议时段里也不标 —— 冲突只算 mail↔mail', () => {
    eventsState.data = [mkOcc({ id: 21, ical_uid: 'uid-cf-21' })]
    agendaState.data = [
      mkEntry({
        title: '评审会',
        eventId: 21,
        icalUid: 'uid-cf-21',
        startIso: todayAt(10).toISOString(),
        endIso: todayAt(11).toISOString()
      }),
      mkEntry({
        source: 'matter',
        title: '交付截止',
        matterId: 'MAT-1',
        startIso: todayAt(10, 20).toISOString(),
        endIso: null
      })
    ]
    const { container } = render(<DayView onSelect={vi.fn()} />)

    expect(container.querySelectorAll('.evt-mark')).toHaveLength(1) // 事项时刻标记在场
    expect(container.querySelectorAll('.cal-conflict')).toHaveLength(0)
  })

  test('自己已拒的那场不占时间, 两边都不标', () => {
    overlappingPairPlusLoner()
    eventsState.data = eventsState.data.map((o) =>
      o.id === 12 ? { ...o, response_status: 'DECLINED' } : o
    )
    const { container } = render(<DayView onSelect={vi.fn()} />)

    expect(container.querySelectorAll('.cal-conflict')).toHaveLength(0)
  })
})

describe('议程行的冲突标识', () => {
  test('同一份判据: 压在一起的两行标, 独自一场不标', () => {
    overlappingPairPlusLoner()
    const { container } = render(<AgendaView onSelect={vi.fn()} />)

    const marked = Array.from(container.querySelectorAll('.ag-row')).filter((el) =>
      el.querySelector('.cal-conflict')
    )
    expect(marked.map((el) => el.querySelector('.ag-title')?.textContent)).toEqual([
      '评审会',
      '客户电话'
    ])
  })

  test('暂定仍然占时间 = 照标 (还没推掉就还在日程上)', () => {
    overlappingPairPlusLoner()
    eventsState.data = eventsState.data.map((o) =>
      o.id === 12 ? { ...o, response_status: 'TENTATIVE' } : o
    )
    const { container } = render(<AgendaView onSelect={vi.fn()} />)

    expect(container.querySelectorAll('.cal-conflict')).toHaveLength(2)
  })

  test('全天条目不参与 —— 它跟当天一切都相交, 算进去就成了天天冲突', () => {
    eventsState.data = [
      mkOcc({ id: 31, ical_uid: 'uid-cf-31' }),
      mkOcc({ id: 32, ical_uid: 'uid-cf-32', is_all_day: true })
    ]
    agendaState.data = [
      mkEntry({
        title: '评审会',
        eventId: 31,
        icalUid: 'uid-cf-31',
        startIso: todayAt(10).toISOString(),
        endIso: todayAt(11).toISOString()
      }),
      mkEntry({
        title: '团建日',
        eventId: 32,
        icalUid: 'uid-cf-32',
        allDay: true,
        startIso: todayAt(0).toISOString(),
        endIso: todayAt(23, 59).toISOString()
      })
    ]
    const { container } = render(<AgendaView onSelect={vi.fn()} />)

    expect(container.querySelectorAll('.ag-row').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelectorAll('.cal-conflict')).toHaveLength(0)
  })
})
