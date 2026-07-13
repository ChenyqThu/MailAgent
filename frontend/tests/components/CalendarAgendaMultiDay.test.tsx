// @vitest-environment happy-dom
//
// F22/S6 (阶段 1.12) — Agenda 跨天事件按 overlap 展开: 与窗口重叠的每一天
// 各出一行, 标「第 n/m 天」; 时间列显示当日实际覆盖段 (首日=开始时间→,
// 中间日=全天, 末日=→结束时间). 老行为 (只按 start 单键分组) 下第 2/3 天
// 整段消失 — 断言展开后 3 行齐在.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

const { hookState } = vi.hoisted(() => ({
  hookState: {
    data: undefined as CalendarEventOccurrence[] | undefined,
    isLoading: false,
    isError: false
  }
}))

vi.mock('react-i18next', () => ({
  // t(key, defaultString, vars) — 按 ICU 单花括号 {n} 语法做最小插值,
  // 断言按默认中文文案 + 插值结果定位.
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

// gsap stagger 淡入与断言无关, 剥离动画栈 (useGSAP no-op).
vi.mock('@shared/lib/gsap', () => ({
  DUR: { fast: 0.12, base: 0.22, slow: 0.38 },
  gsap: { from: vi.fn() },
  useGSAP: () => {}
}))
vi.mock('@shared/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true
}))

// 只覆写 useCalendarEventsInWindow, 展开逻辑 (expandOccurrencesByLocalDayOverlap)
// 走真实现 — 被测路径不被 mock 掏空.
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
      refetch: vi.fn()
    })
  }
})

import { AgendaView } from '../../src/shared/components/calendar/views/AgendaView'

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-md-1',
    recurrence_id: null,
    sequence: 0,
    summary: '出差行程',
    occurrence_start_iso: new Date().toISOString(),
    occurrence_end_iso: new Date(Date.now() + 3_600_000).toISOString(),
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

/** 今天 00:00 本地 + 偏移 (天) + 时刻. */
function localIso(dayOffset: number, hours: number, minutes = 0): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hours, minutes)
  return d.toISOString()
}

afterEach(() => {
  cleanup()
  hookState.data = undefined
  hookState.isLoading = false
  hookState.isError = false
})

describe('AgendaView 跨天事件 overlap 展开 (F22/S6)', () => {
  test('跨 3 天 timed 事件 → 3 行 + 第 n/3 天标注 + 分段时间列', () => {
    hookState.data = [
      makeOccurrence({
        occurrence_start_iso: localIso(0, 10), // 今天 10:00
        occurrence_end_iso: localIso(2, 16) // 后天 16:00
      })
    ]
    render(<AgendaView onSelect={() => {}} />)

    // 每天各一行 (title 出现 3 次)
    expect(screen.getAllByText('出差行程')).toHaveLength(3)
    // 「第 n/m 天」标注
    expect(screen.getByText('第 1/3 天')).toBeTruthy()
    expect(screen.getByText('第 2/3 天')).toBeTruthy()
    expect(screen.getByText('第 3/3 天')).toBeTruthy()
    // 时间列: 首日显开始, 中间日全天, 末日显结束
    expect(screen.getByText('10:00 →')).toBeTruthy()
    expect(screen.getByText('全天')).toBeTruthy()
    expect(screen.getByText('→ 16:00')).toBeTruthy()
  })

  test('单日事件 → 1 行、无「第 n/m 天」标注、起止时间照旧', () => {
    hookState.data = [
      makeOccurrence({
        summary: '架构周会',
        occurrence_start_iso: localIso(1, 9),
        occurrence_end_iso: localIso(1, 10, 30)
      })
    ]
    render(<AgendaView onSelect={() => {}} />)

    expect(screen.getAllByText('架构周会')).toHaveLength(1)
    expect(screen.queryByText(/第 \d+\/\d+ 天/)).toBeNull()
    expect(screen.getByText('09:00 – 10:30')).toBeTruthy()
  })

  test('跨 2 天 all-day 事件 → 每天一行、时间列恒「全天」', () => {
    hookState.data = [
      makeOccurrence({
        summary: '年假',
        is_all_day: true,
        occurrence_start_iso: localIso(0, 0),
        // all-day 惯例 end = 最后一天次日 00:00 — 不应展开出第 3 行
        occurrence_end_iso: localIso(2, 0)
      })
    ]
    render(<AgendaView onSelect={() => {}} />)

    expect(screen.getAllByText('年假')).toHaveLength(2)
    expect(screen.getByText('第 1/2 天')).toBeTruthy()
    expect(screen.getByText('第 2/2 天')).toBeTruthy()
    expect(screen.getAllByText('全天')).toHaveLength(2)
  })
})
