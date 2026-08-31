// @vitest-environment happy-dom
//
// 阶段2·2.5 — Join 入口三处中的两处 (EventBlock hover 小钮 / AgendaView 行尾):
// 有可识别会议链接才渲染; 点击 stopPropagation 不触发开抽屉 onClick, 且在无
// electron 环境 (happy-dom = web 语义) 走 window.open(https)。drawer Join 在
// EventDetailDrawerSourceEmail.test.tsx 一并盖。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

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

// gsap stagger 淡入与断言无关, 剥离动画栈.
vi.mock('@shared/lib/gsap', () => ({
  DUR: { fast: 0.12, base: 0.22, slow: 0.38 },
  gsap: { from: vi.fn() },
  useGSAP: () => {}
}))
vi.mock('@shared/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true
}))

const { hookState, agendaState } = vi.hoisted(() => ({
  hookState: {
    data: undefined as CalendarEventOccurrence[] | undefined
  },
  agendaState: { data: [] as AgendaEntry[] }
}))

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/shared/components/calendar/hooks/useCalendarEvents')
    >()
  return {
    ...actual,
    useCalendarEventsInWindow: () => ({
      data: hookState.data,
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    })
  }
})

// P4d — 日程视图的主数据是三源聚合; Join 仍取自同窗口 events 缓存解析回的
// occurrence (AgendaEntry 不带 url/location)。
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
  useMatterNavigation: { getState: () => ({ open: vi.fn() }) }
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

import { EventBlock } from '../../src/shared/components/calendar/EventBlock'
import { AgendaView } from '../../src/shared/components/calendar/views/AgendaView'

const TEAMS_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_join%40thread.v2/0?context=x'

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-join-1',
    recurrence_id: null,
    sequence: 0,
    summary: 'Join 样本会议',
    occurrence_start_iso: new Date().toISOString(),
    occurrence_end_iso: new Date(Date.now() + 3_600_000).toISOString(),
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: 'boss@example.test',
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

// 固定“现在”为当天本地 10:00（非跨天时段）：makeOccurrence 默认用 new Date()/Date.now()
// 构造 start/end (now → now+1h)，若在本地 23:00-24:00 真实运行会跨本地午夜，触发
// AgendaView 的跨天展开渲染两行 .ag-join。用 setHours(10,...) 只改小时不改日期，
// 对任意时区/任意真实运行时刻都稳定落在同一天内。
beforeEach(() => {
  const fixedNow = new Date()
  fixedNow.setHours(10, 0, 0, 0)
  vi.useFakeTimers()
  vi.setSystemTime(fixedNow)
})

afterEach(() => {
  cleanup()
  hookState.data = undefined
  agendaState.data = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 与 occurrence 对应的 mail 条目 (eventId + 起点是解析判据)。 */
function mkEntry(occ: CalendarEventOccurrence): AgendaEntry {
  return {
    id: `mail:${occ.ical_uid}::${occ.occurrence_start_iso}`,
    source: 'mail',
    hot: false,
    title: occ.summary,
    startIso: occ.occurrence_start_iso,
    endIso: occ.occurrence_end_iso,
    allDay: false,
    multiDay: false,
    eventId: occ.id,
    icalUid: occ.ical_uid,
    recurrenceId: null
  }
}

describe('EventBlock — hover Join 小钮', () => {
  test('有 Teams url → .evt-join 渲染; 点击 window.open(https) 且不触发开抽屉', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const onClick = vi.fn()
    const { container } = render(
      <EventBlock
        event={makeOccurrence({ url: TEAMS_URL })}
        topPx={0}
        heightPx={48}
        onClick={onClick}
      />
    )
    const join = container.querySelector('.evt-join')
    expect(join).toBeTruthy()
    fireEvent.click(join!)
    expect(openSpy).toHaveBeenCalledWith(TEAMS_URL, '_blank', 'noopener')
    expect(onClick).not.toHaveBeenCalled()
    // 块本体点击仍开抽屉
    fireEvent.click(container.querySelector('.evt')!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test('无会议链接 → 不渲染 .evt-join; 根保持 role=button 可键盘激活', () => {
    const onClick = vi.fn()
    const { container } = render(
      <EventBlock event={makeOccurrence()} topPx={0} heightPx={48} onClick={onClick} />
    )
    expect(container.querySelector('.evt-join')).toBeNull()
    const evt = container.querySelector('.evt')!
    expect(evt.getAttribute('role')).toBe('button')
    fireEvent.keyDown(evt, { key: 'Enter' })
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('AgendaView — 行尾 Join', () => {
  test('有链接行渲染 .ag-join, 点击不触发 onSelect; 无链接行无 Join', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const onSelect = vi.fn()
    hookState.data = [
      makeOccurrence({ id: 11, ical_uid: 'uid-join-11', summary: '有链接', url: TEAMS_URL }),
      makeOccurrence({ id: 12, ical_uid: 'uid-join-12', summary: '无链接' })
    ]
    agendaState.data = hookState.data.map(mkEntry)
    const { container } = render(<AgendaView onSelect={onSelect} />)
    const joins = container.querySelectorAll('.ag-join')
    expect(joins).toHaveLength(1)
    fireEvent.click(joins[0])
    expect(openSpy).toHaveBeenCalledWith(TEAMS_URL, '_blank', 'noopener')
    expect(onSelect).not.toHaveBeenCalled()
    // 行本体点击仍上抛选中 (开抽屉)
    const rows = container.querySelectorAll('.ag-row')
    fireEvent.click(rows[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    // 行根 role=button + Enter 激活 (从 <button> 改 <div> 后的键盘语义保底)
    expect(rows[0].getAttribute('role')).toBe('button')
    fireEvent.keyDown(rows[1], { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })
})
