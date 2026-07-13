// Phase 3 §3.2 — Calendar SSoT 视图共用 hooks.
//
// useCalendarEventsInWindow: 拉时间窗口内 occurrences (RRULE 已展开). 默认
// staleTime 60s (calendar 数据 worker 60s 轮询, 用户切视图不必重 fetch).
//
// useCalendarSyncStatus: 拉 sync_state 表 (footer "上次同步 N 秒前" 提示).
// useCalendarNames: 拉 distinct calendar_name list (顶部 calendar 切换 chip).

import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient, useMutation, keepPreviousData } from '@tanstack/react-query'
import i18n from 'i18next'
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
import { qk } from '@shared/lib/queryKeys'
import { filterOccurrencesByCalendars } from '../lib/calendar-filter'

// Re-export from the queryKeys factory (single literal source, P2-8).
export const CALENDAR_EVENTS_KEY = qk.calendar.events()
export const CALENDAR_SYNC_STATUS_KEY = qk.calendar.syncStatus()
export const CALENDAR_NAMES_KEY = qk.calendar.names()

/** F6 — random jitter ±jitterMs around baseMs, 每 hook 实例 mount 时算一次
 *  (useState init lambda 让 jitter 在生命周期内固定). 多个 caller (Layout
 *  windowEvents + 当前 view eventsInWindow) 各拿到不同的 effective interval,
 *  60s tick 不再对齐边沿, 关掉 thundering herd (3-4 IPC + rrule 展开同时跑).
 */
function useJitteredInterval(baseMs: number, jitterMs: number): number {
  const [v] = useState(() => baseMs + Math.floor(Math.random() * 2 * jitterMs) - jitterMs)
  return v
}

export function useCalendarEventsInWindow(
  opts: EventsListOpts,
  selectedCalendars?: string[]
): {
  data: CalendarEventOccurrence[] | undefined
  isLoading: boolean
  isError: boolean
  refetch: () => void
} {
  const mailApi = useMailApi()
  // F6 — 60s ± 15s jitter (effective 45-75s) 避免 thundering herd
  const refetchIntervalMs = useJitteredInterval(60_000, 15_000)
  const q = useQuery({
    queryKey: [
      ...CALENDAR_EVENTS_KEY,
      opts.fromIso,
      opts.toIso,
      opts.calendarName,
      opts.source,
      opts.expandRecurrences
    ],
    queryFn: () => mailApi.calendar.eventsList(opts),
    staleTime: 60_000,
    // Phase 4·#1 — calendar 多选走 client-side select: queryKey 不含
    // selectedCalendars, 切筛选不重 fetch, 共享同一窗口缓存, react-query 只
    // 重跑 select 过滤. 个人日历数据量小, 一次拉全 + 前端过滤最简.
    select: (data: CalendarEventOccurrence[]) =>
      filterOccurrencesByCalendars(data, selectedCalendars),
    // 渐进式加载 — 切日/周/月 (queryKey 含 fromIso/toIso) 时旧 occurrences 原地
    // 留屏直到新窗口数据 ready, 消除"清空旧数据→空白→新数据"的闪白. isLoading
    // 仅首次 (无缓存可借) 为 true, 切窗口走 isFetching, view 据此只在首次显骨架.
    placeholderData: keepPreviousData,
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: false, // tab 后台不刷, 省功
    refetchOnWindowFocus: true // 回到 tab 立即 refresh
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
    queryKey: qk.calendar.eventDetail(opts?.icalUid, opts?.recurrenceId, opts?.source),
    queryFn: () => mailApi.calendar.eventGet(opts!),
    enabled: !!opts && !!opts.icalUid,
    staleTime: 60_000,
    // 切换选中事件 (queryKey 含 icalUid/recurrenceId) 时旧详情留屏直到新详情
    // ready, 配合 drawer 骨架: isLoading 仅首次为 true, 后续切换走 isFetching.
    placeholderData: keepPreviousData
  })
  return { data: q.data, isLoading: q.isLoading }
}

export function useCalendarSyncStatus(): {
  data: CalendarSyncStateItem[] | undefined
  isLoading: boolean
  refetch: () => void
} {
  const mailApi = useMailApi()
  // F6 — 60s ± 10s jitter (effective 50-70s) 跟 windowEvents 错峰
  const refetchIntervalMs = useJitteredInterval(60_000, 10_000)
  const q = useQuery({
    queryKey: CALENDAR_SYNC_STATUS_KEY,
    queryFn: () => mailApi.calendar.syncStatus(),
    staleTime: 30_000,
    refetchInterval: refetchIntervalMs
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
      toastError(t('calendar.syncTriggerFail', '日历同步失败'), e.message)
    }
  })
  // F6 (review #H1) — mut.mutate 在 react-query v5 是 referentially stable,
  // deps=[mut.mutate] 实际等价 deps=[]; useCallback 仍 wrap 为给 caller 提供
  // 稳定函数引用 (useEffect / useCallback dep 友好). 改空 deps + 注释明确语义.
  const stableMutate = mut.mutate
  const trigger = useCallback((opts?: SyncNowOpts) => stableMutate(opts), [stableMutate])
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

/** 把过去某时间格式化成 "刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前".
 *  toolbar sync-pill 与 cal-card 副 status bar 共用, 保证语义一致.
 *
 *  i18n: 纯 function 不能用 useTranslation hook, 走 i18next module-level
 *  singleton ``i18n.t(...)``. 第二参 fallback 防 key 漏不破.
 */
export function relativeTime(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (secs < 5) return i18n.t('calendar.relTime.justNow', '刚刚')
  if (secs < 60) return i18n.t('calendar.relTime.secondsAgo', '{n} 秒前', { n: secs })
  if (secs < 3600)
    return i18n.t('calendar.relTime.minutesAgo', '{n} 分钟前', {
      n: Math.floor(secs / 60)
    })
  if (secs < 86400)
    return i18n.t('calendar.relTime.hoursAgo', '{n} 小时前', {
      n: Math.floor(secs / 3600)
    })
  return i18n.t('calendar.relTime.daysAgo', '{n} 天前', {
    n: Math.floor(secs / 86400)
  })
}

/** 每 tickMs 强制 re-render — 让依赖 relativeTime() 的"X 秒前"字符串自然走时,
 *  即便 useCalendarSyncStatus 数据没变, UI 上的时间差也会更新.
 *  默认 30s 一次, 跟"30 秒/60 秒"档位对齐. */
export function useNowTick(tickMs = 30_000): number {
  // lazy init：把 Date.now() 移出 render body（react-hooks/purity 禁止 render 期间
  // 调 impure 函数）；interval 回调里的 setNow(Date.now()) 在事件回调非 render，合规。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(id)
  }, [tickMs])
  return now
}

/** F22/S6 — agenda 单日条目: 跨天事件按 overlap 展开后, 每天一条.
 *  dayIndex/totalDays 按事件**完整跨度**算 (1-based), 与查询窗口裁剪无关 —
 *  窗口只截到出差第 3 天时仍标「第 3/5 天」. totalDays===1 即单日事件. */
export interface AgendaDayEntry {
  occ: CalendarEventOccurrence
  /** 该 occurrence 在此日的序数 (1-based). */
  dayIndex: number
  /** 事件完整跨度覆盖的本地日数. */
  totalDays: number
  /** 该日内实际覆盖段起点 ms — 排序用 (首日=事件开始, 后续日=当日 00:00). */
  segStartMs: number
}

/** 防脏数据 (end 远超 start) 撑爆展开的安全上限. */
const MAX_EXPAND_DAYS = 60

/** F22/S6 — 按「与每个本地日 overlap」展开 occurrences (key=YYYY-MM-DD).
 *  跨天事件 (all-day 或跨午夜 timed) 在其覆盖的每一天各出一条 entry;
 *  结束恰在 00:00 边界的不占用结束日 (all-day 事件 end 惯例为次日 00:00).
 *  替代旧 groupOccurrencesByLocalDay (只按 start 单键分组 → 跨天事件第
 *  2..n 天在 agenda 缺席, F22). 展开可能产生查询窗口外的 key (事件起于
 *  窗口前/止于窗口后), caller 自行按窗口过滤. */
export function expandOccurrencesByLocalDayOverlap(
  occs: CalendarEventOccurrence[]
): Map<string, AgendaDayEntry[]> {
  const m = new Map<string, AgendaDayEntry[]>()
  for (const occ of occs) {
    const startMs = Date.parse(occ.occurrence_start_iso)
    const endMs = Date.parse(occ.occurrence_end_iso)
    const start = new Date(startMs)
    const firstDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    // endMs-1: 结束恰为 00:00 时归前一日; 零长/倒挂事件退化为单日.
    const lastRef = new Date(Math.max(endMs - 1, startMs))
    const lastDay = new Date(lastRef.getFullYear(), lastRef.getMonth(), lastRef.getDate())
    // 日历天差用 round 而非 floor — 跨 DST 的 23/25h 日差仍取整数天.
    const totalDays = Math.round((lastDay.getTime() - firstDay.getTime()) / 86_400_000) + 1
    const expandDays = Math.min(totalDays, MAX_EXPAND_DAYS)
    for (let i = 0; i < expandDays; i++) {
      // 本地日历算术 (setDate 溢出进位), 不做 ms 加法 — DST 安全.
      const day = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + i)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      const arr = m.get(key) ?? []
      arr.push({
        occ,
        dayIndex: i + 1,
        totalDays,
        segStartMs: i === 0 ? startMs : day.getTime()
      })
      m.set(key, arr)
    }
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
