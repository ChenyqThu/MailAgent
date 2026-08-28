// @vitest-environment happy-dom
//
// task 08-27 P5 — 日/周时间轴的三源聚合接线: ① 三源条目按形态渲染 (mail 定时
// → .evt 块 / hot 源色, matter·agent 时间点 → .evt-mark 时刻标记不撑假时长,
// 全天 → 置顶 .m-band 色带); ② 点击分流 (mail → onSelect 上抛缓存 occurrence,
// matter → 事项导航, agent → 团队域); ③ 勾选接线 —— 三个视图都把 calendar-view
// store 的组开关与成员排除集传进 useCalendarAgenda。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

const { agendaSpy, agendaState, eventsState, openSpy, navSpy } = vi.hoisted(() => ({
  agendaSpy: vi.fn(),
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
    // 空态分支的 CalendarViewEmpty 会查同步链路 — 走 mock 免掉 useMailApi 依赖。
    useCalendarSyncStatus: () => ({ data: [], isLoading: false, refetch: vi.fn() })
  }
})

vi.mock('@shared/components/calendar/hooks/useCalendarAgenda', () => ({
  useCalendarAgenda: (...args: unknown[]) => {
    agendaSpy(...args)
    return {
      data: agendaState.data,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn()
    }
  },
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

import { DayView } from '../../src/shared/components/calendar/views/DayView'
import { MonthView } from '../../src/shared/components/calendar/views/MonthView'
import { WeekView } from '../../src/shared/components/calendar/views/WeekView'
import { HOUR_PX } from '../../src/shared/components/calendar/lib/timeGrid'
import { navEntry } from '../../src/shared/navigation/registry'
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

function mkOcc(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 3,
    ical_uid: 'uid-tl-3',
    recurrence_id: null,
    sequence: 0,
    summary: '普通会',
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
function mkEntry(over: Partial<AgendaEntry>): AgendaEntry {
  seq += 1
  return {
    id: `tl-${seq}`,
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

afterEach(() => {
  cleanup()
  agendaSpy.mockReset()
  openSpy.mockReset()
  navSpy.mockReset()
  agendaState.data = []
  eventsState.data = []
  useCalendarView.setState({
    sources: { ...DEFAULT_SOURCE_TOGGLES },
    excluded: emptyExclusions()
  })
})

describe('WeekView 三源渲染 (P5)', () => {
  test('mail 定时块 (含 hot 源色) + matter/agent 时刻标记 + 全天置顶色带', () => {
    eventsState.data = [mkOcc()]
    agendaState.data = [
      mkEntry({
        title: '普通会',
        eventId: 3,
        icalUid: 'uid-tl-3',
        startIso: todayAt(10).toISOString(),
        endIso: todayAt(11).toISOString(),
        calendarName: 'Work'
      }),
      mkEntry({
        title: '重要会',
        hot: true,
        eventId: 4,
        startIso: todayAt(13).toISOString(),
        endIso: todayAt(14).toISOString()
      }),
      mkEntry({
        source: 'matter',
        title: '交付截止',
        matterId: 'MAT-9',
        startIso: todayAt(15).toISOString(),
        endIso: null
      }),
      mkEntry({
        source: 'agent',
        title: '早间巡检',
        agentId: 'agent-1',
        startIso: todayAt(8).toISOString(),
        endIso: null
      }),
      mkEntry({
        title: '全天占位',
        allDay: true,
        startIso: todayAt(0).toISOString(),
        endIso: todayAt(23).toISOString()
      })
    ]
    const { container } = render(<WeekView onSelect={vi.fn()} />)

    const blocks = container.querySelectorAll('.evt')
    expect(blocks).toHaveLength(2)
    expect(Array.from(blocks).map((b) => b.getAttribute('data-src'))).toEqual(
      expect.arrayContaining(['mail', 'hot'])
    )

    // 时刻标记: 源色 + 时间文本 + top 按时刻换算 (不撑假时长 — 高度固定薄条)
    const matterMark = container.querySelector('.evt-mark[data-src="matter"]') as HTMLElement
    expect(matterMark).toBeTruthy()
    expect(matterMark.textContent).toContain('交付截止')
    expect(matterMark.textContent).toContain('15:00')
    expect(matterMark.style.top).toBe(`${15 * HOUR_PX}px`)
    expect(container.querySelector('.evt-mark[data-src="agent"]')).toBeTruthy()

    // 全天条目 → 置顶色带
    const band = container.querySelector('.m-band') as HTMLElement
    expect(band).toBeTruthy()
    expect(band.textContent).toBe('全天占位')
  })

  test('点击分流: matter → 事项导航, agent → 团队域, mail → onSelect 缓存 occurrence', () => {
    const occ = mkOcc()
    eventsState.data = [occ]
    const onSelect = vi.fn()
    agendaState.data = [
      mkEntry({
        eventId: 3,
        icalUid: 'uid-tl-3',
        startIso: todayAt(10).toISOString(),
        endIso: todayAt(11).toISOString()
      }),
      mkEntry({
        source: 'matter',
        matterId: 'MAT-9',
        startIso: todayAt(15).toISOString(),
        endIso: null
      }),
      mkEntry({
        source: 'agent',
        agentId: 'agent-1',
        startIso: todayAt(8).toISOString(),
        endIso: null
      })
    ]
    const { container } = render(<WeekView onSelect={onSelect} />)

    fireEvent.click(container.querySelector('.evt-mark[data-src="matter"]')!)
    expect(openSpy).toHaveBeenCalledWith('MAT-9')
    expect(navSpy).toHaveBeenLastCalledWith(expect.anything(), navEntry('matters'))

    fireEvent.click(container.querySelector('.evt-mark[data-src="agent"]')!)
    expect(navSpy).toHaveBeenLastCalledWith(expect.anything(), navEntry('agents'))

    fireEvent.click(container.querySelector('.evt')!)
    expect(onSelect).toHaveBeenCalledTimes(1)
    // 缓存命中 → 上抛的是同一个 occurrence 对象 (drawer 拿到全量字段)
    expect(onSelect.mock.calls[0][0]).toBe(occ)
  })
})

describe('勾选接线 — 三个视图都把 store 的组开关 + 成员排除集传进 agenda hook', () => {
  // dogfood 轮 2: 「按日历筛选」下拉与二级栏日历源树收敛成同一份 store 状态,
  // 视图不再收 selectedCalendars prop, 直接读 store (月视图曾把筛选 prop 掐掉,
  // 这里换成锁住 store 两个字段都传到位, 不再回退)。
  test.each([
    ['WeekView', () => <WeekView onSelect={vi.fn()} />],
    ['DayView', () => <DayView onSelect={vi.fn()} />],
    ['MonthView', () => <MonthView onSelect={vi.fn()} />]
  ])('%s', (_name, make) => {
    useCalendarView.setState({
      sources: { mail: true, matter: false, agent: true },
      excluded: { mail: new Set(['Team']), matter: new Set(), agent: new Set(['a-9']) }
    })
    render(make())
    expect(agendaSpy).toHaveBeenCalled()
    expect(agendaSpy.mock.calls[0][1]).toEqual({ mail: true, matter: false, agent: true })
    expect(agendaSpy.mock.calls[0][3]).toEqual({
      mail: new Set(['Team']),
      matter: new Set(),
      agent: new Set(['a-9'])
    })
  })
})
