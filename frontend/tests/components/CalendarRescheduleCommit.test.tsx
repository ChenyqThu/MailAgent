// @vitest-environment happy-dom
//
// Lane C (#5) — 拖拽落手之后的提交链 (useEventReschedule)。
//
// 这条链的每一环都有「静默失效」的可能, 逐环钉住:
//   ① 落手即写乐观 override —— 没有它, 松手块就弹回原位 (calendar-undo 是
//      commit-delay 模型, 5s 内服务端根本还没收到请求);
//   ② 撤销 = 请求**从未发出** (不是发出去再补一个反向请求);
//   ③ 5s 到点才发 PATCH, 且周期实例恒带 recurrenceId (改这一次, 不动整系列);
//   ④ PATCH 失败清 override —— 块必须弹回, 不能让屏幕停在一个没落库的时间上;
//   ⑤ 成功时**有意不清** override, 且 TTL 必须盖住本地回填窗口 —— PATCH 只写
//      CalDAV, 本地 calendar_event 要等 CalendarSyncWorker 下一轮 (60s) 才
//      reconcile; TTL 短于它 = 块中途弹回旧时间再跳回来。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act } from '@testing-library/react'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

const { eventUpdate } = vi.hoisted(() => ({ eventUpdate: vi.fn() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown) => (typeof dflt === 'string' ? dflt : _k)
  })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ calendar: { eventUpdate } })
}))

vi.mock('@shared/state/toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

import { useEventReschedule } from '../../src/shared/components/calendar/hooks/useEventReschedule'
import { useUndoToastStore } from '../../src/shared/state/calendar-undo'
import {
  OVERRIDE_TTL_MS,
  useCalendarTimeOverrides
} from '../../src/shared/state/calendar-time-override'

const START_ISO = '2026-08-24T02:00:00.000Z'
const END_ISO = '2026-08-24T03:00:00.000Z'
const NEXT_START_ISO = '2026-08-24T02:30:00.000Z'
const NEXT_END_ISO = '2026-08-24T03:30:00.000Z'

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 9,
    ical_uid: 'uid-resched-9',
    recurrence_id: null,
    sequence: 0,
    summary: '周会',
    occurrence_start_iso: START_ISO,
    occurrence_end_iso: END_ISO,
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
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

const KEY = `9-${START_ISO}`

function renderReschedule(): ReturnType<
  typeof renderHook<ReturnType<typeof useEventReschedule>, void>
> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } }
  })
  return renderHook(() => useEventReschedule(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  })
}

function overrides(): Record<string, { startIso: string; endIso: string }> {
  return useCalendarTimeOverrides.getState().overrides
}

beforeEach(() => {
  vi.useFakeTimers()
  eventUpdate.mockReset().mockResolvedValue({})
})

afterEach(() => {
  useUndoToastStore.getState()._reset()
  useCalendarTimeOverrides.getState()._reset()
  vi.useRealTimers()
})

describe('useEventReschedule — 提交链', () => {
  test('落手即写 override + 推 5s 撤销 toast, 此刻还没发任何请求', () => {
    const { result } = renderReschedule()
    act(() => {
      result.current(makeOccurrence(), {
        startIso: NEXT_START_ISO,
        endIso: NEXT_END_ISO,
        mode: 'move'
      })
    })
    expect(overrides()[KEY]).toEqual({ startIso: NEXT_START_ISO, endIso: NEXT_END_ISO })
    expect(useUndoToastStore.getState().items).toHaveLength(1)
    expect(useUndoToastStore.getState().items[0].kind).toBe('reschedule')
    expect(eventUpdate).not.toHaveBeenCalled()
  })

  test('5s 内撤销 → 请求从未发出 + override 清掉 (块弹回)', () => {
    const { result } = renderReschedule()
    act(() => {
      result.current(makeOccurrence(), {
        startIso: NEXT_START_ISO,
        endIso: NEXT_END_ISO,
        mode: 'move'
      })
    })
    act(() => {
      const id = useUndoToastStore.getState().items[0].id
      useUndoToastStore.getState().undo(id)
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(eventUpdate).not.toHaveBeenCalled()
    expect(overrides()[KEY]).toBeUndefined()
  })

  test('不撤销 → 5s 到点发 PATCH (绝对时间, 非周期不带 recurrenceId)', async () => {
    const { result } = renderReschedule()
    act(() => {
      result.current(makeOccurrence(), {
        startIso: NEXT_START_ISO,
        endIso: NEXT_END_ISO,
        mode: 'move'
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(eventUpdate).toHaveBeenCalledTimes(1)
    expect(eventUpdate.mock.calls[0][0]).toEqual({
      icalUid: 'uid-resched-9',
      startIso: NEXT_START_ISO,
      endIso: NEXT_END_ISO
    })
  })

  test('周期实例 → 恒带 recurrenceId = 该次**原始** dtstart (改这一次)', async () => {
    const { result } = renderReschedule()
    act(() => {
      result.current(makeOccurrence({ is_recurrence_instance: true }), {
        startIso: NEXT_START_ISO,
        endIso: NEXT_END_ISO,
        mode: 'move'
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(eventUpdate.mock.calls[0][0].recurrenceId).toBe(START_ISO)
  })

  test('PATCH 失败 → 清 override (块弹回真实时间)', async () => {
    eventUpdate.mockRejectedValue(new Error('E_NOT_FOUND'))
    const { result } = renderReschedule()
    act(() => {
      result.current(makeOccurrence(), {
        startIso: NEXT_START_ISO,
        endIso: NEXT_END_ISO,
        mode: 'move'
      })
    })
    await act(async () => {
      vi.advanceTimersByTime(5000)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(overrides()[KEY]).toBeUndefined()
  })

  test('PATCH 成功 → override 撑过本地回填窗口 (worker 60s) 才过期', async () => {
    const { result } = renderReschedule()
    act(() => {
      result.current(makeOccurrence(), {
        startIso: NEXT_START_ISO,
        endIso: NEXT_END_ISO,
        mode: 'move'
      })
    })
    await act(async () => {
      vi.advanceTimersByTime(5000)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(overrides()[KEY]).toBeDefined()
    // 最坏情况: PATCH 落地(t=5s) 之后再等满一轮 CalendarSyncWorker poll (60s)
    // 本地库才是新值。TTL 短于这条线 = 中途露出旧时间。
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(overrides()[KEY]).toBeDefined()
    act(() => {
      vi.advanceTimersByTime(OVERRIDE_TTL_MS)
    })
    expect(overrides()[KEY]).toBeUndefined()
  })
})
