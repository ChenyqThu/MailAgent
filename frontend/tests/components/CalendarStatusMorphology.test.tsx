// @vitest-environment happy-dom
//
// F3 (阶段2·2.6) — 状态形态化渲染: data-resp / data-status 是 CSS 形态编码
// (斜纹/空心/删除线+中性灰) 的唯一 hook, 断言四消费面 (Month chip / timeline
// evt / Agenda 行 / Day rail 行) 均正确挂载两个 attribute — 尤其 dr-row 的
// data-status (本轮补的缺口, CANCELLED 此前在 rail 行无编码)。图例组件断言
// 4 种状态的 swatch/文案齐全。不测像素。

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

import { EventBlock } from '../../src/shared/components/calendar/EventBlock'
import { EventChip } from '../../src/shared/components/calendar/EventChip'
import { CalendarStatusLegend } from '../../src/shared/components/calendar/CalendarStatusLegend'
import { AgendaView } from '../../src/shared/components/calendar/views/AgendaView'
import { DayView } from '../../src/shared/components/calendar/views/DayView'

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-morph-1',
    recurrence_id: null,
    sequence: 0,
    summary: '状态形态样本',
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

/** 今天 00:00 本地 + 时刻 (小时). */
function todayIso(hours: number): string {
  const d = new Date()
  d.setHours(hours, 0, 0, 0)
  return d.toISOString()
}

afterEach(() => {
  cleanup()
  hookState.data = undefined
  hookState.isLoading = false
  hookState.isError = false
})

describe('状态形态化 data-resp/data-status 挂载 (F3/2.6)', () => {
  test('EventChip (月/all-day chip) — 四状态 attribute 齐挂', () => {
    const { container } = render(
      <>
        <EventChip event={makeOccurrence({ response_status: 'TENTATIVE' })} />
        <EventChip event={makeOccurrence({ id: 2, response_status: 'NEEDS-ACTION' })} />
        <EventChip event={makeOccurrence({ id: 3, response_status: 'DECLINED' })} />
        <EventChip event={makeOccurrence({ id: 4, status: 'CANCELLED' })} />
      </>
    )
    const chips = container.querySelectorAll('.cal-chip')
    expect(chips).toHaveLength(4)
    expect(chips[0].getAttribute('data-resp')).toBe('TENTATIVE')
    expect(chips[1].getAttribute('data-resp')).toBe('NEEDS-ACTION')
    expect(chips[2].getAttribute('data-resp')).toBe('DECLINED')
    expect(chips[3].getAttribute('data-status')).toBe('CANCELLED')
    // 状态 chip 的 dot/title 结构在位 (空心 dot / 删除线 title 的 CSS hook)
    expect(chips[1].querySelector('.c-dot')).toBeTruthy()
    expect(chips[2].querySelector('.c-title')).toBeTruthy()
  })

  test('EventBlock (timeline .evt) — data-resp/data-status + e-time/e-title 结构', () => {
    const { container } = render(
      <>
        <EventBlock
          event={makeOccurrence({ response_status: 'DECLINED' })}
          topPx={0}
          heightPx={48}
        />
        <EventBlock
          event={makeOccurrence({ id: 2, status: 'CANCELLED' })}
          topPx={48}
          heightPx={48}
        />
      </>
    )
    const blocks = container.querySelectorAll('.evt')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].getAttribute('data-resp')).toBe('DECLINED')
    expect(blocks[0].querySelector('.e-title')).toBeTruthy()
    expect(blocks[0].querySelector('.e-time')).toBeTruthy()
    expect(blocks[1].getAttribute('data-status')).toBe('CANCELLED')
  })

  test('AgendaView 行 — data-resp/data-status + ag-bar/ag-title 结构', () => {
    hookState.data = [
      makeOccurrence({
        response_status: 'TENTATIVE',
        occurrence_start_iso: todayIso(9),
        occurrence_end_iso: todayIso(10)
      }),
      makeOccurrence({
        id: 2,
        summary: '被取消的会',
        status: 'CANCELLED',
        occurrence_start_iso: todayIso(11),
        occurrence_end_iso: todayIso(12)
      })
    ]
    const { container } = render(<AgendaView onSelect={() => {}} />)
    const rows = container.querySelectorAll('.ag-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('data-resp')).toBe('TENTATIVE')
    expect(rows[0].querySelector('.ag-bar')).toBeTruthy()
    expect(rows[1].getAttribute('data-status')).toBe('CANCELLED')
    expect(rows[1].querySelector('.ag-title')).toBeTruthy()
  })

  test('DayView rail 行 — dr-row 挂 data-status (CANCELLED 编码缺口回归保护)', () => {
    hookState.data = [
      makeOccurrence({
        summary: '全天取消样本',
        is_all_day: true,
        status: 'CANCELLED',
        occurrence_start_iso: todayIso(0),
        occurrence_end_iso: todayIso(23)
      }),
      makeOccurrence({
        id: 2,
        summary: '暂定样本',
        response_status: 'TENTATIVE',
        occurrence_start_iso: todayIso(9),
        occurrence_end_iso: todayIso(10)
      })
    ]
    const { container } = render(<DayView onSelect={() => {}} />)
    const rows = container.querySelectorAll('.dr-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('data-status')).toBe('CANCELLED')
    expect(rows[0].querySelector('.dr-bar')).toBeTruthy()
    expect(rows[1].getAttribute('data-resp')).toBe('TENTATIVE')
    expect(rows[1].getAttribute('data-status')).toBe('CONFIRMED')
  })
})

describe('CalendarStatusLegend (F3 图例)', () => {
  test('四状态 swatch (data-kind) + label/形态文案齐全', () => {
    const { container } = render(<CalendarStatusLegend />)
    const swatches = container.querySelectorAll('.cal-legend-swatch')
    expect(Array.from(swatches).map((s) => s.getAttribute('data-kind'))).toEqual([
      'tentative',
      'needs-action',
      'declined',
      'cancelled'
    ])
    expect(screen.getByText('暂定')).toBeTruthy()
    expect(screen.getByText('斜纹填充')).toBeTruthy()
    expect(screen.getByText('待回复')).toBeTruthy()
    expect(screen.getByText('空心描边')).toBeTruthy()
    expect(screen.getByText('已拒绝')).toBeTruthy()
    expect(screen.getByText('已取消')).toBeTruthy()
    // 入口按钮可聚焦 (tip :focus-within 键盘可达)
    expect(container.querySelector('.cal-legend button[aria-label="事件状态图例"]')).toBeTruthy()
  })
})
