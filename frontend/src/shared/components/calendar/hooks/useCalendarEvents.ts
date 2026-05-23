// Phase 3 §3.2 — Calendar SSoT 视图共用 hooks.
//
// useCalendarEventsInWindow: 拉时间窗口内 occurrences (RRULE 已展开). 默认
// staleTime 60s (calendar 数据 worker 60s 轮询, 用户切视图不必重 fetch).
//
// useCalendarSyncStatus: 拉 sync_state 表 (footer "上次同步 N 秒前" 提示).
// useCalendarNames: 拉 distinct calendar_name list (顶部 calendar 切换 chip).

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
    refetchOnWindowFocus: false
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
  return { trigger: (opts?: SyncNowOpts) => mut.mutate(opts), isPending: mut.isPending }
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

export type { CalendarEventOccurrence, CalendarEventDetail, CalendarEventSource }
