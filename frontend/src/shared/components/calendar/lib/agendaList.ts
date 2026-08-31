// task 08-27 P4d —— 日程视图 (AgendaView) 的分组纯函数。
//
// 与 monthGrid / agendaLayout 的分工: 那两处是月网格与日/周时间轴的几何; 这里
// 是「按日成组的清单」要的三件事 ——
//   ① 跨天条目按 overlap 展开到它覆盖的每一天 (日区间判据复用 entryDayRange,
//      与月视图色带同一把尺子), 端点裁剪到窗口;
//   ② 组内排序: 全天/跨天在前, 其余按当日实际覆盖段起点;
//   ③ 连续空日折叠成一行 —— 窗口 14 天里空掉四天不该让人滚过四个空白组头。
//
// 纯函数 + 零 hooks import 链 (对齐 monthGrid.ts / agendaLayout.ts 惯例), node
// 环境直接单测。

import type { AgendaEntry } from '@shared/api/types'

import { ymd } from './format'
import { addLocalDays, diffLocalDays, entryDayRange } from './monthGrid'

export interface AgendaRow {
  entry: AgendaEntry
  /** 该行所在日是条目的首日 (时间列显 `10:00 →` 的判据)。 */
  isFirstDay: boolean
  /** 该行所在日是条目的末日 (时间列显 `→ 16:00` 的判据)。 */
  isLastDay: boolean
  /** 条目覆盖多个日历日。 */
  spansDays: boolean
  /** 组内排序键 = 当日实际覆盖段起点 (跨午夜续行 = 当日 00:00)。 */
  segStartMs: number
}

export type AgendaSection =
  | { kind: 'day'; key: string; date: Date; rows: AgendaRow[] }
  /** 连续空日折叠行, [from, to] 含端点; days = 折叠掉的天数。 */
  | { kind: 'gap'; key: string; from: Date; to: Date; days: number }

/** 组内排序: 全天/跨天在前 (置顶条区在月/周视图里的同一套语言), 其余按当日覆盖
 *  段起点升序; 同刻按 id 稳定。 */
function sortRows(rows: AgendaRow[]): AgendaRow[] {
  return [...rows].sort((a, b) => {
    const aTop = a.entry.allDay || a.spansDays
    const bTop = b.entry.allDay || b.spansDays
    if (aTop !== bTop) return aTop ? -1 : 1
    if (a.segStartMs !== b.segStartMs) return a.segStartMs - b.segStartMs
    return a.entry.id.localeCompare(b.entry.id)
  })
}

/** 窗口 = windowStart (本地 00:00) 起 dayCount 天。返回顺序即渲染顺序:
 *  有条目的日出 `day` 段, 中间/首尾的连续空日折叠成单个 `gap` 段。 */
export function buildAgendaSections(
  entries: readonly AgendaEntry[],
  windowStart: Date,
  dayCount: number
): AgendaSection[] {
  const windowEndIncl = addLocalDays(windowStart, dayCount - 1)
  const byDay = new Map<string, AgendaRow[]>()

  for (const entry of entries) {
    const { firstDay, lastDay } = entryDayRange(entry)
    const spansDays = diffLocalDays(lastDay, firstDay) > 0
    const from = firstDay.getTime() < windowStart.getTime() ? windowStart : firstDay
    const to = lastDay.getTime() > windowEndIncl.getTime() ? windowEndIncl : lastDay
    for (let d = 0; d <= diffLocalDays(to, from); d++) {
      const day = addLocalDays(from, d)
      const isFirstDay = day.getTime() === firstDay.getTime()
      const rows = byDay.get(ymd(day)) ?? []
      rows.push({
        entry,
        isFirstDay,
        isLastDay: day.getTime() === lastDay.getTime(),
        spansDays,
        segStartMs: isFirstDay ? Date.parse(entry.startIso) : day.getTime()
      })
      byDay.set(ymd(day), rows)
    }
  }

  const sections: AgendaSection[] = []
  let gapFrom: Date | null = null
  const flushGap = (until: Date): void => {
    if (!gapFrom) return
    sections.push({
      kind: 'gap',
      key: `gap-${ymd(gapFrom)}`,
      from: gapFrom,
      to: until,
      days: diffLocalDays(until, gapFrom) + 1
    })
    gapFrom = null
  }

  for (let i = 0; i < dayCount; i++) {
    const date = addLocalDays(windowStart, i)
    const key = ymd(date)
    const rows = byDay.get(key)
    if (!rows || rows.length === 0) {
      gapFrom ??= date
      continue
    }
    flushGap(addLocalDays(date, -1))
    sections.push({ kind: 'day', key, date, rows: sortRows(rows) })
  }
  flushGap(windowEndIncl)

  return sections
}
