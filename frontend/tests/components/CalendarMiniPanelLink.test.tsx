// @vitest-environment happy-dom
//
// task 08-27 P3 — 小月历双向联动 + 三源开关集成测试。
// 反向: 主视图翻月 (calendar-view store.setCurrentDate) → 小月历标题跟随。
// 正向: 点日期 → calendar-focus store 写 pending target (uid 空串)。
// 开关: 点源开关行 → store.sources 翻转; 色点随 data-src 渲染。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { AgendaEntry } from '../../src/shared/api/types'

const { agendaState } = vi.hoisted(() => ({
  agendaState: { data: [] as AgendaEntry[] }
}))

vi.mock('react-i18next', () => ({
  // t(key, default, vars) — 手写 {var} 插值, 断言用中文默认文案。
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown, vars?: Record<string, unknown>) =>
      typeof dflt === 'string'
        ? dflt.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? ''))
        : _k
  })
}))

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

import { CalendarMiniPanel } from '../../src/shared/components/calendar/CalendarMiniPanel'
import { useCalendarFocus } from '../../src/shared/state/calendar-focus'
import { useCalendarView, DEFAULT_SOURCE_TOGGLES } from '../../src/shared/state/calendar-view'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  useCalendarView.setState({ currentDate: new Date(), sources: { ...DEFAULT_SOURCE_TOGGLES } })
  useCalendarFocus.setState({ pending: null })
})

describe('CalendarMiniPanel 双向联动 (task 08-27 P3)', () => {
  test('反向: 主视图翻月 → 小月历标题跟随', () => {
    render(<CalendarMiniPanel />)
    act(() => {
      useCalendarView.getState().setCurrentDate(new Date(2026, 10, 5))
    })
    expect(screen.getByText('2026 年 11 月')).toBeTruthy()
  })

  test('正向: 点日期 → calendar-focus 写 pending (uid 空串 = 只跳日期)', () => {
    render(<CalendarMiniPanel />)
    act(() => {
      useCalendarView.getState().setCurrentDate(new Date(2026, 10, 5))
    })
    fireEvent.click(screen.getByRole('button', { name: '2026-11-05' }))
    const pending = useCalendarFocus.getState().pending
    expect(pending).not.toBeNull()
    expect(pending?.icalUid).toBe('')
    const d = new Date(pending?.dateIso ?? '')
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 10, 5])
  })

  test('三源开关: 点「事项日历」行翻转 store; 色点带 data-src', () => {
    agendaState.data = [
      {
        id: 'matter:m1',
        source: 'matter',
        hot: false,
        title: '事项截止',
        startIso: new Date(2026, 10, 12, 9).toISOString(),
        endIso: null,
        allDay: false,
        multiDay: false,
        matterId: 'm1'
      }
    ]
    const { container } = render(<CalendarMiniPanel />)
    act(() => {
      useCalendarView.getState().setCurrentDate(new Date(2026, 10, 5))
    })
    expect(container.querySelector('.mm-dot[data-src="matter"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: /事项日历/ }))
    expect(useCalendarView.getState().sources).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    agendaState.data = []
  })
})
