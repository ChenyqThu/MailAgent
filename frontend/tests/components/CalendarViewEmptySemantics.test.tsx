// @vitest-environment happy-dom
//
// F23/S7 (阶段 1.13) — Week/Day 空态三语义: 查询成功返回空时按同步链路
// 状态区分「无事件」(正常空) /「从未同步」(引导点同步) /「同步失败」
// (提示看状态栏). P5 起日/周主数据 = useCalendarAgenda (三源聚合), 空/错
// 判据换到 agenda 侧; DayView rail 已随重做移除, 错误态改断言主区错误屏.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type {
  AgendaEntry,
  CalendarEventOccurrence,
  CalendarSyncStateItem
} from '../../src/shared/api/types'

const { eventsState, agendaState, syncState } = vi.hoisted(() => ({
  eventsState: {
    data: [] as CalendarEventOccurrence[] | undefined,
    isLoading: false,
    isError: false
  },
  agendaState: {
    data: [] as AgendaEntry[] | undefined,
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

// P5 — 日/周主数据源 (三源聚合)。
vi.mock('@shared/components/calendar/hooks/useCalendarAgenda', () => ({
  useCalendarAgenda: () => ({
    data: agendaState.data,
    isLoading: agendaState.isLoading,
    isFetching: false,
    isError: agendaState.isError,
    refetch: vi.fn()
  }),
  localOlsonTz: () => 'UTC'
}))

// useAgendaEntryClick 链上的 useNavigate — 测试无 RouterProvider, 换 no-op。
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn() }
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
  agendaState.data = []
  agendaState.isLoading = false
  agendaState.isError = false
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

describe('DayView 空/错态 (P5 重做后)', () => {
  test('agenda 查询错误且无数据 → 错误屏, 不谎报「本日无日程」', () => {
    agendaState.data = undefined
    agendaState.isError = true
    syncState.data = [makeSyncRow()]
    render(<DayView onSelect={() => {}} />)
    expect(screen.getByText('日历数据加载失败')).toBeTruthy()
    expect(screen.queryByText('本日无日程')).toBeNull()
  })

  test('正常空 → 「本日无日程」空态', () => {
    syncState.data = [makeSyncRow()]
    render(<DayView onSelect={() => {}} />)
    expect(screen.getByText('本日无日程')).toBeTruthy()
  })
})
