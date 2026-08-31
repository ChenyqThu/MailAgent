// @vitest-environment happy-dom
//
// 日程视图的日成组呈现 (task 08-27 P4d 三源改造后): 跨天条目按 overlap 展开到
// 覆盖的每一天, 时间列显当日实际覆盖段 (首日=开始时间→, 中间日=全天,
// 末日=→结束时间); 连续空日折叠成一行而不是滚过成片空白组头。
//
// 分组/排序的判据在 lib/agendaList (纯函数单测在 tests/shared/calendar-agenda-list),
// 这里盖的是「视图有没有把它渲染出来」。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

const { agendaState, eventsState } = vi.hoisted(() => ({
  agendaState: {
    data: [] as AgendaEntry[],
    isLoading: false,
    isError: false
  },
  eventsState: { data: [] as CalendarEventOccurrence[] }
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

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/shared/components/calendar/hooks/useCalendarEvents')
    >()
  return {
    ...actual,
    useCalendarEventsInWindow: () => ({
      data: eventsState.data,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn()
    })
  }
})

// 三源主数据源 — 分组/排序走真实现 (lib/agendaList), 被测路径不被掏空。
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

vi.mock('@shared/components/matters/navigation', () => ({
  useMatterNavigation: { getState: () => ({ open: vi.fn() }) }
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

import { AgendaView } from '../../src/shared/components/calendar/views/AgendaView'

/** 今天 00:00 本地 + 偏移 (天) + 时刻. */
function localIso(dayOffset: number, hours: number, minutes = 0): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hours, minutes)
  return d.toISOString()
}

let seq = 0
function mkEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  seq += 1
  return {
    id: `ag-${seq}`,
    source: 'mail',
    hot: false,
    title: `条目 ${seq}`,
    startIso: localIso(0, 9),
    endIso: localIso(0, 10),
    allDay: false,
    multiDay: false,
    ...over
  }
}

afterEach(() => {
  cleanup()
  agendaState.data = []
  agendaState.isLoading = false
  agendaState.isError = false
  eventsState.data = []
})

describe('AgendaView 跨天条目 overlap 展开', () => {
  test('跨 3 天 timed 条目 → 3 行 + 分段时间列, 不再数「第 n/m 天」', () => {
    agendaState.data = [
      mkEntry({
        title: '出差行程',
        startIso: localIso(0, 10),
        endIso: localIso(2, 16),
        multiDay: true
      })
    ]
    render(<AgendaView onSelect={() => {}} />)

    expect(screen.getAllByText('出差行程')).toHaveLength(3)
    expect(screen.getByText('10:00 →')).toBeTruthy()
    expect(screen.getByText('全天')).toBeTruthy()
    expect(screen.getByText('→ 16:00')).toBeTruthy()
    expect(screen.queryByText(/第 \d+\/\d+ 天/)).toBeNull()
  })

  test('单日条目 → 1 行、起止时间照旧; 时间点条目只显时刻不撑假结束时间', () => {
    agendaState.data = [
      mkEntry({ title: '架构周会', startIso: localIso(1, 9), endIso: localIso(1, 10, 30) }),
      mkEntry({
        source: 'matter',
        title: '交付截止',
        matterId: 'MAT-1',
        startIso: localIso(1, 18),
        endIso: null
      })
    ]
    render(<AgendaView onSelect={() => {}} />)

    expect(screen.getAllByText('架构周会')).toHaveLength(1)
    expect(screen.getByText('09:00 – 10:30')).toBeTruthy()
    expect(screen.getByText('18:00')).toBeTruthy()
  })

  test('跨 2 天 all-day 条目 → 每天一行、时间列恒「全天」', () => {
    agendaState.data = [
      mkEntry({
        title: '年假',
        allDay: true,
        startIso: localIso(0, 0),
        // all-day 惯例 end = 最后一天次日 00:00 — 不应展开出第 3 行
        endIso: localIso(2, 0),
        multiDay: true
      })
    ]
    render(<AgendaView onSelect={() => {}} />)

    expect(screen.getAllByText('年假')).toHaveLength(2)
    expect(screen.getAllByText('全天')).toHaveLength(2)
  })
})

describe('AgendaView 空日折叠', () => {
  test('中间与尾部的连续空日各折叠成一行, 单日空档用单日文案', () => {
    agendaState.data = [
      mkEntry({ title: '今天的会', startIso: localIso(0, 9), endIso: localIso(0, 10) }),
      mkEntry({ title: '后天的会', startIso: localIso(2, 9), endIso: localIso(2, 10) })
    ]
    const { container } = render(<AgendaView rangeDays={5} onSelect={() => {}} />)

    const gaps = container.querySelectorAll('.ag-gap')
    // 中间空 1 天 (明天) + 尾部空 2 天
    expect(gaps).toHaveLength(2)
    expect(gaps[0].textContent).toMatch(/^\d+\/\d+ 无日程$/)
    expect(gaps[1].textContent).toMatch(/^\d+\/\d+ – \d+\/\d+ 无日程$/)
    // 折叠的是空白日, 有条目的两天照常成组
    expect(container.querySelectorAll('.ag-group')).toHaveLength(2)
  })
})
