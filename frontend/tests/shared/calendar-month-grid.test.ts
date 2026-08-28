// task 08-27 P3 — 月视图「每周一行」布局纯函数单测 (lib/monthGrid, node 环境,
// 零 hooks import 链, 对齐 calendar-filter.test.ts 惯例)。
// 覆盖: 周行分组 / 跨天色带跨列与跨周裁剪 / lane 堆叠 / 容量 4−色带 / 溢出计数 /
// 三源开关过滤 / 小月历色点首源语义 / 选中判定 ISO 容差。

import { describe, expect, test } from 'vitest'

import {
  agendaDayDotSources,
  entryDayRange,
  filterAgendaBySources,
  isAgendaEntrySelected,
  layoutMonthWeeks,
  MONTH_WEEK_COUNT
} from '../../src/shared/components/calendar/lib/monthGrid'
import type { AgendaEntry } from '../../src/shared/api/types'

/** 网格原点: 2026-06-01 本地 00:00 (测试只依赖它是"第 0 天", 不依赖星期几)。 */
const GRID_START = new Date(2026, 5, 1)

/** 第 n 天 h 点的本地时间 ISO。 */
function iso(day: number, hour = 0): string {
  return new Date(2026, 5, 1 + day, hour).toISOString()
}

let seq = 0
function mk(over: Partial<AgendaEntry>): AgendaEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    source: 'mail',
    hot: false,
    title: `事件 ${seq}`,
    startIso: iso(0, 9),
    endIso: iso(0, 10),
    allDay: false,
    multiDay: false,
    ...over
  }
}

describe('layoutMonthWeeks — 周行分组', () => {
  test('默认 6 周 × 7 天, 日期连续', () => {
    const weeks = layoutMonthWeeks([], GRID_START)
    expect(weeks).toHaveLength(MONTH_WEEK_COUNT)
    for (let w = 0; w < weeks.length; w++) {
      expect(weeks[w].days).toHaveLength(7)
      for (let i = 0; i < 7; i++) {
        const expected = new Date(2026, 5, 1 + w * 7 + i)
        expect(weeks[w].days[i].date.getTime()).toBe(expected.getTime())
      }
    }
  })

  test('单日条目落进所属周所属日', () => {
    const e0 = mk({ startIso: iso(0, 9), endIso: iso(0, 10) })
    const e8 = mk({ startIso: iso(8, 14), endIso: iso(8, 15) })
    const weeks = layoutMonthWeeks([e0, e8], GRID_START)
    expect(weeks[0].days[0].items.map((e) => e.id)).toEqual([e0.id])
    expect(weeks[1].days[1].items.map((e) => e.id)).toEqual([e8.id])
    // 其余格为空
    expect(weeks[0].days[1].items).toHaveLength(0)
  })

  test('日内排序: 全天在前, 其余按开始时间升序', () => {
    const late = mk({ startIso: iso(0, 15), endIso: iso(0, 16) })
    const early = mk({ startIso: iso(0, 8), endIso: iso(0, 9) })
    const allday = mk({ startIso: iso(0), endIso: iso(1), allDay: true })
    const weeks = layoutMonthWeeks([late, early, allday], GRID_START)
    expect(weeks[0].days[0].items.map((e) => e.id)).toEqual([allday.id, early.id, late.id])
  })
})

describe('layoutMonthWeeks — 跨天色带', () => {
  test('周内 3 天色带: startCol/span 与数据一致, 容量降为 3', () => {
    const band = mk({ startIso: iso(2, 9), endIso: iso(4, 17), multiDay: true })
    const weeks = layoutMonthWeeks([band], GRID_START)
    expect(weeks[0].bands).toHaveLength(1)
    expect(weeks[0].bands[0]).toMatchObject({ startCol: 2, span: 3, lane: 0 })
    expect(weeks[0].laneCount).toBe(1)
    expect(weeks[0].capacity).toBe(3)
    // 无色带的周容量回到 4
    expect(weeks[1].bands).toHaveLength(0)
    expect(weeks[1].capacity).toBe(4)
  })

  test('跨周色带: 两周各出一条, 端点被周边界裁剪', () => {
    // 第 5 天 → 第 9 天 (跨第 0/1 周边界)
    const band = mk({ startIso: iso(5, 9), endIso: iso(9, 17), multiDay: true })
    const weeks = layoutMonthWeeks([band], GRID_START)
    expect(weeks[0].bands[0]).toMatchObject({ startCol: 5, span: 2 })
    expect(weeks[1].bands[0]).toMatchObject({ startCol: 0, span: 3 })
    expect(weeks[2].bands).toHaveLength(0)
  })

  test('重叠色带分 lane 堆叠, 容量 = 4 − lane 数', () => {
    const a = mk({ startIso: iso(0, 9), endIso: iso(3, 17), multiDay: true })
    const b = mk({ startIso: iso(2, 9), endIso: iso(5, 17), multiDay: true })
    const weeks = layoutMonthWeeks([a, b], GRID_START)
    const lanes = weeks[0].bands.map((x) => x.lane).sort()
    expect(lanes).toEqual([0, 1])
    expect(weeks[0].laneCount).toBe(2)
    expect(weeks[0].capacity).toBe(2)
  })

  test('不重叠色带复用同一 lane', () => {
    const a = mk({ startIso: iso(0, 9), endIso: iso(1, 17), multiDay: true })
    const b = mk({ startIso: iso(3, 9), endIso: iso(4, 17), multiDay: true })
    const weeks = layoutMonthWeeks([a, b], GRID_START)
    expect(weeks[0].bands.map((x) => x.lane)).toEqual([0, 0])
    expect(weeks[0].capacity).toBe(3)
  })

  test('all-day 次日 00:00 结束不占用结束日', () => {
    // 全天两日事件: 第 10 天 00:00 → 第 12 天 00:00 (end exclusive) = 覆盖第 10-11 天
    const band = mk({ startIso: iso(10), endIso: iso(12), allDay: true, multiDay: true })
    const { firstDay, lastDay } = entryDayRange(band)
    expect(firstDay.getDate()).toBe(11) // 6 月 11 日 = 第 10 天
    expect(lastDay.getDate()).toBe(12)
    const weeks = layoutMonthWeeks([band], GRID_START)
    expect(weeks[1].bands[0]).toMatchObject({ startCol: 3, span: 2 })
  })
})

describe('layoutMonthWeeks — 溢出计数', () => {
  test('超出容量的条目进 moreCount ("还有 N 项")', () => {
    const band = mk({ startIso: iso(0, 9), endIso: iso(2, 17), multiDay: true })
    const singles = Array.from({ length: 5 }, (_, h) =>
      mk({ startIso: iso(1, 9 + h), endIso: iso(1, 10 + h) })
    )
    const weeks = layoutMonthWeeks([band, ...singles], GRID_START)
    const cell = weeks[0].days[1]
    expect(weeks[0].capacity).toBe(3)
    expect(cell.items).toHaveLength(5)
    expect(cell.visible).toHaveLength(3)
    expect(cell.moreCount).toBe(2)
  })
})

describe('filterAgendaBySources — 三源开关', () => {
  const entries = [
    mk({ source: 'mail' }),
    mk({ source: 'matter' }),
    mk({ source: 'agent' }),
    mk({ source: 'mail', hot: true })
  ]

  test('undefined = 全开', () => {
    expect(filterAgendaBySources(entries, undefined)).toHaveLength(4)
  })

  test('关掉 matter → 只剩 mail + agent (hot 归邮箱组随 mail 开关)', () => {
    const out = filterAgendaBySources(entries, { mail: true, matter: false, agent: true })
    expect(out.map((e) => e.source)).toEqual(['mail', 'agent', 'mail'])
  })

  test('关掉 mail → hot 条目一并消失', () => {
    const out = filterAgendaBySources(entries, { mail: false, matter: true, agent: true })
    expect(out.map((e) => e.source)).toEqual(['matter', 'agent'])
  })
})

describe('agendaDayDotSources — 小月历色点', () => {
  test('取当天最早开始条目的源; 跨天条目为覆盖的每一天投点', () => {
    const matterLate = mk({ source: 'matter', startIso: iso(0, 15), endIso: iso(0, 16) })
    const mailEarly = mk({ source: 'mail', startIso: iso(0, 8), endIso: iso(0, 9) })
    const agentBand = mk({
      source: 'agent',
      startIso: iso(3, 9),
      endIso: iso(5, 17),
      multiDay: true
    })
    const m = agendaDayDotSources([matterLate, mailEarly, agentBand])
    expect(m.get('2026-06-01')).toBe('mail') // 最早的是 mail
    expect(m.get('2026-06-04')).toBe('agent')
    expect(m.get('2026-06-05')).toBe('agent')
    expect(m.get('2026-06-06')).toBe('agent')
    expect(m.get('2026-06-07')).toBeUndefined()
  })
})

describe('isAgendaEntrySelected — 选中判定', () => {
  test('id + 开始时间双匹配; ISO 书写差异 (Z vs +00:00) 容忍', () => {
    const entry = mk({ eventId: 42, startIso: '2026-06-03T09:00:00Z' })
    expect(isAgendaEntrySelected(entry, '42-2026-06-03T09:00:00Z')).toBe(true)
    expect(isAgendaEntrySelected(entry, '42-2026-06-03T09:00:00+00:00')).toBe(true)
    expect(isAgendaEntrySelected(entry, '42-2026-06-03T10:00:00Z')).toBe(false)
    expect(isAgendaEntrySelected(entry, '41-2026-06-03T09:00:00Z')).toBe(false)
    expect(isAgendaEntrySelected(entry, null)).toBe(false)
  })

  test('非 mail 源恒不选中 (j/k 巡航序列只有邮箱事件)', () => {
    const entry = mk({ source: 'matter', eventId: 42, startIso: '2026-06-03T09:00:00Z' })
    expect(isAgendaEntrySelected(entry, '42-2026-06-03T09:00:00Z')).toBe(false)
  })
})
