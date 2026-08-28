// task 08-27 P3 —— 三源聚合 hook (GET /api/calendar/agenda)。
//
// 消费面**只有**月视图与小月历色点; Day/Week/Agenda 视图仍走旧
// useCalendarEventsInWindow, 一律不动。
//
// 三源开关走 client-side select (对齐 selectedCalendars 惯例): queryKey 不含
// sources, 切开关不重发请求, 月视图与小月历共享同一窗口缓存。tz 进 queryKey
// (后端按 Olson 名展开 matter/agent 的"天", 换时区语义不同)。

import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'

import type { AgendaEntry, AgendaSource } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

import { filterAgendaBySources } from '../lib/monthGrid'

/** 本机 Olson 时区名 (module-level 求值一次; 会话内换系统时区不追)。 */
export function localOlsonTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 60s ± 15s jitter — 同 useCalendarEventsInWindow 的 thundering-herd 处理。 */
function useJitteredInterval(baseMs: number, jitterMs: number): number {
  const [v] = useState(() => baseMs + Math.floor(Math.random() * 2 * jitterMs) - jitterMs)
  return v
}

export function useCalendarAgenda(
  opts: { fromIso: string; toIso: string },
  sources?: Readonly<Record<AgendaSource, boolean>>,
  enabled = true
): {
  data: AgendaEntry[] | undefined
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  refetch: () => void
} {
  const mailApi = useMailApi()
  const tz = localOlsonTz()
  const refetchIntervalMs = useJitteredInterval(60_000, 15_000)
  const q = useQuery({
    enabled,
    queryKey: [...qk.calendar.agenda(), opts.fromIso, opts.toIso, tz],
    queryFn: () => mailApi.calendar.agenda({ fromIso: opts.fromIso, toIso: opts.toIso, tz }),
    staleTime: 60_000,
    select: (data: AgendaEntry[]) => filterAgendaBySources(data, sources),
    // 切月时旧窗口留屏直到新数据 ready (与 events hook 同语义)。
    placeholderData: keepPreviousData,
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true
  })
  return {
    data: q.data,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    isError: q.isError,
    refetch: () => void q.refetch()
  }
}
