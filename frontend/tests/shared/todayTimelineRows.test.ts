// 今日页右侧时间线列的纯模块单测（task 08-27 P5）。渲染面在 `TodaySurface.test.tsx`。
//
// 四条最容易做假的：
//   ① **当天窗口是硬过滤** —— 待回邮件的 atMs 是它到达的时刻（「等了 26 小时」那封是
//      昨天的），放进「今天的时间线」就是给它编一个今天的时刻。
//   ② 两套行模型都要进（简化行 + 例外面行）：原型那一列里会、agent 的 run、临期信号
//      分属三节，在这根轴上是同一列。
//   ③ `nowIndex` 是「线插在第几行之前」，**全部已过去时等于 rows.length**（线落末尾）。
//      给某一行打标记的写法表达不了这一档。
//   ④ 同刻两条的次序必须稳定，否则每次 refetch 都可能换位置。

import { describe, expect, test } from 'vitest'

import type { TodayGroup } from '@shared/components/today/todayGroups'
import type { TodaySectionItem, TodaySectionView } from '@shared/components/today/todaySections'
import { buildTodayTimeline } from '@shared/components/today/todayTimelineRows'

const DAY_START = Date.UTC(2026, 7, 31, 0, 0, 0)
const WINDOW = { startMs: DAY_START, endMs: DAY_START + 86_400_000 }
const NOW = DAY_START + 12 * 3600_000

function at(hours: number): number {
  return DAY_START + Math.round(hours * 3600_000)
}

function row(id: string, atMs: number, over: Partial<TodaySectionItem> = {}): TodaySectionItem {
  return {
    id,
    source: 'calendar',
    title: `标题 ${id}`,
    why: `为什么 ${id}`,
    meta: '',
    atMs,
    actionable: false,
    link: { kind: 'calendar' },
    ...over
  }
}

function group(id: string, atMs: number, over: Record<string, unknown> = {}): TodayGroup {
  return {
    id: 'waiting',
    items: [
      {
        id,
        source: 'run',
        state: 'paused_pending',
        title: `Run ${id}`,
        triageLogic: `触发 ${id}`,
        at: atMs,
        link: { jobId: 1, agentId: 'weekly-digest', sessionId: null },
        ...over
      }
    ]
  } as TodayGroup
}

/** 只填本模块读的三个字段（count / meta 是二级栏用的，与这一列无关）。 */
function section(
  id: TodaySectionView['id'],
  rows: TodaySectionItem[],
  groups: TodayGroup[] = []
): TodaySectionView {
  return { id, rows, groups, count: rows.length, meta: '' }
}

describe('buildTodayTimeline', () => {
  test('两套行模型都进同一列，按时刻升序', () => {
    const view = buildTodayTimeline(
      [
        section('meet', [row('calendar:a', at(14))]),
        section('out', [row('report:b', at(9), { source: 'report' })], [group('run:c', at(9.5))])
      ],
      WINDOW,
      NOW
    )
    expect(view.rows.map((r) => r.id)).toEqual(['report:b', 'run:c', 'calendar:a'])
    // 副行：简化行取 `why`，例外面行取 `triageLogic` —— 两套模型各自那一句，不混。
    expect(view.rows.map((r) => r.sub)).toEqual([
      '为什么 report:b',
      '触发 run:c',
      '为什么 calendar:a'
    ])
  })

  test('🔴 窗口外的条目不进（昨天到的那封待回邮件不该出现在今天的时间线上）', () => {
    const view = buildTodayTimeline(
      [
        section('reply', [
          row('mail:yesterday', at(-2), { source: 'mail' }),
          row('mail:today', at(8), { source: 'mail' })
        ]),
        // 明天 00:00 是**下一天**的第一刻，右端开区间把它排除。
        section('meet', [row('calendar:tomorrow', at(24))])
      ],
      WINDOW,
      NOW
    )
    expect(view.rows.map((r) => r.id)).toEqual(['mail:today'])
  })

  test('nowIndex = 现在之后最早那条的下标（线插在它之前）', () => {
    const view = buildTodayTimeline(
      [section('meet', [row('a', at(9)), row('b', at(14)), row('c', at(16))])],
      WINDOW,
      NOW
    )
    expect(view.nowIndex).toBe(1)
    expect(view.rows[view.nowIndex].id).toBe('b')
  })

  test('🔴 全部已经过去 → nowIndex = rows.length（线落末尾，不是没有线）', () => {
    const view = buildTodayTimeline(
      [section('meet', [row('a', at(9)), row('b', at(10))])],
      WINDOW,
      NOW
    )
    expect(view.nowIndex).toBe(2)
  })

  test('全部还没到 → nowIndex = 0（线落最上面）', () => {
    const view = buildTodayTimeline(
      [section('meet', [row('a', at(14)), row('b', at(16))])],
      WINDOW,
      NOW
    )
    expect(view.nowIndex).toBe(0)
  })

  test('恰好等于此刻的那条算「还没到」（>= 而不是 >）', () => {
    const view = buildTodayTimeline([section('meet', [row('a', NOW)])], WINDOW, NOW)
    expect(view.nowIndex).toBe(0)
  })

  test('同刻两条按 id 稳定排序（refetch 不换位置）', () => {
    const forward = buildTodayTimeline(
      [section('meet', [row('calendar:b', at(9)), row('calendar:a', at(9))])],
      WINDOW,
      NOW
    )
    const reversed = buildTodayTimeline(
      [section('meet', [row('calendar:a', at(9)), row('calendar:b', at(9))])],
      WINDOW,
      NOW
    )
    expect(forward.rows.map((r) => r.id)).toEqual(['calendar:a', 'calendar:b'])
    expect(reversed.rows.map((r) => r.id)).toEqual(forward.rows.map((r) => r.id))
  })

  test('空态：五节全空 → 没有行，nowIndex 落 0（渲染面据此走空态文案）', () => {
    const view = buildTodayTimeline([section('meet', []), section('out', [])], WINDOW, NOW)
    expect(view.rows).toEqual([])
    expect(view.nowIndex).toBe(0)
  })

  test('时刻解析不出来的行不进（不画一个 Invalid Date 的圆点）', () => {
    const view = buildTodayTimeline([section('meet', [row('bad', Number.NaN)])], WINDOW, NOW)
    expect(view.rows).toEqual([])
  })
})
