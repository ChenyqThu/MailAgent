// task 08-27 dogfood 轮 2 — 日历源分组树纯函数单测 (node 环境, 零 hooks import 链):
// 成员身份判据 / 窗口条目 → 成员清单聚合 (去重 · 行动项归父事项 · 排序) / 组头三态。

import { describe, expect, test } from 'vitest'

import {
  agendaMemberId,
  aggregateSourceMembers,
  groupCheckState,
  selectionFromExclusions
} from '../../src/shared/components/calendar/lib/sourceTree'
import { useCalendarView } from '../../src/shared/state/calendar-view'
import type { AgendaEntry } from '../../src/shared/api/types'

let seq = 0
function mk(over: Partial<AgendaEntry>): AgendaEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    source: 'mail',
    hot: false,
    title: `条目 ${seq}`,
    startIso: '2026-08-12T09:00:00Z',
    endIso: null,
    allDay: false,
    multiDay: false,
    ...over
  }
}

describe('agendaMemberId — 成员身份判据 (三源各一把钥匙)', () => {
  test('mail → calendarName, matter → matterId, agent → agentId', () => {
    expect(agendaMemberId(mk({ source: 'mail', calendarName: 'Work' }))).toBe('Work')
    expect(agendaMemberId(mk({ source: 'matter', matterId: 'MAT-1' }))).toBe('MAT-1')
    expect(agendaMemberId(mk({ source: 'agent', agentId: 'daily' }))).toBe('daily')
  })

  test('缺定位字段 → null (只受组级开关管, 恒显示)', () => {
    expect(agendaMemberId(mk({ source: 'mail' }))).toBeNull()
    expect(agendaMemberId(mk({ source: 'matter' }))).toBeNull()
    expect(agendaMemberId(mk({ source: 'agent' }))).toBeNull()
  })
})

describe('aggregateSourceMembers — 窗口条目 → 成员清单', () => {
  // 排序断言一律用 ASCII 标签: 中文标题的 localeCompare 结果随运行时默认 locale
  // 变 (root collation 按码位 → 「周报」在前; zh 排序按拼音 → 「日报」在前),
  // 拿中文断顺序就是在断跑测试那台机器的 ICU locale。
  test('agent: 同 agentId 的多次排程只出一条', () => {
    const entries = [
      mk({ source: 'agent', agentId: 'daily', title: 'Daily report' }),
      mk({ source: 'agent', agentId: 'daily', title: 'Daily report' }),
      mk({ source: 'agent', agentId: 'weekly', title: 'Weekly report' }),
      mk({ source: 'mail', calendarName: 'Work' })
    ]
    expect(aggregateSourceMembers(entries, 'agent')).toEqual([
      { id: 'daily', label: 'Daily report' },
      { id: 'weekly', label: 'Weekly report' }
    ])
  })

  test('matter: 行动项归其父事项, 名字取事项自己那条 (不是行动项标题)', () => {
    const entries = [
      mk({ source: 'matter', matterId: 'MAT-1', itemId: '77', title: '发对齐纪要' }),
      mk({ source: 'matter', matterId: 'MAT-1', title: 'AW 续约' }),
      mk({ source: 'matter', matterId: 'MAT-1', itemId: '78', title: '催报价' })
    ]
    expect(aggregateSourceMembers(entries, 'matter')).toEqual([{ id: 'MAT-1', label: 'AW 续约' }])
  })

  test('matter: 窗口里只有行动项时退而用行动项标题 (总比 public_id 强)', () => {
    const entries = [mk({ source: 'matter', matterId: 'MAT-9', itemId: '5', title: '交样品' })]
    expect(aggregateSourceMembers(entries, 'matter')).toEqual([{ id: 'MAT-9', label: '交样品' }])
  })

  test('按名排序; 空标题退回 id; 无成员身份的条目不进清单', () => {
    const entries = [
      mk({ source: 'agent', agentId: 'z-agent', title: 'Ccc' }),
      mk({ source: 'agent', agentId: 'a-agent', title: 'Aaa' }),
      mk({ source: 'agent', agentId: 'Bbb', title: '   ' }),
      mk({ source: 'agent', title: '没有 agentId' })
    ]
    expect(aggregateSourceMembers(entries, 'agent')).toEqual([
      { id: 'a-agent', label: 'Aaa' },
      { id: 'Bbb', label: 'Bbb' },
      { id: 'z-agent', label: 'Ccc' }
    ])
  })

  test('只看本组条目 (别的源不串味)', () => {
    const entries = [
      mk({ source: 'mail', calendarName: 'Work' }),
      mk({ source: 'agent', agentId: 'daily', title: '日报' }),
      mk({ source: 'matter', matterId: 'MAT-1', title: '事项' })
    ]
    expect(aggregateSourceMembers(entries, 'matter')).toEqual([{ id: 'MAT-1', label: '事项' }])
  })
})

describe('selectionFromExclusions — 「按日历筛选」下拉与邮箱组树是同一份状态', () => {
  const all = ['Work', 'Home', 'Shared']

  test('空排除集 → 空选中集 (下拉的「全部日历」语义, 不是逐个列全)', () => {
    expect(selectionFromExclusions(all, new Set())).toEqual([])
  })

  test('排除两个 → 选中集只剩没被排除的, 且保持 allIds 的顺序', () => {
    expect(selectionFromExclusions(all, new Set(['Home']))).toEqual(['Work', 'Shared'])
  })

  test('排除集里的陈旧 id (已不是任何日历) 不影响结果', () => {
    expect(selectionFromExclusions(all, new Set(['已删掉的日历']))).toEqual(all)
  })

  test('与 store.setSelectedMembers 互为逆运算 (两处 UI 动的是同一个集合)', () => {
    useCalendarView.setState({ excluded: { mail: new Set(), matter: new Set(), agent: new Set() } })
    // 下拉里只勾 Work → 换算成排除集
    useCalendarView.getState().setSelectedMembers('mail', all, ['Work'])
    expect([...useCalendarView.getState().excluded.mail].sort()).toEqual(['Home', 'Shared'])
    // 再读回下拉的选中集, 还是 Work
    expect(selectionFromExclusions(all, useCalendarView.getState().excluded.mail)).toEqual(['Work'])
  })
})

describe('groupCheckState — 组头三态', () => {
  test('组关 = off; 一条没排除 = on; 排除了一部分 = mixed', () => {
    expect(groupCheckState(false, 0, 3)).toBe('off')
    expect(groupCheckState(true, 0, 3)).toBe('on')
    expect(groupCheckState(true, 1, 3)).toBe('mixed')
  })

  test('成员一条不剩 = off (视觉上就是整组不显示)', () => {
    expect(groupCheckState(true, 3, 3)).toBe('off')
  })

  test('空成员的组 (窗口内没条目) 仍按组开关显示, 不是 mixed', () => {
    expect(groupCheckState(true, 0, 0)).toBe('on')
    expect(groupCheckState(false, 0, 0)).toBe('off')
  })
})
