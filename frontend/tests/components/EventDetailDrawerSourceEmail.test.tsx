// @vitest-environment happy-dom
//
// 阶段2·2.3 — drawer「关联邮件」真联动: eventSourceEmail 命中 → 渲染来源邮件
// 摘要 (主题/发件人/日期/共 N 封), 点击 → CommandPalette.activateHit 同款跳转
// (setActiveMailbox + setView + setActive(navTarget) + navigate('/')); null →
// 既有「无关联邮件」空态. 顺带盖 2.5 drawer Join 按钮 (web 语义 window.open).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { CalendarEventOccurrence, EventSourceEmail } from '../../src/shared/api/types'

const { eventRsvp, eventDelete, settingsGet, eventSourceEmail, navigateMock } = vi.hoisted(() => ({
  eventRsvp: vi.fn(),
  eventDelete: vi.fn(),
  settingsGet: vi.fn(),
  eventSourceEmail: vi.fn(),
  navigateMock: vi.fn()
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

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock
}))

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', () => ({
  CALENDAR_EVENTS_KEY: ['calendar', 'events'],
  useCalendarEvent: () => ({ data: null, isLoading: false }),
  useCalendarNames: () => ({ data: [], isLoading: false })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { get: settingsGet },
    calendar: {
      eventRsvp,
      eventDelete,
      eventSourceEmail,
      eventCreate: vi.fn(),
      eventUpdate: vi.fn()
    }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

import { EventDetailDrawer } from '../../src/shared/components/calendar/EventDetailDrawer'
import { useActiveEmail } from '../../src/shared/state/active-email'
import { useEmailFilter } from '../../src/shared/state/email-filter'
import { useMailbox } from '../../src/shared/state/mailbox'

const TEAMS_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_src%40thread.v2/0?context=x'

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-src-1',
    recurrence_id: null,
    sequence: 0,
    summary: '季度规划会',
    occurrence_start_iso: '2026-07-01T09:00:00+00:00',
    occurrence_end_iso: '2026-07-01T10:00:00+00:00',
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

function makeSourceEmail(over: Partial<EventSourceEmail> = {}): EventSourceEmail {
  return {
    ical_uid: 'uid-src-1',
    internal_id: 4711,
    subject: '会议邀请: 季度规划会',
    sender: 'boss@example.test',
    sender_name: 'Boss Chen',
    date_received: '2026-06-28T08:00:00+00:00',
    mailbox: '收件箱',
    method: 'REQUEST',
    linked_email_count: 3,
    ...over
  }
}

function renderDrawer(
  occ: CalendarEventOccurrence = makeOccurrence(),
  onClose: () => void = () => {}
): void {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false }
    }
  })
  render(
    <QueryClientProvider client={qc}>
      <EventDetailDrawer occurrence={occ} onClose={onClose} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  eventRsvp.mockReset().mockResolvedValue({})
  eventDelete.mockReset().mockResolvedValue({})
  settingsGet.mockReset().mockResolvedValue({ userEmail: 'me@example.test' })
  eventSourceEmail.mockReset().mockResolvedValue(null)
  navigateMock.mockReset()
  useActiveEmail.getState().setActive(null)
  vi.restoreAllMocks()
})

describe('EventDetailDrawer — 关联邮件真联动 (2.3)', () => {
  test('eventSourceEmail 命中 → 渲染主题/发件人/共 N 封', async () => {
    eventSourceEmail.mockResolvedValue(makeSourceEmail())
    renderDrawer()
    await waitFor(() => expect(screen.getByText('会议邀请: 季度规划会')).toBeTruthy())
    expect(eventSourceEmail).toHaveBeenCalledWith('uid-src-1')
    // 发件人 + 日期 + linked_email_count>1 的「共 N 封」聚合行
    expect(screen.getByText(/Boss Chen · 2026-06-28 · 共 3 封/)).toBeTruthy()
  })

  test('点击摘要卡 → 关抽屉 + 选中定位 (navTarget) + 同步 mailbox/view + navigate', async () => {
    eventSourceEmail.mockResolvedValue(makeSourceEmail())
    const onClose = vi.fn()
    renderDrawer(makeOccurrence(), onClose)
    await waitFor(() => expect(screen.getByText('会议邀请: 季度规划会')).toBeTruthy())
    fireEvent.click(screen.getByTitle('在收件箱中定位该邮件'))
    expect(useActiveEmail.getState().activeInternalId).toBe(4711)
    expect(useActiveEmail.getState().navTargetId).toBe(4711)
    expect(useMailbox.getState().active).toBe('收件箱')
    expect(useEmailFilter.getState().view).toBe('inbox')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith({ to: '/', search: { view: 'inbox' } })
  })

  test('无映射 (null) → 渲染既有「无关联邮件」空态', async () => {
    eventSourceEmail.mockResolvedValue(null)
    renderDrawer()
    await waitFor(() => expect(screen.getByText('无关联邮件')).toBeTruthy())
  })
})

describe('EventDetailDrawer — Join 按钮 (2.5)', () => {
  test('url 是 Teams 链接 → 渲染「加入会议」, 点击 (web 语义) window.open(https)', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    renderDrawer(makeOccurrence({ url: TEAMS_URL }))
    const btn = await screen.findByRole('button', { name: /加入会议/ })
    fireEvent.click(btn)
    expect(openSpy).toHaveBeenCalledWith(TEAMS_URL, '_blank', 'noopener')
  })

  test('无会议链接 → 无 Join 按钮', () => {
    renderDrawer()
    expect(screen.queryByRole('button', { name: /加入会议/ })).toBeNull()
  })
})
