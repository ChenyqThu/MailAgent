// @vitest-environment happy-dom
//
// Phase 4·#4 + #2 — EventFormModal 交互链组件测试 (testing-library + happy-dom).
// 聚焦数据安全 L3: 编辑事件改与会者的 dirty 行为 (保留/清空/替换) — 验证
// 用户交互 → attendeesDirty → 提交组装 opts 的完整连线 (resolveAttendeesUpdate
// 纯逻辑已在 tests/shared/attendees.test.ts 单测; 这里测组件把交互接到它的连线).
// 外加 create 基本路径 + 全天 toggle 触摸链.
//
// 用非周期 edit 事件 (detail.rrule='') → isRecurring=false → 提交不弹 scope dialog,
// 直接走"改整系列"分支, 聚焦测 attendees 三态.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

// hoisted spies (vi.mock factory 在 hoist 后引用).
const { eventCreate, eventUpdate, stableDetail, stableNames } = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
  // 稳定引用: useCalendarEvent 返回的 data (= EventFormModal 的 detail) 必须跨
  // render 引用不变. 否则 detail effect (deps 含 detail) 每次 render 都触发
  // setRruleState → re-render → detail 又新 → 无限循环 → vitest hang.
  // (生产里 react-query 在 staleTime 内 data 引用稳定, 故仅测试 mock 需注意.)
  stableDetail: { rrule: '', description: '', attendees: [] } as Record<string, unknown>,
  stableNames: ['日历'] as string[]
}))

vi.mock('react-i18next', () => ({
  // EventFormModal 用 t(key, defaultString) / t(key, defaultString, opts);
  // identity mock 返回 defaultString (忽略插值, 测试只按默认中文文案定位).
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown) => (typeof dflt === 'string' ? dflt : _k)
  })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ calendar: { eventCreate, eventUpdate } })
}))

// 避开 useCalendarEvent/Names 的 useQuery 异步: 直接返回非周期 detail.
vi.mock('@shared/components/calendar/hooks/useCalendarEvents', () => ({
  CALENDAR_EVENTS_KEY: ['calendar', 'events'],
  useCalendarEvent: () => ({ data: stableDetail, isLoading: false }),
  useCalendarNames: () => ({ data: stableNames, isLoading: false })
}))

vi.mock('@shared/state/toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

import { EventFormModal } from '../../src/shared/components/calendar/EventFormModal'

function renderModal(occurrence: CalendarEventOccurrence | null): void {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false }
    }
  })
  render(
    <QueryClientProvider client={qc}>
      <EventFormModal open onClose={() => {}} occurrence={occurrence} />
    </QueryClientProvider>
  )
}

function makeOccurrence(
  over: Partial<CalendarEventOccurrence> = {}
): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-edit-1',
    recurrence_id: null,
    sequence: 0,
    summary: '周会',
    occurrence_start_iso: '2026-06-01T09:00:00+00:00',
    occurrence_end_iso: '2026-06-01T10:00:00+00:00',
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: 'me@example.com',
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

afterEach(() => {
  cleanup()
  eventCreate.mockReset().mockResolvedValue({})
  eventUpdate.mockReset().mockResolvedValue({})
})

describe('EventFormModal — create 触摸链', () => {
  test('填标题 + 创建 → eventCreate 收到 summary', async () => {
    renderModal(null)
    fireEvent.change(screen.getByPlaceholderText('事件标题'), {
      target: { value: '测试会议' }
    })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(eventCreate).toHaveBeenCalledTimes(1))
    expect(eventCreate.mock.calls[0][0].summary).toBe('测试会议')
  })

  test('全天 toggle → eventCreate isAllDay=true (Phase 4·#2)', async () => {
    renderModal(null)
    fireEvent.change(screen.getByPlaceholderText('事件标题'), {
      target: { value: '假期' }
    })
    fireEvent.click(screen.getByRole('checkbox')) // 全天 toggle (唯一 checkbox)
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(eventCreate).toHaveBeenCalledTimes(1))
    expect(eventCreate.mock.calls[0][0].isAllDay).toBe(true)
  })
})

describe('EventFormModal — edit 与会者 dirty (Phase 4·#4 数据安全)', () => {
  test('不碰与会者 → eventUpdate 不带 attendees / clearAttendees (保留)', async () => {
    renderModal(makeOccurrence({ attendees: [{ email: 'alice@x.com', name: 'Alice' }] }))
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(eventUpdate).toHaveBeenCalledTimes(1))
    const opts = eventUpdate.mock.calls[0][0]
    expect(opts).not.toHaveProperty('attendees')
    expect(opts).not.toHaveProperty('clearAttendees')
  })

  test('删光与会者 chip → eventUpdate clearAttendees=true (清空)', async () => {
    renderModal(makeOccurrence({ attendees: [{ email: 'alice@x.com', name: 'Alice' }] }))
    fireEvent.click(screen.getByLabelText('移除 {email}')) // × 删唯一 chip
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(eventUpdate).toHaveBeenCalledTimes(1))
    const opts = eventUpdate.mock.calls[0][0]
    expect(opts.clearAttendees).toBe(true)
    expect(opts).not.toHaveProperty('attendees')
  })

  test('加与会者 chip → eventUpdate attendees 替换 (含新 chip)', async () => {
    renderModal(makeOccurrence({ attendees: [] }))
    const input = screen.getByLabelText('与会者')
    fireEvent.change(input, { target: { value: 'bob@x.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(eventUpdate).toHaveBeenCalledTimes(1))
    const opts = eventUpdate.mock.calls[0][0]
    expect(opts.attendees).toEqual([{ email: 'bob@x.com' }])
    expect(opts).not.toHaveProperty('clearAttendees')
  })
})
