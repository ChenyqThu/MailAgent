// @vitest-environment happy-dom
//
// 阶段 2.2 (UX-P0①) — 邮件详情邀请卡片组件测试:
//   1. 非会议邮件 (emailCalendarLink → null) 不渲染;
//   2. REQUEST 全要素 (时间/地点/组织者/与会人折叠 + 冲突 chip 排除自身/已取消);
//   3. CANCEL → 已取消态, 无 RSVP 三键;
//   4. RSVP 恒确认卡 (D1) → 确认后才调 eventRsvp;
//   5. in_calendar=false → 三键禁用 + 「尚未同步到日历」提示, 不出确认卡;
//   6. 无重叠 → 「无冲突」chip。
// mock 模式照 CalendarViewsError.test.tsx / EventDetailDrawerRsvp.test.tsx。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type {
  CalendarEventDetail,
  CalendarEventOccurrence,
  EmailCalendarLink
} from '../../src/shared/api/types'

const { emailCalendarLink, eventsList, eventRsvp, settingsGet, navigateSpy } = vi.hoisted(() => ({
  emailCalendarLink: vi.fn(),
  eventsList: vi.fn(),
  eventRsvp: vi.fn(),
  settingsGet: vi.fn(),
  navigateSpy: vi.fn()
}))

vi.mock('react-i18next', () => ({
  // t(key, defaultString[, opts]) — 返回 defaultString 并做 {var} 简单插值,
  // 冲突 chip「与 {n} 场日程重叠」可按最终文案断言.
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown, opts?: unknown) => {
      let s = typeof dflt === 'string' ? dflt : _k
      if (opts && typeof opts === 'object') {
        for (const [k, v] of Object.entries(opts as Record<string, unknown>)) {
          s = s.replace(`{${k}}`, String(v))
        }
      }
      return s
    }
  })
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateSpy
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { get: settingsGet },
    calendar: { emailCalendarLink, eventsList, eventRsvp }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

import { MeetingInviteCard } from '../../src/shared/components/calendar/MeetingInviteCard'

function makeEvent(over: Partial<CalendarEventDetail> = {}): CalendarEventDetail {
  return {
    id: 1,
    ical_uid: 'uid-invite-1',
    recurrence_id: null,
    sequence: 0,
    summary: 'Q3 规划评审',
    description: '',
    location: '会议室 A · 3F',
    organizer: 'mailto:Boss@example.test',
    attendees: [
      { email: 'a@example.test', name: 'Alice' },
      { email: 'b@example.test', name: 'Bob' },
      { email: 'c@example.test', name: 'Carol' },
      { email: 'd@example.test', name: 'Dave' },
      { email: 'e@example.test', name: 'Eve' }
    ],
    dtstart_iso: '2026-07-20T02:00:00+00:00',
    dtend_iso: '2026-07-20T03:00:00+00:00',
    is_all_day: false,
    rrule: '',
    exdates: [],
    rdates: [],
    status: 'CONFIRMED',
    response_status: 'NEEDS-ACTION',
    url: '',
    calendar_name: '日历',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: 42,
    ics_raw: '',
    ...over
  }
}

function makeLink(over: Partial<EmailCalendarLink> = {}): EmailCalendarLink {
  return {
    internal_id: 42,
    ical_uid: 'uid-invite-1',
    method: 'REQUEST',
    recurrence_id: null,
    sequence: 0,
    is_recurring: false,
    in_calendar: true,
    event: makeEvent(),
    ...over
  }
}

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 9,
    ical_uid: 'uid-other',
    recurrence_id: null,
    sequence: 0,
    summary: '撞车会议',
    occurrence_start_iso: '2026-07-20T02:30:00+00:00',
    occurrence_end_iso: '2026-07-20T03:30:00+00:00',
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: 'x@example.test',
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

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false }
    }
  })
  return render(
    <QueryClientProvider client={qc}>
      <MeetingInviteCard internalId={42} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  emailCalendarLink.mockReset()
  eventsList.mockReset().mockResolvedValue([])
  eventRsvp.mockReset().mockResolvedValue({})
  settingsGet.mockReset().mockResolvedValue({ userEmail: 'me@example.test' })
  navigateSpy.mockReset()
})

describe('MeetingInviteCard (阶段 2.2)', () => {
  test('非会议邮件 (link=null) → 整卡不渲染', async () => {
    emailCalendarLink.mockResolvedValue(null)
    const { container } = renderCard()
    await waitFor(() => expect(emailCalendarLink).toHaveBeenCalledTimes(1))
    expect(container.querySelector('.cal-invite')).toBeNull()
  })

  test('REQUEST 全要素: 时间/地点/组织者/与会人 +N 折叠 + 冲突 chip (排除自身与已取消)', async () => {
    emailCalendarLink.mockResolvedValue(makeLink())
    eventsList.mockResolvedValue([
      makeOccurrence(), // 真重叠 → 计 1
      makeOccurrence({ id: 10, ical_uid: 'uid-invite-1' }), // 自身 uid → 排除
      makeOccurrence({ id: 11, ical_uid: 'uid-cxl', status: 'CANCELLED' }), // 已取消 → 排除
      makeOccurrence({
        // 不重叠 (紧邻其后) → 排除
        id: 12,
        ical_uid: 'uid-after',
        occurrence_start_iso: '2026-07-20T03:00:00+00:00',
        occurrence_end_iso: '2026-07-20T04:00:00+00:00'
      })
    ])
    const { container } = renderCard()
    expect(await screen.findByText('会议邀请')).toBeTruthy()
    // 时间行存在 (确切文案依赖本机时区, 不做字面断言)
    expect(container.querySelector('.cal-invite-time')).toBeTruthy()
    expect(screen.getByText('会议室 A · 3F')).toBeTruthy()
    // organizer 归一 (去 mailto: + lowercase)
    expect(screen.getByText('boss@example.test')).toBeTruthy()
    // 与会人 5 人, 折叠为前 3 + "+2"
    expect(screen.getByText('5 人')).toBeTruthy()
    expect(screen.getByText(/Alice、Bob、Carol \+2/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('与 1 场日程重叠')).toBeTruthy())
    // RSVP 三键 + 在日历中查看
    expect(screen.getByRole('button', { name: '接受' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '暂定' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /在日历中查看/ })).toBeTruthy()
  })

  test('CANCEL → 「会议已取消」态, 无 RSVP 三键, 不查冲突', async () => {
    emailCalendarLink.mockResolvedValue(makeLink({ method: 'CANCEL' }))
    renderCard()
    expect(await screen.findByText('会议已取消')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '接受' })).toBeNull()
    expect(screen.queryByText('无冲突')).toBeNull()
    expect(eventsList).not.toHaveBeenCalled()
  })

  test('RSVP 恒确认卡 (D1): 点 [接受] 先出卡不发请求, 确认后 eventRsvp(accept)', async () => {
    emailCalendarLink.mockResolvedValue(makeLink())
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: '接受' }))
    expect(screen.getByText('发送 RSVP 回复')).toBeTruthy()
    expect(eventRsvp).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }))
    await waitFor(() => expect(eventRsvp).toHaveBeenCalledTimes(1))
    expect(eventRsvp.mock.calls[0][0]).toMatchObject({
      icalUid: 'uid-invite-1',
      response: 'accept',
      recurrenceId: null,
      source: 'caldav'
    })
  })

  test('in_calendar=false → 三键禁用 + 「尚未同步到日历」, 点了不出确认卡', async () => {
    emailCalendarLink.mockResolvedValue(makeLink({ in_calendar: false, event: null }))
    renderCard()
    const accept = (await screen.findByRole('button', { name: '接受' })) as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    expect(screen.getByText('尚未同步到日历')).toBeTruthy()
    fireEvent.click(accept)
    expect(screen.queryByText('发送 RSVP 回复')).toBeNull()
    expect(eventRsvp).not.toHaveBeenCalled()
  })

  test('窗口零重叠 → 「无冲突」轻量 chip', async () => {
    emailCalendarLink.mockResolvedValue(makeLink())
    eventsList.mockResolvedValue([])
    renderCard()
    expect(await screen.findByText('无冲突')).toBeTruthy()
  })

  // task 07-15 问题2 — RSVP 门控 (canRsvpFor 单源): 空 organizer / organizer=
  // 自己 → 整个三键区不渲染 (自建事件经 Exchange 回读 organizer 为空, 点击必
  // 失败)。organizer=他人的行为不变红线由上方「REQUEST 全要素」用例覆盖。
  test('organizer 为空 → RSVP 三键整体不渲染, 信息区/在日历中查看保留', async () => {
    emailCalendarLink.mockResolvedValue(makeLink({ event: makeEvent({ organizer: '' }) }))
    const { container } = renderCard()
    expect(await screen.findByText('会议邀请')).toBeTruthy()
    await waitFor(() => expect(container.querySelector('.btn-rsvp')).toBeNull())
    expect(screen.getByRole('button', { name: /在日历中查看/ })).toBeTruthy()
  })

  test('organizer = 自己 → 无 RSVP 三键', async () => {
    emailCalendarLink.mockResolvedValue(
      makeLink({ event: makeEvent({ organizer: 'mailto:ME@example.test' }) })
    )
    const { container } = renderCard()
    expect(await screen.findByText('会议邀请')).toBeTruthy()
    // settings 异步返回 me@example.test 后三键消失 (加载完成前的瞬时态豁免)
    await waitFor(() => expect(container.querySelector('.btn-rsvp')).toBeNull())
  })
})
