// @vitest-environment happy-dom
//
// F23/S7 (阶段 1.13) — Week/Day 空态三语义: 查询成功返回空时按同步链路
// 状态区分「无事件」(正常空) /「从未同步」(引导点同步) /「同步失败」
// (提示看状态栏). 附带 1.13 尾巴: DayView rail 计数在查询错误时不再谎报
// 「本日无日程」.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type {
  CalendarEventOccurrence,
  CalendarSyncStateItem
} from '../../src/shared/api/types'

const { eventsState, syncState } = vi.hoisted(() => ({
  eventsState: {
    data: [] as CalendarEventOccurrence[] | undefined,
    isLoading: false,
    isError: false
  },
  syncState: {
    data: undefined as CalendarSyncStateItem[] | undefined,
    isLoading: false
  }
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

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/shared/components/calendar/hooks/useCalendarEvents')
    >()
  return {
    ...actual,
    useCalendarEventsInWindow: () => ({
      data: eventsState.data,
      isLoading: eventsState.isLoading,
      isError: eventsState.isError,
      refetch: vi.fn()
    }),
    useCalendarSyncStatus: () => ({
      data: syncState.data,
      isLoading: syncState.isLoading,
      refetch: vi.fn()
    })
  }
})

import { DayView } from '../../src/shared/components/calendar/views/DayView'
import { WeekView } from '../../src/shared/components/calendar/views/WeekView'

function makeSyncRow(over: Partial<CalendarSyncStateItem> = {}): CalendarSyncStateItem {
  return {
    calendar_name: '日历',
    ctag: 'ctag-1',
    sync_token: null,
    last_full_sync_at_iso: '2026-07-13T00:00:00Z',
    last_incremental_sync_at_iso: '2026-07-13T01:00:00Z',
    last_error: null,
    ...over
  }
}

afterEach(() => {
  cleanup()
  eventsState.data = []
  eventsState.isLoading = false
  eventsState.isError = false
  syncState.data = undefined
  syncState.isLoading = false
})

describe('WeekView 空态三语义 (S7)', () => {
  test('同步健康且无事件 → 正常空态「本周无日程」, 不带同步引导', () => {
    syncState.data = [makeSyncRow()]
    render(<WeekView onSelect={() => {}} />)
    expect(screen.getByText('本周无日程')).toBeTruthy()
    expect(screen.queryByText('日历尚未同步')).toBeNull()
    expect(screen.queryByText('日历同步失败')).toBeNull()
  })

  test('sync_state 无记录 → 「日历尚未同步」引导空态', () => {
    syncState.data = []
    render(<WeekView onSelect={() => {}} />)
    expect(screen.getByText('日历尚未同步')).toBeTruthy()
    expect(screen.queryByText('本周无日程')).toBeNull()
  })

  test('sync 行 last_error 非空 → 「日历同步失败」空态', () => {
    syncState.data = [makeSyncRow({ last_error: 'CalDAV 401' })]
    render(<WeekView onSelect={() => {}} />)
    expect(screen.getByText('日历同步失败')).toBeTruthy()
    expect(screen.queryByText('本周无日程')).toBeNull()
  })

  test('有 sync 行但两个同步时间戳均空 → 视为从未同步', () => {
    syncState.data = [
      makeSyncRow({ last_full_sync_at_iso: null, last_incremental_sync_at_iso: null })
    ]
    render(<WeekView onSelect={() => {}} />)
    expect(screen.getByText('日历尚未同步')).toBeTruthy()
  })
})

describe('DayView rail 计数 (1.13 尾巴)', () => {
  test('查询错误且无数据 → rail 显「加载失败」而非「本日无日程」', () => {
    eventsState.data = undefined
    eventsState.isError = true
    syncState.data = [makeSyncRow()]
    render(<DayView onSelect={() => {}} />)
    expect(screen.getByText('加载失败')).toBeTruthy()
    expect(screen.queryByText('本日无日程')).toBeNull()
  })

  test('正常空 → rail 仍显「本日无日程」', () => {
    syncState.data = [makeSyncRow()]
    render(<DayView onSelect={() => {}} />)
    expect(screen.getAllByText('本日无日程').length).toBeGreaterThan(0)
  })
})
