// 阶段2·2.7 (F18/UX-P0④) — j/k 键盘巡航纯函数层: 视图窗口口径 / 可见事件
// 有序序列 / 锚点步进. CalendarLayout 消费, 视图文件零改动.
//
// 窗口计算必须与四视图各自的 useCalendarEventsInWindow 调用参数逐字节一致
// (同 queryKey → react-query 缓存命中, 零额外 IPC):
//   today  → DayView    本地 00:00 ~ +1d
//   week   → WeekView   startOfWeek ~ +7d
//   month  → MonthView  startOfWeek(startOfMonth) ~ +42d
//   agenda → AgendaView todayStartLocal ~ +14d (rangeDays 默认值)
//   recurring → null (无时间轴, 不参与巡航)

import type { CalendarEventOccurrence } from '@shared/api/types'
import type { CalendarView } from '@shared/router-instance'

import {
  addDays,
  expandOccurrencesByLocalDayOverlap,
  startOfMonth,
  startOfWeek,
  todayStartLocal
} from '../hooks/useCalendarEvents'

import { ymd } from './format'
import { occurrenceKey } from './occurrence-key'

/** 选中锚点 key — 与 Layout / 四视图的 `${id}-${occurrence_start_iso}` 同一约定.
 *  实现下沉到零依赖叶子 lib/occurrence-key.ts (本文件顶层拉 hooks 链, 纯函数
 *  模块 import 不起); 这里原样再导出, 既有消费点照旧从 key-nav 取. */
export { occurrenceKey }

/** AgendaView rangeDays 默认值 (Layout 未传参, 与之对齐). */
const AGENDA_RANGE_DAYS = 14

export interface KeyNavWindow {
  fromIso: string
  toIso: string
}

export function keyNavWindow(view: CalendarView, currentDate: Date): KeyNavWindow | null {
  if (view === 'today') {
    const dayStart = new Date(currentDate)
    dayStart.setHours(0, 0, 0, 0)
    return { fromIso: dayStart.toISOString(), toIso: addDays(dayStart, 1).toISOString() }
  }
  if (view === 'week') {
    const weekStart = startOfWeek(currentDate)
    return { fromIso: weekStart.toISOString(), toIso: addDays(weekStart, 7).toISOString() }
  }
  if (view === 'month') {
    const gridStart = startOfWeek(startOfMonth(currentDate))
    return { fromIso: gridStart.toISOString(), toIso: addDays(gridStart, 42).toISOString() }
  }
  if (view === 'agenda') {
    const start = todayStartLocal()
    return {
      fromIso: start.toISOString(),
      toIso: addDays(start, AGENDA_RANGE_DAYS).toISOString()
    }
  }
  return null
}

/** 当前视图「可见事件有序序列」.
 *  day/week/month — 时间序 (start, end 次序), 与 layoutDay 主排序一致; month
 *  的 "+n more" 折叠 chips 也计入 (选中可能落在 more-pop 内, 近似可接受).
 *  agenda — 与其展开序一致: 日 (YYYY-MM-DD 升序, 按窗口 [start, end) 过滤)
 *  → 日内 all-day 前 + segStartMs 升序; 跨天事件按首个出现日去重 (选中 key
 *  不区分日段, 后续日 continuation 行同 key 同步高亮). */
export function buildKeyNavSequence(
  view: CalendarView,
  occs: CalendarEventOccurrence[]
): CalendarEventOccurrence[] {
  if (view === 'agenda') {
    const start = todayStartLocal()
    const startKey = ymd(start)
    const endKey = ymd(addDays(start, AGENDA_RANGE_DAYS))
    const grouped = expandOccurrencesByLocalDayOverlap(occs)
    const sortedKeys = Array.from(grouped.keys())
      .filter((k) => k >= startKey && k < endKey)
      .sort()
    const seen = new Set<string>()
    const seq: CalendarEventOccurrence[] = []
    for (const dayKey of sortedKeys) {
      const entries = (grouped.get(dayKey) ?? []).slice().sort((a, b) => {
        if (a.occ.is_all_day !== b.occ.is_all_day) return a.occ.is_all_day ? -1 : 1
        return a.segStartMs - b.segStartMs
      })
      for (const entry of entries) {
        const key = occurrenceKey(entry.occ)
        if (seen.has(key)) continue
        seen.add(key)
        seq.push(entry.occ)
      }
    }
    return seq
  }
  return [...occs].sort((a, b) => {
    const aS = Date.parse(a.occurrence_start_iso)
    const bS = Date.parse(b.occurrence_start_iso)
    if (aS !== bS) return aS - bS
    return Date.parse(a.occurrence_end_iso) - Date.parse(b.occurrence_end_iso)
  })
}

/** 2.2↔2.7 —「在日历中查看」跨面定位: 在序列中按 uid/recurrence_id 匹配
 *  目标 occurrence. recurrence_id 精确命中优先; 失败或未指定时退化为同 uid
 *  第一个未来 occurrence, 再退化任意第一个 (detached occurrence 改期后 rid
 *  失配仍能定位到该系列). 无 uid 命中 → null (事件过期/被删, caller 静默放弃). */
export function matchFocusTarget(
  seq: CalendarEventOccurrence[],
  target: { icalUid: string; recurrenceId: string | null },
  nowMs: number
): CalendarEventOccurrence | null {
  const candidates = seq.filter((o) => o.ical_uid === target.icalUid)
  if (candidates.length === 0) return null
  return (
    (target.recurrenceId
      ? candidates.find((o) => o.recurrence_id === target.recurrenceId)
      : undefined) ??
    candidates.find((o) => Date.parse(o.occurrence_start_iso) >= nowMs) ??
    candidates[0]
  )
}

/** j/k 步进: dir=+1 下一个 / -1 上一个; 端点不回绕.
 *  无锚点 (或锚点已不在序列, 如日期步进/窗口切换后) 时: j 从「现在之后最近
 *  事件」起步 (无未来事件则第一个); k 从「现在之前最近事件」起步 (无则第一个). */
export function stepAnchor(
  seq: CalendarEventOccurrence[],
  currentKey: string | null,
  dir: 1 | -1,
  nowMs: number
): CalendarEventOccurrence | null {
  if (seq.length === 0) return null
  const idx = currentKey ? seq.findIndex((o) => occurrenceKey(o) === currentKey) : -1
  if (idx === -1) {
    if (dir === 1) {
      return seq.find((o) => Date.parse(o.occurrence_start_iso) >= nowMs) ?? seq[0]
    }
    for (let i = seq.length - 1; i >= 0; i--) {
      if (Date.parse(seq[i].occurrence_start_iso) <= nowMs) return seq[i]
    }
    return seq[0]
  }
  return seq[Math.min(seq.length - 1, Math.max(0, idx + dir))]
}
