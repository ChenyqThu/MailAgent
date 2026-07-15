// @vitest-environment happy-dom
//
// 阶段1·1.5 (F16/D1) — RSVP 确认卡组件测试: 点 RSVP 三键先出设计系统确认卡
// (不再 window.confirm), 确认后才调 eventRsvp mutation, 取消/Esc 关卡无副作用
// 且不连带关抽屉 (capture 期拦 Esc, Drawer 的 window listener 不该收到).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

const { eventRsvp, eventDelete, settingsGet } = vi.hoisted(() => ({
  eventRsvp: vi.fn(),
  eventDelete: vi.fn(),
  settingsGet: vi.fn()
}))

vi.mock('react-i18next', () => ({
  // 组件用 t(key, defaultString[, opts]) — identity mock 返回 defaultString,
  // 测试按默认中文文案定位 (忽略插值).
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown) => (typeof dflt === 'string' ? dflt : _k)
  })
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))

// 避开 useCalendarEvent/Names 的 useQuery 异步: detail 直接返回稳定引用.
vi.mock('@shared/components/calendar/hooks/useCalendarEvents', () => ({
  CALENDAR_EVENTS_KEY: ['calendar', 'events'],
  useCalendarEvent: () => ({ data: null, isLoading: false }),
  useCalendarNames: () => ({ data: [], isLoading: false })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { get: settingsGet },
    calendar: { eventRsvp, eventDelete, eventCreate: vi.fn(), eventUpdate: vi.fn() }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

import { EventDetailDrawer } from '../../src/shared/components/calendar/EventDetailDrawer'

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-rsvp-1',
    recurrence_id: null,
    sequence: 0,
    summary: '架构评审会',
    occurrence_start_iso: '2026-07-01T09:00:00+00:00',
    occurrence_end_iso: '2026-07-01T10:00:00+00:00',
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    // organizer ≠ userEmail → attendee 分支 (RSVP 三键可见)
    organizer: 'boss@example.test',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: 'NEEDS-ACTION',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null,
    ...over
  }
}

function renderDrawer(onClose: () => void = () => {}): void {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false }
    }
  })
  render(
    <QueryClientProvider client={qc}>
      <EventDetailDrawer occurrence={makeOccurrence()} onClose={onClose} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  eventRsvp.mockReset().mockResolvedValue({})
  eventDelete.mockReset().mockResolvedValue({})
  settingsGet.mockReset().mockResolvedValue({ userEmail: 'me@example.test' })
})

describe('EventDetailDrawer — RSVP 确认卡 (F16)', () => {
  test('点 [接受] → 出确认卡不发请求; 确认 → eventRsvp(accept); 全程不碰 window.confirm', async () => {
    // happy-dom 不带 window.confirm — stub 一个哨兵, 断言零调用 (F16 回归守卫)
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: '接受' }))
    expect(screen.getByText('发送 RSVP 回复')).toBeTruthy()
    expect(eventRsvp).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }))
    await waitFor(() => expect(eventRsvp).toHaveBeenCalledTimes(1))
    expect(eventRsvp.mock.calls[0][0]).toMatchObject({
      icalUid: 'uid-rsvp-1',
      response: 'accept'
    })
    expect(confirmSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  test('点 [拒绝] → 出确认卡; 取消 → 关卡且不调 mutation', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(screen.getByText('发送 RSVP 回复')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    // reduced-motion (tests/setup.ts) → 退场短路立即卸载
    expect(screen.queryByText('发送 RSVP 回复')).toBeNull()
    expect(eventRsvp).not.toHaveBeenCalled()
  })

  test('卡开着按 Esc → 只关卡, 不连带关抽屉 (capture 拦截)', () => {
    const onClose = vi.fn()
    renderDrawer(onClose)
    fireEvent.click(screen.getByRole('button', { name: '暂定' }))
    expect(screen.getByText('发送 RSVP 回复')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByText('发送 RSVP 回复')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(eventRsvp).not.toHaveBeenCalled()
  })
})
