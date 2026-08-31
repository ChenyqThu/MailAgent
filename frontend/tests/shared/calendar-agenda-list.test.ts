// task 08-27 P4d — 日程视图分组纯函数 (lib/agendaList)。
//
// 三件被测的事: ① 跨天条目按 overlap 展开到每一天并标出首/中/末 (时间列分段
// 靠它); ② 组内「全天 / 跨天排最前」; ③ 连续空日折叠成一行。
//
// 🔴 ② 的 fixture 有意让全天条目的 startIso **不是本地 00:00**, 且在数组里排
// 在单日条目后面 —— 全天事件从 CalDAV 过来常带非本地零点的时刻 (UTC 零点在
// 西八区就是前一天 17:00)。若 fixture 用本地 00:00, 按开始时间排也恰好在最前,
// 这条断言就成了恒绿装饰。

import { describe, expect, test } from 'vitest'

import type { AgendaEntry } from '@shared/api/types'
import { buildAgendaSections } from '@shared/components/calendar/lib/agendaList'
import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'

/** 窗口起点固定在一个普通工作日 (本地 00:00), 与真实运行时刻无关。 */
const WIN_START = new Date(2026, 7, 31)

function at(dayOffset: number, hour: number, minute = 0): string {
  return new Date(2026, 7, 31 + dayOffset, hour, minute).toISOString()
}

let seq = 0
function mk(over: Partial<AgendaEntry> = {}): AgendaEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    source: 'mail',
    hot: false,
    title: `条目 ${seq}`,
    startIso: at(0, 9),
    endIso: at(0, 10),
    allDay: false,
    multiDay: false,
    ...over
  }
}

function dayTitles(section: ReturnType<typeof buildAgendaSections>[number]): string[] {
  return section.kind === 'day' ? section.rows.map((r) => r.entry.title) : []
}

describe('buildAgendaSections — 跨天展开', () => {
  test('跨 3 天条目在覆盖的每一天各出一行, 首/中/末标志到位', () => {
    const sections = buildAgendaSections(
      [mk({ title: '出差行程', startIso: at(0, 10), endIso: at(2, 16), multiDay: true })],
      WIN_START,
      5
    )
    const days = sections.filter((s) => s.kind === 'day')
    expect(days).toHaveLength(3)
    const flags = days.map((s) => (s.kind === 'day' ? s.rows[0] : null))
    expect(flags.map((r) => r?.isFirstDay)).toEqual([true, false, false])
    expect(flags.map((r) => r?.isLastDay)).toEqual([false, false, true])
    expect(flags.every((r) => r?.spansDays)).toBe(true)
    // 续行的排序键是当日 00:00 (不是条目起点), 时间列才能显「全天 / → 16:00」
    expect(flags[1]?.segStartMs).toBe(new Date(2026, 8, 1).getTime())
  })

  test('起于窗口之前的条目从窗口首日开始出行, 且首日不当成 isFirstDay', () => {
    const sections = buildAgendaSections(
      [mk({ title: '年假', allDay: true, startIso: at(-3, 0), endIso: at(1, 0), multiDay: true })],
      WIN_START,
      5
    )
    const days = sections.filter((s) => s.kind === 'day')
    // end 恰为 00:00 归前一日 ⇒ 窗口内覆盖 8/31 一天
    expect(days).toHaveLength(1)
    const row = days[0].kind === 'day' ? days[0].rows[0] : null
    expect(row?.isFirstDay).toBe(false)
    expect(row?.isLastDay).toBe(true)
  })
})

describe('buildAgendaSections — 组内排序', () => {
  test('全天与跨天排在定时条目之前 (与它们自己的开始时刻无关)', () => {
    const sections = buildAgendaSections(
      [
        mk({ title: '单日 09:00', startIso: at(0, 9), endIso: at(0, 10) }),
        mk({ title: '跨天 10:00', startIso: at(0, 10), endIso: at(1, 16), multiDay: true }),
        mk({ title: '全天 12:00', allDay: true, startIso: at(0, 12), endIso: at(0, 23) })
      ],
      WIN_START,
      3
    )
    expect(dayTitles(sections[0])).toEqual(['跨天 10:00', '全天 12:00', '单日 09:00'])
  })
})

describe('buildAgendaSections — 空日折叠', () => {
  test('首尾与中间的连续空日各折叠成一行, 带天数与端点', () => {
    const sections = buildAgendaSections(
      [
        mk({ title: '第 3 天的会', startIso: at(2, 9), endIso: at(2, 10) }),
        mk({ title: '第 6 天的会', startIso: at(5, 9), endIso: at(5, 10) })
      ],
      WIN_START,
      8
    )
    expect(sections.map((s) => s.kind)).toEqual(['gap', 'day', 'gap', 'day', 'gap'])
    const gaps = sections.filter((s) => s.kind === 'gap')
    expect(gaps.map((g) => (g.kind === 'gap' ? g.days : 0))).toEqual([2, 2, 2])
    const first = gaps[0]
    expect(first.kind === 'gap' && first.from.getDate()).toBe(31)
    expect(first.kind === 'gap' && first.to.getDate()).toBe(1)
  })

  test('单个空日的折叠行 days=1 且首尾同日', () => {
    const sections = buildAgendaSections(
      [
        mk({ title: '今天', startIso: at(0, 9), endIso: at(0, 10) }),
        mk({ title: '后天', startIso: at(2, 9), endIso: at(2, 10) })
      ],
      WIN_START,
      3
    )
    const gap = sections[1]
    expect(gap.kind).toBe('gap')
    expect(gap.kind === 'gap' && gap.days).toBe(1)
    expect(gap.kind === 'gap' && gap.from.getTime()).toBe(gap.kind === 'gap' ? gap.to.getTime() : 0)
  })
})

describe('日程视图 i18n', () => {
  test('calendar.view.agenda 子树 zh-CN 与 en-US 逐 key 相等', () => {
    const zh = (zhCN as Record<string, any>).calendar?.view?.agenda
    const en = (enUS as Record<string, any>).calendar?.view?.agenda
    // canary: 子树整个改名/搬家必须红, 不许平凡绿。
    expect(zh, 'zh-CN 缺 calendar.view.agenda').toBeTruthy()
    expect(en, 'en-US 缺 calendar.view.agenda').toBeTruthy()
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh)).toContain('gapRange')
  })
})
