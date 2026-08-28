// task 08-27 P3 —— 三源聚合 hook (GET /api/calendar/agenda)。
//
// 消费面: 月视图 / 日视图 / 周视图 (P5 起日/周与月同构) + 二级栏日历源树的成员
// 聚合; AgendaView 与 recurring 仍走旧 useCalendarEventsInWindow, 不动。
//
// 组级开关 (sources) 与成员级排除集 (excluded) 都走 client-side select:
// queryKey 不含它们, 切勾选不重发请求, 各视图与二级栏日历源树共享同一窗口缓存
// (源树刻意不传这两个参 —— 它要列的是全部成员, 被排除的那条也得留在树上才能
// 再勾回来)。tz 进 queryKey (后端按 Olson 名展开 matter/agent 的"天", 换时区
// 语义不同)。

import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'

import type { AgendaEntry, AgendaSource } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import type { CalendarMemberExclusions } from '@shared/state/calendar-view'

import { filterAgendaByMembers } from '../lib/calendar-filter'
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
  enabled = true,
  /** 成员级排除集 (二级栏日历源树 / 「按日历筛选」下拉的同一份状态)。 */
  excluded?: CalendarMemberExclusions
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
    select: (data: AgendaEntry[]) =>
      filterAgendaByMembers(filterAgendaBySources(data, sources), excluded),
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
