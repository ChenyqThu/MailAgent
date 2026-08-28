// @vitest-environment happy-dom
//
// task 08-27 dogfood 轮 2 — 日历域二级栏 = 分组日历树。
// 覆盖: 三组恒在 (窗口内没条目也只出空态短句不藏组) / 成员从 agenda 聚合
// (agent 去重 · 行动项归父事项) / 邮箱成员来自 calendar 名 / 勾选写 store /
// 组头三态 (含 mixed) / 新冒出来的成员天然选中 / 树读的是**未过滤**数据
// (勾掉的那条必须还留在树上, 否则再也点不回来)。
//
// 「在日历中查看」正向腿 (MeetingInviteCard → calendar-focus → CalendarLayout)
// 不经过本组件, 覆盖在 tests/shared/calendar-key-nav.test.ts。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { AgendaEntry } from '../../src/shared/api/types'

const { agendaSpy, agendaState, namesState } = vi.hoisted(() => ({
  agendaSpy: vi.fn(),
  agendaState: { data: [] as AgendaEntry[] },
  namesState: { data: [] as string[] }
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
  useCalendarAgenda: (...args: unknown[]) => {
    agendaSpy(...args)
    return {
      data: agendaState.data,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn()
    }
  },
  localOlsonTz: () => 'UTC'
}))

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/shared/components/calendar/hooks/useCalendarEvents')
    >()
  return { ...actual, useCalendarNames: () => ({ data: namesState.data, isLoading: false }) }
})

import { CalendarSourcePanel } from '../../src/shared/components/calendar/CalendarSourcePanel'
import {
  useCalendarView,
  DEFAULT_SOURCE_TOGGLES,
  emptyExclusions
} from '../../src/shared/state/calendar-view'

let seq = 0
function mk(over: Partial<AgendaEntry>): AgendaEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    source: 'mail',
    hot: false,
    title: `条目 ${seq}`,
    startIso: new Date(2026, 7, 12, 9).toISOString(),
    endIso: null,
    allDay: false,
    multiDay: false,
    ...over
  }
}

/** 组头 / 成员行的勾选态: aria-checked ('true' | 'false' | 'mixed')。 */
function checkedOf(name: string | RegExp): string | null {
  return screen.getByRole('checkbox', { name }).getAttribute('aria-checked')
}

afterEach(() => {
  cleanup()
  agendaSpy.mockReset()
  agendaState.data = []
  namesState.data = []
  window.localStorage.clear()
  useCalendarView.setState({
    currentDate: new Date(),
    sources: { ...DEFAULT_SOURCE_TOGGLES },
    excluded: emptyExclusions()
  })
})

describe('CalendarSourcePanel — 分组与成员', () => {
  test('三组恒在; 窗口内没条目的组给空态短句而不是藏起来', () => {
    const { container } = render(<CalendarSourcePanel />)
    expect(checkedOf(/邮箱日历/)).toBe('true')
    expect(checkedOf(/事项日历/)).toBe('true')
    expect(checkedOf(/Agent 日历/)).toBe('true')
    expect(container.querySelectorAll('.cal-srcgroup')).toHaveLength(3)
    expect(screen.getByText('本月没有事项排期')).toBeTruthy()
    expect(screen.getByText('本月没有智能体排程')).toBeTruthy()
    expect(screen.getByText('还没有同步到任何邮箱日历')).toBeTruthy()
  })

  test('成员: 邮箱来自 calendar 名, 事项/Agent 从 agenda 聚合 (去重 + 行动项归父事项)', () => {
    namesState.data = ['Work', 'Team']
    agendaState.data = [
      mk({ source: 'agent', agentId: 'daily', title: '日报生成' }),
      mk({ source: 'agent', agentId: 'daily', title: '日报生成' }),
      mk({ source: 'matter', matterId: 'MAT-1', itemId: '77', title: '催报价' }),
      mk({ source: 'matter', matterId: 'MAT-1', title: 'AW 续约' })
    ]
    const { container } = render(<CalendarSourcePanel />)

    const members = Array.from(container.querySelectorAll('.cal-src-row.is-member')).map(
      (el) => el.textContent
    )
    expect(members).toEqual(['Work', 'Team', 'AW 续约', '日报生成'])
    // 行动项被父事项吸收, 不单独占一条
    expect(screen.queryByRole('checkbox', { name: '催报价' })).toBeNull()
  })

  test('树读的是未过滤数据 —— 不传 sources / excluded 给 agenda hook', () => {
    render(<CalendarSourcePanel />)
    expect(agendaSpy).toHaveBeenCalled()
    const [opts, sources, enabled, excluded] = agendaSpy.mock.calls[0]
    expect(opts).toMatchObject({ fromIso: expect.any(String), toIso: expect.any(String) })
    expect(sources).toBeUndefined()
    expect(enabled).toBeUndefined()
    expect(excluded).toBeUndefined()
  })

  test('聚合窗口跟 currentDate 走 (换月重新聚合)', () => {
    render(<CalendarSourcePanel />)
    const firstFrom = agendaSpy.mock.calls[0][0] as { fromIso: string }
    act(() => {
      useCalendarView.getState().setCurrentDate(new Date(2026, 0, 15))
    })
    const lastFrom = agendaSpy.mock.calls.at(-1)?.[0] as { fromIso: string }
    expect(lastFrom.fromIso).not.toBe(firstFrom.fromIso)
    // 2026-01 的 6 周网格从 2025-12-29 (周一) 起
    expect(new Date(lastFrom.fromIso).getMonth()).toBe(11)
  })
})

describe('CalendarSourcePanel — 勾选写 store', () => {
  test('点成员 → 进排除集; 该行变未勾, 但仍留在树上（能再点回来）', () => {
    agendaState.data = [
      mk({ source: 'agent', agentId: 'daily', title: '日报生成' }),
      mk({ source: 'agent', agentId: 'weekly', title: '周报生成' })
    ]
    render(<CalendarSourcePanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: '日报生成' }))

    expect([...useCalendarView.getState().excluded.agent]).toEqual(['daily'])
    expect(checkedOf('日报生成')).toBe('false')
    expect(checkedOf('周报生成')).toBe('true')
    // 组头变半选
    expect(checkedOf(/Agent 日历/)).toBe('mixed')

    fireEvent.click(screen.getByRole('checkbox', { name: '日报生成' }))
    expect(useCalendarView.getState().excluded.agent.size).toBe(0)
    expect(checkedOf(/Agent 日历/)).toBe('true')
  })

  test('点组头: 全选 → 关组; 半选 → 拉回全选', () => {
    namesState.data = ['Work', 'Team']
    render(<CalendarSourcePanel />)

    fireEvent.click(screen.getByRole('checkbox', { name: /邮箱日历/ }))
    expect(useCalendarView.getState().sources.mail).toBe(false)
    expect(checkedOf(/邮箱日历/)).toBe('false')
    expect(checkedOf('Work')).toBe('false')

    // 组关着时点某一条成员 = 只看这一条
    fireEvent.click(screen.getByRole('checkbox', { name: 'Work' }))
    expect(useCalendarView.getState().sources.mail).toBe(true)
    expect([...useCalendarView.getState().excluded.mail]).toEqual(['Team'])
    expect(checkedOf(/邮箱日历/)).toBe('mixed')

    // 半选态点组头 → 全选
    fireEvent.click(screen.getByRole('checkbox', { name: /邮箱日历/ }))
    expect(useCalendarView.getState().excluded.mail.size).toBe(0)
    expect(checkedOf('Team')).toBe('true')
  })

  test('窗口里新冒出来的成员天然选中 (排除集里没有它)', () => {
    agendaState.data = [
      mk({ source: 'agent', agentId: 'daily', title: '日报生成' }),
      mk({ source: 'agent', agentId: 'weekly', title: '周报生成' })
    ]
    const { rerender } = render(<CalendarSourcePanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: '日报生成' }))
    expect(checkedOf('日报生成')).toBe('false')

    agendaState.data = [
      ...agendaState.data,
      mk({ source: 'agent', agentId: 'newbie', title: '新加的巡检' })
    ]
    rerender(<CalendarSourcePanel />)
    expect(checkedOf('新加的巡检')).toBe('true')
    expect(checkedOf('日报生成')).toBe('false')
  })
})
