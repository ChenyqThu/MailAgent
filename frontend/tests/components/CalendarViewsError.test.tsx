// @vitest-environment happy-dom
//
// F21 (阶段 0.4) — 日历查询错误态回归: query reject 不得再伪装成
// EmptyState「无日程」假空态. 覆盖 WeekView / MonthView (mock
// useCalendarEventsInWindow 返回 isError) + CalendarPage recurring
// (真 useQuery + reject 的 mailApi). 断言: 错误 UI 渲染 + [重试] 触发
// refetch + 有旧数据时后台错误不轰掉已在屏内容 (keepPreviousData 语义).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

const { refetchSpy, hookState, agendaRefetchSpy, agendaState, recurringDiscover } = vi.hoisted(
  () => ({
    refetchSpy: vi.fn(),
    hookState: {
      data: undefined as CalendarEventOccurrence[] | undefined,
      isLoading: false,
      isError: true
    },
    // P3 — MonthView 改走三源聚合 useCalendarAgenda, 错误态数据源独立 mock。
    agendaRefetchSpy: vi.fn(),
    agendaState: {
      data: undefined as AgendaEntry[] | undefined,
      isLoading: false,
      isError: true
    },
    recurringDiscover: vi.fn()
  })
)

vi.mock('react-i18next', () => ({
  // 组件用 t(key, defaultString) — identity mock 返回 defaultString,
  // 测试按默认中文文案定位.
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown) => (typeof dflt === 'string' ? dflt : _k)
  })
}))

// 只覆写 useCalendarEventsInWindow, 其余 (addDays/startOfWeek/layoutDay…)
// 走真实现 — 视图渲染路径不被 mock 掏空.
vi.mock('@shared/components/calendar/hooks/useCalendarEvents', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/shared/components/calendar/hooks/useCalendarEvents')
    >()
  return {
    ...actual,
    useCalendarEventsInWindow: () => ({
      data: hookState.data,
      isLoading: hookState.isLoading,
      isError: hookState.isError,
      refetch: refetchSpy
    })
  }
})

// P3 — MonthView 的三源聚合 hook: 独立 mock (与 useCalendarEventsInWindow 分开,
// windowEvents 解析路径仍走上面的 mock)。
vi.mock('@shared/components/calendar/hooks/useCalendarAgenda', () => ({
  useCalendarAgenda: () => ({
    data: agendaState.data,
    isLoading: agendaState.isLoading,
    isFetching: false,
    isError: agendaState.isError,
    refetch: agendaRefetchSpy
  }),
  localOlsonTz: () => 'UTC'
}))

// MonthView 点击路由用 useNavigate — 测试无 RouterProvider, 换成 no-op。
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    calendar: { recurringDiscover, eventReplay: vi.fn() }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

import { CalendarPage } from '../../src/shared/components/calendar/CalendarPage'
import { MonthView } from '../../src/shared/components/calendar/views/MonthView'
import { WeekView } from '../../src/shared/components/calendar/views/WeekView'

function makeAgendaEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  return {
    id: 'mail:uid-err-1',
    source: 'mail',
    hot: false,
    title: '架构周会',
    startIso: new Date().toISOString(),
    endIso: new Date(Date.now() + 3_600_000).toISOString(),
    allDay: false,
    multiDay: false,
    eventId: 1,
    icalUid: 'uid-err-1',
    recurrenceId: null,
    ...over
  }
}

afterEach(() => {
  cleanup()
  refetchSpy.mockReset()
  agendaRefetchSpy.mockReset()
  recurringDiscover.mockReset()
  hookState.data = undefined
  hookState.isLoading = false
  hookState.isError = true
  agendaState.data = undefined
  agendaState.isLoading = false
  agendaState.isError = true
})

describe('WeekView 错误态 (F21)', () => {
  test('query 失败且无数据 → 错误屏替代假空态, [重试] 调 refetch', () => {
    render(<WeekView onSelect={() => {}} />)
    expect(screen.getByText('日历数据加载失败')).toBeTruthy()
    expect(screen.queryByText('本周无日程')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(refetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('MonthView 错误态 (F21)', () => {
  test('agenda query 失败且无数据 → 错误屏替代假空态, [重试] 调 refetch', () => {
    render(<MonthView onSelect={() => {}} />)
    expect(screen.getByText('日历数据加载失败')).toBeTruthy()
    expect(screen.queryByText('本月无日程')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(agendaRefetchSpy).toHaveBeenCalledTimes(1)
  })

  test('后台 refetch 失败但有旧数据 → 旧数据留屏, 不换错误屏', () => {
    agendaState.data = [makeAgendaEntry()]
    agendaState.isError = true
    render(<MonthView onSelect={() => {}} />)
    expect(screen.getByText('架构周会')).toBeTruthy()
    expect(screen.queryByText('日历数据加载失败')).toBeNull()
  })
})

describe('CalendarPage recurring 错误态 (F21)', () => {
  function renderPage(): void {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } }
    })
    render(
      <QueryClientProvider client={qc}>
        <CalendarPage />
      </QueryClientProvider>
    )
  }

  test('recurringDiscover reject → 错误屏替代「未发现周期会议」, [重试] 重新 fetch', async () => {
    recurringDiscover.mockRejectedValue(new Error('ipc down'))
    renderPage()
    await waitFor(() => expect(screen.getByText('日历数据加载失败')).toBeTruthy())
    expect(screen.queryByText('未发现周期会议')).toBeNull()
    expect(recurringDiscover).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    await waitFor(() => expect(recurringDiscover).toHaveBeenCalledTimes(2))
  })
})
