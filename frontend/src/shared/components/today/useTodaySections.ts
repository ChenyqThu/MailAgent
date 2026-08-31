// 今日页五节的取数层（task 08-27 P4c）。
//
// 五节的源**有意分散**（design §十「一次算出来」的显式偏离，理由在
// `src/today/aggregate.py` 的模块 docstring）：
//
//   decide / due —— `useTodayData()`（批次 2/3 的四条源，SSE 定向失效已挂好）
//   meet         —— `useCalendarAgenda()` 收窄到当天窗口（既有 hook / 既有 key）
//   reply        —— `GET /api/today`（唯一新端点：没有能按 ai_action 过滤的读面，
//                    且「已回」判定要跨线程全历史）
//   out          —— 上面那四条源的终态 run + `GET /api/reports` 当天生成的那几份
//                    （🔴 `agent_run_log` 行**不在**里面：`useTodayData` 用 `isJobRunItem`
//                     把它们滤掉了，那是执行台账 lane 的取向。要不要让今日页也认那一档
//                     是独立一题，本批不顺手扩。）
//
// 🔴 **二级栏与主区读同一份 `sections`**：计数写在 `TodaySectionView.count` 上，两处
// 都从这个 hook 拿。各算一遍必然漂开（一处算了过滤、一处没算）。
//
// reply 的实时性：`events.ts` 里没有「某封邮件的 ai_action 变了」这样一条事件，最接近的
// 是 `llm.success`（分类落库）与 `email.new` / `email.synced`（新信到达 / 状态回填）——
// 这一节的进出正是由这三件事驱动的，所以在 `useEventBridge` 挂了一条定向失效。断线时
// 另有 90s staleTime + 窗口聚焦 refetch 兜底。

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  localOlsonTz,
  useCalendarAgenda
} from '@shared/components/calendar/hooks/useCalendarAgenda'
import { useMailApi } from '@shared/hooks/useMailApi'
import { ageLabel } from '@shared/lib/ageLabel'
import { qk } from '@shared/lib/queryKeys'
import type { AgendaEntry, TodayData as TodayApiData } from '@shared/api/types'
import type { TodaySectionId } from '@shared/state/today-section'

import {
  buildMeetItems,
  buildReplyItems,
  buildReportItems,
  buildTodaySections,
  type TodaySectionBuildContext,
  type TodaySectionView
} from './todaySections'
import { useTodayData } from './useTodayData'

/** 报告一屏拉多少份。当天生成的报告个位数就到头了；再多也只是白拉。 */
const TODAY_REPORT_LIMIT = 20

/** 只有 mail 源进「今天的会」——事项截止归 due 节、agent 排程归 out 节，
 *  同一件事不该在两节各出现一次。 */
const MEET_SOURCES = { mail: true, matter: false, agent: false } as const

const EMPTY_TODAY: TodayApiData = { reply: [], nextHardPoint: null }

/** 本地日界（`[今天 00:00, 明天 00:00)`）。 */
export function localDayWindow(nowMs: number): { startMs: number; endMs: number } {
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

export interface TodaySectionsData {
  sections: TodaySectionView[]
  byId: Record<TodaySectionId, TodaySectionView>
  /** 今天剩下的最早一条日程。🔴 「硬」没有字段 —— 后端用「最早一条」近似（见端点注释）。 */
  nextHardPoint: AgendaEntry | null
  /** 「在那之前有几件必须拍板」= decide 节里**等你处理**那一组的条数。
   *  与 decide 节的计数同源（那一组就是 `waiting`），不另起一个口径。 */
  pendingDecisions: number
  isPending: boolean
  isError: boolean
  nowMs: number
  refreshRuns(): void
}

export function useTodaySections(): TodaySectionsData {
  const { t } = useTranslation()
  const api = useMailApi()
  const base = useTodayData()
  const nowMs = base.nowMs
  const tz = localOlsonTz()

  // 日界随 nowMs 走（`useTodayData` 的统一基准）—— 逐处各读一次 Date.now() 会让
  // 窗口与相对时间用两个不同的 now。
  const window = useMemo(() => localDayWindow(nowMs), [nowMs])
  const fromIso = useMemo(() => new Date(window.startMs).toISOString(), [window.startMs])
  const toIso = useMemo(() => new Date(window.endMs).toISOString(), [window.endMs])

  const agenda = useCalendarAgenda({ fromIso, toIso }, MEET_SOURCES)

  const today = useQuery({
    queryKey: qk.today.aggregate(tz),
    queryFn: () => api.today.get({ tz }),
    // 实时性靠 useEventBridge 的 `llm.success` / `email.*` 定向失效；这里是断线兜底。
    staleTime: 90_000,
    refetchOnWindowFocus: true
  })

  const reports = useQuery({
    queryKey: qk.report.list(),
    queryFn: () => api.report.list({ limit: TODAY_REPORT_LIMIT }),
    staleTime: 60_000
  })

  const ctx: TodaySectionBuildContext = useMemo(
    () => ({
      t,
      formatTime: (ms: number) =>
        new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      formatAge: (ms: number) => ageLabel(t, ms)
    }),
    [t]
  )

  const data = today.data ?? EMPTY_TODAY

  const sections = useMemo(
    () =>
      buildTodaySections(
        {
          groups: base.groups,
          meet: buildMeetItems(agenda.data ?? [], nowMs, ctx),
          reply: buildReplyItems(data.reply),
          reports: buildReportItems(reports.data?.items ?? [], window, ctx)
        },
        nowMs,
        ctx
      ),
    [base.groups, agenda.data, data.reply, reports.data, window, nowMs, ctx]
  )

  const byId = useMemo(
    () =>
      Object.fromEntries(sections.map((s) => [s.id, s])) as Record<
        TodaySectionId,
        TodaySectionView
      >,
    [sections]
  )

  const pendingDecisions = useMemo(
    () => byId.decide.groups.find((g) => g.id === 'waiting')?.items.length ?? 0,
    [byId]
  )

  return {
    sections,
    byId,
    nextHardPoint: data.nextHardPoint,
    pendingDecisions,
    // 日历 / 报告 / 今日端点都是**补充**：它们还在路上时先把已有的四节铺出来，
    // 不整页转圈（首屏骨架仍由批次 2 的四条源决定）。
    isPending: base.isPending,
    isError: base.isError,
    nowMs,
    refreshRuns: base.refreshRuns
  }
}
