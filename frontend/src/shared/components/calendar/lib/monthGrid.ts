// task 08-27 P3 —— 月视图「每周一行」布局纯函数 (design §七 / r2 calmon)。
//
// 为什么不是一整块 42 格 grid: 跨天色带要在**行内**绝对定位横跨若干列, 整块
// grid 做不到干净的跨列。每周一行后, 行内先渲染色带 (top 按 lane 序号叠),
// 事件区 padding-top = 色带条数 × 20px, 每格容量 = 4 − 该周色带条数。
//
// 纯函数 + 零 hooks import 链 (对齐 calendar-filter.ts 惯例), node 环境直接单测。
// 时间语义: 一律本地时区的"日历日" (与 expandOccurrencesByLocalDayOverlap 同款
// endMs-1 技巧 —— 结束恰在 00:00 的不占用结束日)。

import type { AgendaEntry, AgendaSource } from '@shared/api/types'

import { ymd } from './format'

/** 每格基础容量 (无色带时)。 */
export const MONTH_CELL_CAPACITY = 4
/** 月网格固定 6 周 42 天 (与 keyNavWindow 的 month 窗口 / agenda 查询窗口对齐)。 */
export const MONTH_WEEK_COUNT = 6
/** 防脏数据 (end 远超 start) 撑爆展开的安全上限 (天)。 */
const MAX_SPAN_DAYS = 60

/** 三源开关判据 (client-side 过滤, 不进 queryKey)。undefined = 全开。 */
export function filterAgendaBySources(
  entries: AgendaEntry[],
  sources?: Readonly<Record<AgendaSource, boolean>>
): AgendaEntry[] {
  if (!sources) return entries
  return entries.filter((e) => sources[e.source])
}

/** 本地日历日 (00:00)。 */
export function localDay(ms: number): Date {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 本地日历算术加天 (setDate 溢出进位, DST 安全)。 */
export function addLocalDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/** 两个本地 00:00 Date 的日历天差 (round 而非 floor — 跨 DST 的 23/25h 仍取整数天)。 */
export function diffLocalDays(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000)
}

/** entry 覆盖的本地日区间 [firstDay, lastDay] (含端点)。
 *  endIso 恰为 00:00 时归前一日 (all-day 事件 end 惯例为次日 00:00); 零长/
 *  倒挂/无 end 退化为单日。 */
export function entryDayRange(entry: AgendaEntry): { firstDay: Date; lastDay: Date } {
  const startMs = Date.parse(entry.startIso)
  const endMs = entry.endIso ? Date.parse(entry.endIso) : startMs
  const firstDay = localDay(startMs)
  let lastDay = localDay(Math.max(endMs - 1, startMs))
  if (diffLocalDays(lastDay, firstDay) > MAX_SPAN_DAYS) {
    lastDay = addLocalDays(firstDay, MAX_SPAN_DAYS)
  }
  return { firstDay, lastDay }
}

/** 色带贪心 lane 分配 (月视图周行与日/周视图置顶条区共用)。
 *  先排序 (startCol 升序 → span 降序 → 开始时间升序) 再放进首个不重叠的 lane。 */
export interface BandPlacement {
  entry: AgendaEntry
  /** 区内起始列 (0-based)。 */
  startCol: number
  /** 跨列数 ≥1。 */
  span: number
}

export function assignBandLanes(placements: BandPlacement[]): {
  bands: (BandPlacement & { lane: number })[]
  laneCount: number
} {
  const sorted = [...placements].sort((a, b) => {
    if (a.startCol !== b.startCol) return a.startCol - b.startCol
    if (a.span !== b.span) return b.span - a.span
    return Date.parse(a.entry.startIso) - Date.parse(b.entry.startIso)
  })
  const laneEnds: number[] = [] // 每 lane 当前占到的 endCol
  const bands = sorted.map((b) => {
    let lane = laneEnds.findIndex((end) => end < b.startCol)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(b.startCol + b.span - 1)
    } else {
      laneEnds[lane] = b.startCol + b.span - 1
    }
    return { ...b, lane }
  })
  return { bands, laneCount: laneEnds.length }
}

export interface MonthWeekBand {
  entry: AgendaEntry
  /** 周内起始列 0-6。 */
  startCol: number
  /** 跨列数 ≥1。 */
  span: number
  /** 垂直堆叠序号 (top = 4 + lane × 20)。 */
  lane: number
}

export interface MonthDayCell {
  date: Date
  /** YYYY-MM-DD 本地键。 */
  key: string
  /** 当日全部单日条目 (排序后)。 */
  items: AgendaEntry[]
  /** 容量内可见条目。 */
  visible: AgendaEntry[]
  /** 溢出条数 ("还有 N 项")。 */
  moreCount: number
}

export interface MonthWeekLayout {
  /** 周首日 (本地 00:00)。 */
  start: Date
  days: MonthDayCell[]
  bands: MonthWeekBand[]
  /** 色带占用的 lane 数 (0 = 无色带)。 */
  laneCount: number
  /** 每格容量 = max(0, 4 − laneCount)。 */
  capacity: number
}

/** 单日条目排序: 全天在前, 其余按开始时间升序 (与老 MonthView 同语义)。 */
function sortDayItems(items: AgendaEntry[]): AgendaEntry[] {
  return [...items].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    return Date.parse(a.startIso) - Date.parse(b.startIso)
  })
}

/** 每周一行布局: gridStart (周一 00:00) 起 weekCount 周。
 *  multiDay 条目 → 各覆盖周的色带 (跨周各出一条, 端点被周边界裁剪);
 *  其余 → 起始日的格内条目, 容量 4 − 该周色带 lane 数, 超出计入 moreCount。 */
export function layoutMonthWeeks(
  entries: AgendaEntry[],
  gridStart: Date,
  weekCount: number = MONTH_WEEK_COUNT
): MonthWeekLayout[] {
  const singlesByDay = new Map<string, AgendaEntry[]>()
  const multiDay: { entry: AgendaEntry; firstDay: Date; lastDay: Date }[] = []
  for (const entry of entries) {
    if (entry.multiDay) {
      const { firstDay, lastDay } = entryDayRange(entry)
      multiDay.push({ entry, firstDay, lastDay })
    } else {
      const key = ymd(localDay(Date.parse(entry.startIso)))
      const arr = singlesByDay.get(key) ?? []
      arr.push(entry)
      singlesByDay.set(key, arr)
    }
  }

  const weeks: MonthWeekLayout[] = []
  for (let w = 0; w < weekCount; w++) {
    const weekStart = addLocalDays(gridStart, w * 7)
    const weekEndIncl = addLocalDays(weekStart, 6)

    // 与本周相交的跨天条目 → 色带 (列区间裁剪到 [0,6]), 贪心 lane 分配。
    const raw = multiDay
      .filter(
        (m) =>
          m.firstDay.getTime() <= weekEndIncl.getTime() &&
          m.lastDay.getTime() >= weekStart.getTime()
      )
      .map((m) => {
        const startCol = Math.max(0, diffLocalDays(m.firstDay, weekStart))
        const endCol = Math.min(6, diffLocalDays(m.lastDay, weekStart))
        return { entry: m.entry, startCol, span: endCol - startCol + 1 }
      })
    const { bands, laneCount } = assignBandLanes(raw)
    const capacity = Math.max(0, MONTH_CELL_CAPACITY - laneCount)
    const days: MonthDayCell[] = Array.from({ length: 7 }, (_, i) => {
      const date = addLocalDays(weekStart, i)
      const key = ymd(date)
      const items = sortDayItems(singlesByDay.get(key) ?? [])
      const visible = items.slice(0, capacity)
      return { date, key, items, visible, moreCount: items.length - visible.length }
    })

    weeks.push({ start: weekStart, days, bands, laneCount, capacity })
  }
  return weeks
}

/** 选中判定: Layout 传的 selectedKey = `${occurrence.id}-${occurrence_start_iso}`
 *  (lib/key-nav occurrenceKey)。仅 mail 条目参与 (j/k 巡航序列只有邮箱事件);
 *  时间比较走 Date.parse 容忍 ISO 书写差异 ('Z' vs '+00:00')。 */
export function isAgendaEntrySelected(entry: AgendaEntry, selectedKey: string | null): boolean {
  if (!selectedKey || entry.source !== 'mail' || entry.eventId == null) return false
  const prefix = `${entry.eventId}-`
  if (!selectedKey.startsWith(prefix)) return false
  const iso = selectedKey.slice(prefix.length)
  return Date.parse(iso) === Date.parse(entry.startIso)
}
