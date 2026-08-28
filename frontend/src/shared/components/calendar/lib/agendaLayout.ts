// task 08-27 P5 —— 日/周时间轴视图的三源聚合布局纯函数 (月视图语言的延展)。
//
// 与 monthGrid.ts 的分工: 那边是月视图「每周一行」网格; 这里是日/周 timeline
// 需要的三件事 —— ① 条目三分 (置顶色带 / 定时块 / 时刻标记), ② 置顶条区的
// 色带列区间 + lane 堆叠 (复用 monthGrid 的 entryDayRange / assignBandLanes),
// ③ 时刻标记 (endIso=null, 不撑假时长) 的纵向定位与同刻级联避让。
//
// resolveMailOccurrence / agendaSrc 原在 MonthView 内, 日/周同构消费后上提到
// 这里 (纯函数 + 零 hooks import 链, node 环境直接单测)。

import type { AgendaEntry, AgendaSource, CalendarEventOccurrence } from '@shared/api/types'

import { addLocalDays, assignBandLanes, diffLocalDays, entryDayRange, localDay } from './monthGrid'
import { ymd } from './format'

/** 色带/胶囊/事件块的 data-src 值: hot (重要邮箱日程) 视觉独立但归邮箱组。 */
export function agendaSrc(entry: AgendaEntry): AgendaSource | 'hot' {
  return entry.source === 'mail' && entry.hot ? 'hot' : entry.source
}

/** mail 条目 → drawer / EventBlock 需要的 occurrence: 优先从同窗口 events 缓存
 *  解析 (Layout j/k 巡航同 queryKey, 命中即零额外 IPC); 未命中兜底合成最小形状
 *  (标题/时间可显示, 其余字段由 useCalendarEvent 详情查询补齐)。 */
export function resolveMailOccurrence(
  entry: AgendaEntry,
  occs: CalendarEventOccurrence[]
): CalendarEventOccurrence {
  const t = Date.parse(entry.startIso)
  const hit =
    occs.find((o) => o.id === entry.eventId && Date.parse(o.occurrence_start_iso) === t) ??
    (entry.icalUid
      ? occs.find((o) => o.ical_uid === entry.icalUid && Date.parse(o.occurrence_start_iso) === t)
      : undefined)
  if (hit) return hit
  return {
    id: entry.eventId ?? 0,
    ical_uid: entry.icalUid ?? '',
    recurrence_id: entry.recurrenceId ?? null,
    sequence: 0,
    summary: entry.title,
    occurrence_start_iso: entry.startIso,
    occurrence_end_iso: entry.endIso ?? entry.startIso,
    is_recurrence_instance: !!entry.recurrenceId,
    is_all_day: entry.allDay,
    calendar_name: entry.calendarName ?? '',
    organizer: '',
    attendees: [],
    location: '',
    url: '',
    status: '',
    response_status: '',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null
  }
}

export interface TimelineSplit {
  /** 置顶条区: 全天或跨天 (月视图色带同判据)。 */
  bands: AgendaEntry[]
  /** 时间轴事件块: 有始有终的 mail 定时条目 (EventBlock 渲染)。 */
  timed: AgendaEntry[]
  /** 时刻标记: 时间点条目 (matter 截止 / agent 排程 / 无 DTEND 的 mail),
   *  不撑假时长。 */
  moments: AgendaEntry[]
}

export function splitTimelineEntries(entries: AgendaEntry[]): TimelineSplit {
  const bands: AgendaEntry[] = []
  const timed: AgendaEntry[] = []
  const moments: AgendaEntry[] = []
  for (const e of entries) {
    if (e.allDay || e.multiDay) bands.push(e)
    else if (e.source === 'mail' && e.endIso) timed.push(e)
    else moments.push(e)
  }
  return { bands, timed, moments }
}

export interface TimelineBand {
  entry: AgendaEntry
  /** 区内起始列 (0-based, 裁剪到 [0, dayCount-1])。 */
  startCol: number
  /** 跨列数 ≥1。 */
  span: number
  /** 垂直堆叠序号。 */
  lane: number
}

/** 置顶条区布局: gridStart (本地 00:00) 起 dayCount 天, 与区间相交的条目出色带,
 *  端点裁剪到区边界; lane 堆叠与月视图同一套贪心 (assignBandLanes)。 */
export function layoutTimelineBands(
  entries: AgendaEntry[],
  gridStart: Date,
  dayCount: number
): { bands: TimelineBand[]; laneCount: number } {
  const gridEndIncl = addLocalDays(gridStart, dayCount - 1)
  const placements = entries
    .map((entry) => ({ entry, ...entryDayRange(entry) }))
    .filter(
      (m) =>
        m.firstDay.getTime() <= gridEndIncl.getTime() && m.lastDay.getTime() >= gridStart.getTime()
    )
    .map((m) => {
      const startCol = Math.max(0, diffLocalDays(m.firstDay, gridStart))
      const endCol = Math.min(dayCount - 1, diffLocalDays(m.lastDay, gridStart))
      return { entry: m.entry, startCol, span: endCol - startCol + 1 }
    })
  return assignBandLanes(placements)
}

/** 按本地开始日分组 (定时块 / 时刻标记进各自日列用), 键 = YYYY-MM-DD。 */
export function groupEntriesByLocalDay(entries: AgendaEntry[]): Map<string, AgendaEntry[]> {
  const m = new Map<string, AgendaEntry[]>()
  for (const e of entries) {
    const key = ymd(localDay(Date.parse(e.startIso)))
    const arr = m.get(key) ?? []
    arr.push(e)
    m.set(key, arr)
  }
  return m
}

/** 时刻标记条高 (px) —— 与月视图胶囊 19px 同族取 18 (色带同高)。 */
export const MOMENT_HEIGHT_PX = 18
const MOMENT_GAP_PX = 2

export interface TimelineMoment {
  entry: AgendaEntry
  /** 相对日列 00:00 的纵向偏移 (px)。 */
  topPx: number
}

/** 时刻标记纵向定位: top 按时刻换算; 同刻/近刻标记会重叠, 依序向下级联避让
 *  (20px 步进) —— 时间由标记自带的文本承载, 位置微移不撒谎。底部越界钳到
 *  最后一格 (重叠可接受, hover title 仍可辨)。 */
export function layoutDayMoments(
  entries: AgendaEntry[],
  dayStartMs: number,
  hourPx: number
): TimelineMoment[] {
  const sorted = [...entries].sort((a, b) => {
    const d = Date.parse(a.startIso) - Date.parse(b.startIso)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  const maxTop = 24 * hourPx - MOMENT_HEIGHT_PX
  let prevBottom = -Infinity
  return sorted.map((entry) => {
    const raw = ((Date.parse(entry.startIso) - dayStartMs) / 3_600_000) * hourPx
    const top = Math.min(Math.max(raw, 0, prevBottom), maxTop)
    prevBottom = top + MOMENT_HEIGHT_PX + MOMENT_GAP_PX
    return { entry, topPx: top }
  })
}
