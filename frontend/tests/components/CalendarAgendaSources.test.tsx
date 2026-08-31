// @vitest-environment happy-dom
//
// task 08-27 P4d — 日程视图接三源: ① 每行按源着色 (data-src: mail/hot/matter/agent)
// 且事项 / Agent 条目带来源标; ② 点击分流复用 useAgendaEntryClick (mail 上抛同
// 窗口缓存里的 occurrence 开抽屉, matter / agent 落投影槽位同样开抽屉); ③ 勾选接线
// —— 组开关与成员排除集都从 calendar-view store 传进 useCalendarAgenda, 否则日历
// 树上勾掉的东西在日程视图还看得见。

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
    })
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

import { AgendaView } from '../../src/shared/components/calendar/views/AgendaView'
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

function mkOcc(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 7,
    ical_uid: 'uid-ag-7',
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
function mkEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  seq += 1
  return {
    id: `ags-${seq}`,
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
  useAgendaDetail.getState().close()
  useCalendarView.setState({
    sources: { ...DEFAULT_SOURCE_TOGGLES },
    excluded: emptyExclusions()
  })
})

describe('AgendaView 三源渲染', () => {
  test('每行按源着色; 事项 / Agent 带来源标, 邮箱日程不带', () => {
    agendaState.data = [
      mkEntry({ title: '普通会', eventId: 7, icalUid: 'uid-ag-7', calendarName: 'Work' }),
      mkEntry({
        title: '重要会',
        hot: true,
        eventId: 8,
        startIso: todayAt(11).toISOString(),
        endIso: todayAt(12).toISOString()
      }),
      mkEntry({
        source: 'matter',
        title: '交付截止',
        matterId: 'MAT-3',
        startIso: todayAt(15).toISOString(),
        endIso: null
      }),
      mkEntry({
        source: 'agent',
        title: '早间巡检',
        agentId: 'agent-1',
        startIso: todayAt(8).toISOString(),
        endIso: null
      })
    ]
    const { container } = render(<AgendaView onSelect={vi.fn()} />)

    const rows = Array.from(container.querySelectorAll('.ag-row'))
    expect(rows.map((r) => r.getAttribute('data-src'))).toEqual(['agent', 'mail', 'hot', 'matter'])
    const tagged = Array.from(container.querySelectorAll('.ag-tag'))
    expect(tagged.map((el) => el.textContent)).toEqual(['Agent', '事项'])
    // 邮箱日程 (含 hot) 不挂来源标 —— 整屏多数是它, 每行都标就是噪音
    expect(container.querySelectorAll('.ag-row[data-src="mail"] .ag-tag')).toHaveLength(0)
    expect(container.querySelectorAll('.ag-row[data-src="hot"] .ag-tag')).toHaveLength(0)
  })

  test('mail 行的状态形态化 attr / 地点 / Join 经同窗口缓存解析回填', () => {
    const url = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting@thread.v2/0?context=x'
    eventsState.data = [
      mkOcc({ response_status: 'TENTATIVE', location: '3 楼会议室', url }),
      mkOcc({
        id: 8,
        ical_uid: 'uid-ag-8',
        status: 'CANCELLED',
        occurrence_start_iso: todayAt(13).toISOString(),
        occurrence_end_iso: todayAt(14).toISOString()
      })
    ]
    agendaState.data = [
      mkEntry({
        title: '暂定的会',
        eventId: 7,
        icalUid: 'uid-ag-7',
        startIso: todayAt(10).toISOString(),
        endIso: todayAt(11).toISOString()
      }),
      mkEntry({
        title: '被取消的会',
        eventId: 8,
        icalUid: 'uid-ag-8',
        startIso: todayAt(13).toISOString(),
        endIso: todayAt(14).toISOString()
      })
    ]
    const { container } = render(<AgendaView onSelect={vi.fn()} />)

    const rows = container.querySelectorAll('.ag-row')
    expect(rows[0].getAttribute('data-resp')).toBe('TENTATIVE')
    expect(rows[0].querySelector('.ag-loc')?.textContent).toBe('3 楼会议室')
    expect(rows[0].querySelector('.ag-join')).toBeTruthy()
    expect(rows[1].getAttribute('data-status')).toBe('CANCELLED')
    expect(rows[1].querySelector('.ag-join')).toBeNull()
  })
})

describe('AgendaView 点击分流', () => {
  // P4d 起三源都先开详情抽屉: mail 走 onSelect (occurrence 上抛 Layout),
  // matter / agent 落 calendar-agenda-detail store 的投影槽位 —— 点一下不再把人
  // 甩到别的域 (去源头的按钮在抽屉脚上)。
  test('matter / agent → 投影槽位且不导航, mail → onSelect 缓存 occurrence', () => {
    const occ = mkOcc()
    eventsState.data = [occ]
    const onSelect = vi.fn()
    agendaState.data = [
      mkEntry({
        title: '普通会',
        eventId: 7,
        icalUid: 'uid-ag-7',
        startIso: todayAt(10).toISOString(),
        endIso: todayAt(11).toISOString()
      }),
      mkEntry({
        source: 'matter',
        title: '交付截止',
        matterId: 'MAT-3',
        startIso: todayAt(15).toISOString(),
        endIso: null
      }),
      mkEntry({
        source: 'agent',
        title: '早间巡检',
        agentId: 'agent-1',
        startIso: todayAt(16).toISOString(),
        endIso: null
      })
    ]
    const { container } = render(<AgendaView onSelect={onSelect} />)
    const rows = container.querySelectorAll('.ag-row')

    fireEvent.click(rows[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    // 缓存命中 → 上抛的是同一个 occurrence 对象 (drawer 拿到全量字段)
    expect(onSelect.mock.calls[0][0]).toBe(occ)

    fireEvent.click(rows[1])
    expect(useAgendaDetail.getState().entry?.matterId).toBe('MAT-3')
    expect(openSpy).not.toHaveBeenCalled()
    expect(navSpy).not.toHaveBeenCalled()

    // 行根 role=button + Enter 激活 (从 <button> 改 <div> 后的键盘语义保底)
    expect(rows[2].getAttribute('role')).toBe('button')
    fireEvent.keyDown(rows[2], { key: 'Enter' })
    expect(useAgendaDetail.getState().entry?.agentId).toBe('agent-1')
    expect(navSpy).not.toHaveBeenCalled()

    // 回头点邮件条目 → 投影让位 (两个槽位同时有值时投影在前, 不让位就永远看不到邮件详情)
    fireEvent.click(rows[0])
    expect(useAgendaDetail.getState().entry).toBeNull()
  })
})

describe('AgendaView 勾选接线', () => {
  // 二级栏日历树 / 「按日历筛选」下拉写的是同一份 store。两个字段任缺一个, 勾掉的
  // 组或成员在日程视图仍然显示 —— 月/日/周都锁了这条, 日程视图不能是漏网的那个。
  test('store 的组开关 + 成员排除集都传进 agenda hook', () => {
    useCalendarView.setState({
      sources: { mail: true, matter: false, agent: true },
      excluded: { mail: new Set(['Team']), matter: new Set(), agent: new Set(['a-9']) }
    })
    render(<AgendaView onSelect={vi.fn()} />)

    expect(agendaSpy).toHaveBeenCalled()
    expect(agendaSpy.mock.calls[0][1]).toEqual({ mail: true, matter: false, agent: true })
    expect(agendaSpy.mock.calls[0][3]).toEqual({
      mail: new Set(['Team']),
      matter: new Set(),
      agent: new Set(['a-9'])
    })
  })
})
