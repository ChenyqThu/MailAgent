// Phase 3 §3.2 — Calendar SSoT 视图共用 hooks.
//
// useCalendarEventsInWindow: 拉时间窗口内 occurrences (RRULE 已展开). 默认
// staleTime 60s (calendar 数据 worker 60s 轮询, 用户切视图不必重 fetch).
//
// useCalendarSyncStatus: 拉 sync_state 表 (footer "上次同步 N 秒前" 提示).
// useCalendarNames: 拉 distinct calendar_name list (顶部 calendar 切换 chip).

import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useMailApi } from '@shared/hooks/useMailApi'
import type {
  CalendarEventDetail,
  CalendarEventOccurrence,
  CalendarEventSource,
  CalendarSyncStateItem,
  EventGetOpts,
  EventsListOpts,
  SyncNowOpts
} from '@shared/api/types'
import { toastError, toastSuccess } from '@shared/state/toast'

export const CALENDAR_EVENTS_KEY = ['calendar', 'events'] as const
export const CALENDAR_SYNC_STATUS_KEY = ['calendar', 'syncStatus'] as const
export const CALENDAR_NAMES_KEY = ['calendar', 'names'] as const

export function useCalendarEventsInWindow(opts: EventsListOpts): {
  data: CalendarEventOccurrence[] | undefined
  isLoading: boolean
  isError: boolean
  refetch: () => void
} {
  const mailApi = useMailApi()
  const q = useQuery({
    queryKey: [...CALENDAR_EVENTS_KEY, opts.fromIso, opts.toIso, opts.calendarName, opts.source, opts.expandRecurrences],
    queryFn: () => mailApi.calendar.eventsList(opts),
    staleTime: 60_000,
    refetchInterval: 60_000,            // 跟后端 worker 60s ctag 轮询同频, 数据 1min 内必到前端
    refetchIntervalInBackground: false, // tab 后台不刷, 省功
    refetchOnWindowFocus: true          // 回到 tab 立即 refresh
  })
  return {
    data: q.data,
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: () => void q.refetch()
  }
}

export function useCalendarEvent(opts: EventGetOpts | null): {
  data: CalendarEventDetail | null | undefined
  isLoading: boolean
} {
  const mailApi = useMailApi()
  const q = useQuery({
    queryKey: ['calendar', 'event', opts?.icalUid, opts?.recurrenceId, opts?.source],
    queryFn: () => mailApi.calendar.eventGet(opts!),
    enabled: !!opts && !!opts.icalUid,
    staleTime: 60_000
  })
  return { data: q.data, isLoading: q.isLoading }
}

export function useCalendarSyncStatus(): {
  data: CalendarSyncStateItem[] | undefined
  isLoading: boolean
  refetch: () => void
} {
  const mailApi = useMailApi()
  const q = useQuery({
    queryKey: CALENDAR_SYNC_STATUS_KEY,
    queryFn: () => mailApi.calendar.syncStatus(),
    staleTime: 30_000,
    refetchInterval: 60_000  // 持续刷 "上次同步 N 秒前" 显示
  })
  return {
    data: q.data,
    isLoading: q.isLoading,
    refetch: () => void q.refetch()
  }
}

export function useCalendarNames(): {
  data: string[] | undefined
  isLoading: boolean
} {
  const mailApi = useMailApi()
  const q = useQuery({
    queryKey: CALENDAR_NAMES_KEY,
    queryFn: () => mailApi.calendar.calendarNames(),
    staleTime: 5 * 60_000
  })
  return { data: q.data, isLoading: q.isLoading }
}

export function useCalendarSyncTrigger(): {
  trigger: (opts?: SyncNowOpts) => void
  isPending: boolean
} {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: (opts?: SyncNowOpts) => mailApi.calendar.syncTrigger(opts ?? {}),
    onSuccess: () => {
      toastSuccess(t('calendar.syncTriggered', '已触发日历同步'))
      void qc.invalidateQueries({ queryKey: CALENDAR_EVENTS_KEY })
      void qc.invalidateQueries({ queryKey: CALENDAR_SYNC_STATUS_KEY })
    },
    onError: (err: unknown) => {
      const e = err as Error
      toastError(
        t('calendar.syncTriggerFail', '日历同步失败'),
        e.message
      )
    }
  })
  // mut.mutate 在 react-query v5 是 referentially stable, useCallback 包后 trigger
  // 引用也稳定, 让 CalendarLayout 等消费者能放心当 useCallback / useEffect 的 dep.
  const trigger = useCallback((opts?: SyncNowOpts) => mut.mutate(opts), [mut.mutate])
  return { trigger, isPending: mut.isPending }
}

// ============================================================
// 工具函数 — 时间窗口计算
// ============================================================

/** UTC 今天 00:00. */
export function todayStartUtc(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** 本地时区的今天 00:00 (转 UTC). 用于 day/week 视图按本地"今天"算窗口. */
export function todayStartLocal(): Date {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 计算给定日期所在本地周的周一 00:00. ISO 周 (周一开始). */
export function startOfWeek(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  // JS getDay: 0=Sun..6=Sat. ISO 周一 = 1; Sun (0) 当 7.
  const day = d.getDay() || 7
  if (day !== 1) d.setDate(d.getDate() - (day - 1))
  return d
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1)
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/** 把本地 Date 转 ISO 字符串 (with TZ offset, rrule lib 友好). */
export function toIsoWithOffset(d: Date): string {
  return d.toISOString()
}

/** 把过去某时间格式化成 "刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前" 中文字符串.
 *  toolbar sync-pill 与 cal-card 副 status bar 共用, 保证语义一致. */
export function relativeTime(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (secs < 5) return '刚刚'
  if (secs < 60) return `${secs} 秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`
  return `${Math.floor(secs / 86400)} 天前`
}

/** 每 tickMs 强制 re-render — 让依赖 relativeTime() 的"X 秒前"字符串自然走时,
 *  即便 useCalendarSyncStatus 数据没变, UI 上的时间差也会更新.
 *  默认 30s 一次, 跟"30 秒/60 秒"档位对齐. */
export function useNowTick(tickMs = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(id)
  }, [tickMs])
  return now
}

/** 工具: 按本地日期 group occurrences (key=YYYY-MM-DD). */
export function groupOccurrencesByLocalDay(
  occs: CalendarEventOccurrence[]
): Map<string, CalendarEventOccurrence[]> {
  const m = new Map<string, CalendarEventOccurrence[]>()
  for (const occ of occs) {
    const d = new Date(occ.occurrence_start_iso)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = m.get(key) ?? []
    arr.push(occ)
    m.set(key, arr)
  }
  return m
}

// ============================================================
// 单日并发布局 — mockup §layoutDay 翻译.
// 把重叠事件分 cluster, 每 cluster 内贪心分列, 返回每个 occ 的 col / totalCols.
// Week / Day timeline 共用.
// ============================================================
export interface LaidOutEvent {
  occ: CalendarEventOccurrence
  col: number
  totalCols: number
}

export function layoutDay(events: CalendarEventOccurrence[]): LaidOutEvent[] {
  const sorted = [...events].sort((a, b) => {
    const aS = Date.parse(a.occurrence_start_iso)
    const bS = Date.parse(b.occurrence_start_iso)
    if (aS !== bS) return aS - bS
    return Date.parse(a.occurrence_end_iso) - Date.parse(b.occurrence_end_iso)
  })

  // 聚类: 任何与当前 cluster 还有重叠的 evt 都进同 cluster.
  const clusters: CalendarEventOccurrence[][] = []
  let cur: CalendarEventOccurrence[] = []
  let curEnd = -Infinity
  for (const e of sorted) {
    const start = Date.parse(e.occurrence_start_iso)
    if (cur.length && start >= curEnd) {
      clusters.push(cur)
      cur = []
      curEnd = -Infinity
    }
    cur.push(e)
    curEnd = Math.max(curEnd, Date.parse(e.occurrence_end_iso))
  }
  if (cur.length) clusters.push(cur)

  const result: LaidOutEvent[] = []
  for (const cl of clusters) {
    const colsEnd: number[] = [] // 每列当前 endMs
    const colsAssigned: number[] = []
    for (const e of cl) {
      const start = Date.parse(e.occurrence_start_iso)
      const end = Date.parse(e.occurrence_end_iso)
      let placed = -1
      for (let i = 0; i < colsEnd.length; i++) {
        if (colsEnd[i] <= start) {
          colsEnd[i] = end
          placed = i
          break
        }
      }
      if (placed === -1) {
        colsEnd.push(end)
        placed = colsEnd.length - 1
      }
      colsAssigned.push(placed)
    }
    const totalCols = colsEnd.length
    cl.forEach((e, idx) => {
      result.push({ occ: e, col: colsAssigned[idx], totalCols })
    })
  }
  return result
}

export type { CalendarEventOccurrence, CalendarEventDetail, CalendarEventSource }
