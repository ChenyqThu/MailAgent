// @vitest-environment happy-dom
//
// Lane C (#5) — 视图层接线 (Week / Day)。块内交互在 CalendarEventDrag.test.tsx,
// 这里只测视图这一层自己决定的三件事:
//   ① 组织者门控 —— 与 drawer 的编辑门控同判据 (非组织者只有 RSVP), 不给必失败
//      的拖拽手感; 判断在视图里, 漏掉就是「拖得动但一定 400」;
//   ② 拖拽把**原始** occurrence 上抛给 Layout (提交链要靠它算 recurrenceId);
//   ③ 乐观 override 期内块按新时间定位, 且 Day 视图左栏行显示同一个时间
//      (同屏两处口径分裂过一次就再也说不清哪个是真的)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

const { hookState } = vi.hoisted(() => ({
  hookState: { data: undefined as CalendarEventOccurrence[] | undefined }
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
      data: hookState.data,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn()
    })
  }
})

import { DayView } from '../../src/shared/components/calendar/views/DayView'
import { WeekView } from '../../src/shared/components/calendar/views/WeekView'
import { HOUR_PX } from '../../src/shared/components/calendar/lib/timeGrid'
import { useCalendarTimeOverrides } from '../../src/shared/state/calendar-time-override'

const ME = 'me@example.test'

/** 今天本地 10:00 → 11:00 (视图窗口按本地日算, 固定小时避开跨午夜). */
function todayAt(hour: number, minute = 0): Date {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d
}

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 3,
    ical_uid: 'uid-wiring-3',
    recurrence_id: null,
    sequence: 0,
    summary: '接线样本',
    occurrence_start_iso: todayAt(10).toISOString(),
    occurrence_end_iso: todayAt(11).toISOString(),
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: ME,
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

beforeEach(() => {
  hookState.data = [makeOccurrence()]
})

afterEach(() => {
  cleanup()
  useCalendarTimeOverrides.getState()._reset()
  hookState.data = undefined
  vi.restoreAllMocks()
})

describe('WeekView 拖拽接线', () => {
  test('组织者是自己 → 块可拖, 拖动把原始 occurrence 上抛', () => {
    const onReschedule = vi.fn()
    const { container } = render(
      <WeekView onSelect={vi.fn()} onReschedule={onReschedule} userEmail={ME} />
    )
    const block = container.querySelector('.evt')!
    expect(container.querySelector('.evt-resize')).toBeTruthy()

    fireEvent.pointerDown(block, { button: 0, clientY: 100 })
    fireEvent.pointerMove(window, { clientY: 112 })
    fireEvent.pointerUp(window, { clientY: 112 })

    expect(onReschedule).toHaveBeenCalledTimes(1)
    const [occ, next] = onReschedule.mock.calls[0]
    expect(occ.ical_uid).toBe('uid-wiring-3')
    expect(occ.occurrence_start_iso).toBe(todayAt(10).toISOString())
    expect(new Date(next.startIso).getTime()).toBe(todayAt(10, 15).getTime())
  })

  test('组织者是别人 → 无手柄且拖不动 (只能 RSVP)', () => {
    hookState.data = [makeOccurrence({ organizer: 'boss@example.test' })]
    const onReschedule = vi.fn()
    const { container } = render(
      <WeekView onSelect={vi.fn()} onReschedule={onReschedule} userEmail={ME} />
    )
    expect(container.querySelector('.evt-resize')).toBeNull()
    const block = container.querySelector('.evt')!
    fireEvent.pointerDown(block, { button: 0, clientY: 100 })
    fireEvent.pointerMove(window, { clientY: 130 })
    fireEvent.pointerUp(window, { clientY: 130 })
    expect(onReschedule).not.toHaveBeenCalled()
  })

  test('不传 onReschedule (只读) → 无手柄', () => {
    const { container } = render(<WeekView onSelect={vi.fn()} />)
    expect(container.querySelector('.evt-resize')).toBeNull()
  })

  test('override 生效期 → 块按新时间定位 (不弹回缓存里的旧时间)', () => {
    const key = `3-${todayAt(10).toISOString()}`
    useCalendarTimeOverrides.getState().set(key, {
      startIso: todayAt(11).toISOString(),
      endIso: todayAt(12).toISOString()
    })
    const { container } = render(
      <WeekView onSelect={vi.fn()} onReschedule={vi.fn()} userEmail={ME} />
    )
    const block = container.querySelector('.evt') as HTMLElement
    expect(block.style.top).toBe(`${11 * HOUR_PX}px`)
  })
})

describe('DayView 拖拽接线', () => {
  test('override 生效期 → timeline 块与左栏行显示同一个时间', () => {
    const key = `3-${todayAt(10).toISOString()}`
    useCalendarTimeOverrides.getState().set(key, {
      startIso: todayAt(11).toISOString(),
      endIso: todayAt(12).toISOString()
    })
    const { container } = render(
      <DayView onSelect={vi.fn()} onReschedule={vi.fn()} userEmail={ME} />
    )
    const block = container.querySelector('.evt') as HTMLElement
    expect(block.style.top).toBe(`${11 * HOUR_PX}px`)
    expect(block.querySelector('.e-time')?.textContent).toContain('11:00')
    expect(container.querySelector('.dr-row .dr-time')?.textContent).toContain('11:00 – 12:00')
  })
})
