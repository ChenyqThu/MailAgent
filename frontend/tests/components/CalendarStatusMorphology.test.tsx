// @vitest-environment happy-dom
//
// F3 (阶段2·2.6) — 状态形态化渲染: data-resp / data-status 是 CSS 形态编码
// (斜纹/空心/删除线+中性灰) 的唯一 hook, 断言四消费面 (Month chip / timeline
// evt / Agenda 行 / 日周置顶色带) 均正确挂载两个 attribute。P5 起日/周主数据
// 是 AgendaEntry (无状态字段), 形态化靠同窗口 events 缓存解析回 occurrence —
// 这条解析链断了状态形态就整体消失, DayView 用例专门锁它。图例组件断言
// 4 种状态的 swatch/文案齐全。不测像素。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

const { hookState, agendaState } = vi.hoisted(() => ({
  hookState: {
    data: undefined as CalendarEventOccurrence[] | undefined,
    isLoading: false,
    isError: false
  },
  agendaState: {
    data: [] as AgendaEntry[] | undefined,
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

import { EventBlock } from '../../src/shared/components/calendar/EventBlock'
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
  agendaState.data = []
  agendaState.isLoading = false
  agendaState.isError = false
})

describe('状态形态化 data-resp/data-status 挂载 (F3/2.6)', () => {
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
    // P4d 起日程视图也走 agenda 三源主数据 — 状态同样靠同窗口 events 缓存解析回
    // occurrence, 解析链断了这两个 attr 就整体消失。
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
    agendaState.data = [
      {
        id: 'mail:uid-morph-1',
        source: 'mail',
        hot: false,
        title: '状态形态样本',
        startIso: todayIso(9),
        endIso: todayIso(10),
        allDay: false,
        multiDay: false,
        eventId: 1,
        icalUid: 'uid-morph-1',
        recurrenceId: null
      },
      {
        id: 'mail:uid-morph-2',
        source: 'mail',
        hot: false,
        title: '被取消的会',
        startIso: todayIso(11),
        endIso: todayIso(12),
        allDay: false,
        multiDay: false,
        eventId: 2,
        icalUid: 'uid-morph-1',
        recurrenceId: null
      }
    ]
    const { container } = render(<AgendaView onSelect={() => {}} />)
    const rows = container.querySelectorAll('.ag-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('data-resp')).toBe('TENTATIVE')
    expect(rows[0].querySelector('.ag-bar')).toBeTruthy()
    expect(rows[1].getAttribute('data-status')).toBe('CANCELLED')
    expect(rows[1].querySelector('.ag-title')).toBeTruthy()
  })

  test('DayView (P5 agenda 主数据) — 状态经缓存解析回填: 定时块与置顶色带都挂 attr', () => {
    // AgendaEntry 本身无状态字段 — data-resp/data-status 全靠同窗口 events
    // 缓存按 eventId+起点解析回 occurrence; 解析链断了这两个断言就红。
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
    agendaState.data = [
      {
        id: 'mail:uid-morph-1',
        source: 'mail',
        hot: false,
        title: '全天取消样本',
        startIso: todayIso(0),
        endIso: todayIso(23),
        allDay: true,
        multiDay: false,
        eventId: 1,
        icalUid: 'uid-morph-1',
        recurrenceId: null
      },
      {
        id: 'mail:uid-morph-2',
        source: 'mail',
        hot: false,
        title: '暂定样本',
        startIso: todayIso(9),
        endIso: todayIso(10),
        allDay: false,
        multiDay: false,
        eventId: 2,
        icalUid: 'uid-morph-1',
        recurrenceId: null
      }
    ]
    const { container } = render(<DayView onSelect={() => {}} />)
    const band = container.querySelector('.m-band')
    expect(band).toBeTruthy()
    expect(band?.getAttribute('data-status')).toBe('CANCELLED')
    const block = container.querySelector('.evt')
    expect(block).toBeTruthy()
    expect(block?.getAttribute('data-resp')).toBe('TENTATIVE')
    expect(block?.getAttribute('data-status')).toBe('CONFIRMED')
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
