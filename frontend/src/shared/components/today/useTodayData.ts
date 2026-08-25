// 例外面的取数层（L4 批次 2 设计 §4.1）。
//
// 三条**既有**读端点，复用**既有 query key 族** —— 例外面因此零新增 SSE 分支：
//   · `qk.agentRuns.list(null, 100)`（`GET /api/agent-runs`）：`agent.run.changed` 已失效
//     整个 `qk.agentRuns.all()` 前缀。
//   · `qk.matters.pendingUpdates()`（`GET /api/matters/updates?review_status=pending`）：
//     `matter.changed` → `refreshMatter()` 的清单里显式列了它（它跨事项，没有前缀能覆盖）。
//   · `globalAttentionKey()`（`GET /api/matters/attention?state=open`）：`matter.attention` /
//     `matter.notify` 两支都定向失效它。
// 三条都走既有 hook / 既有 key，改任何一条的实时性都在原处改，不在这里第二次写判据。
//
// 🔴 `state` 由后端 `derive_agent_run_state` 派生，前端恒不自行推导 —— 这一层只把三份响应
// 铺成统一行模型（`todayGroups`），不解读 outcome / approvalState。

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useReportConfig } from '@shared/components/agents/hooks'
import {
  useGlobalAttention,
  useMattersEnabled,
  usePendingMatterUpdates
} from '@shared/components/matters/hooks'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

import { buildTodayItems, groupTodayItems, type TodayGroup } from './todayGroups'

/** 一屏拉多少条 run。100 = 后端 `list_agent_runs` 的 limit 上限；「最近结果」组另有 24h 窗
 *  与 20 条封顶，所以再多拉也不会显示更多。 */
const TODAY_RUN_LIMIT = 100

/** ISO → 「M/D HH:MM」。认不出的 ISO 返空串（调用方按缺席处理，不渲染 Invalid Date）。 */
function formatFiredAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export interface TodayData {
  groups: TodayGroup[]
  /** 三条源里还有没落地的（首屏骨架判据）。 */
  isPending: boolean
  /** run 那条读失败已由 HttpApi 降级成空列表；这里报的是事项两条的失败。 */
  isError: boolean
  /** 全屏统一的「此刻」基准（相对时间 + 24h 窗共用一份）。 */
  nowMs: number
  /** 决策 / triage 之后把 run 那条拉回来（事项两条各自的 mutation 已带失效）。 */
  refreshRuns(): void
}

export function useTodayData(): TodayData {
  const { t } = useTranslation()
  const api = useMailApi()
  const queryClient = useQueryClient()
  const mattersEnabled = useMattersEnabled()

  const runs = useQuery({
    queryKey: qk.agentRuns.list(null, TODAY_RUN_LIMIT),
    queryFn: () => api.report.listRuns({ limit: TODAY_RUN_LIMIT }),
    // 实时性靠 `agent.run.changed` SSE 失效（useEventBridge），短 staleTime 只是断线兜底。
    staleTime: 4_000
  })
  const proposals = usePendingMatterUpdates(mattersEnabled)
  const signals = useGlobalAttention(mattersEnabled)
  // agent 显示名：run 投影里只有 agentId（`agentTitle` 是单条端点才有的）。这是既有共享
  // 缓存（Agents 区已在用），不是第四条新查询。
  const { agents } = useReportConfig()

  const agentTitles = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.title])),
    [agents]
  )

  // 「此刻」基准：优先取本次数据的落地时刻（React Query 的纯值，随每次 refetch 前进），
  // 首帧无数据时回落页面打开的时刻。🔴 不在 render 里直读 `Date.now()`（react-hooks/purity），
  // 逐处各读一次也会让分组窗与相对时间用两个不同的 now。
  const [openedAt] = useState(() => Date.now())
  const nowMs = runs.dataUpdatedAt || openedAt

  const groups = useMemo(
    () =>
      groupTodayItems(
        buildTodayItems(
          {
            runs: runs.data?.items ?? [],
            proposals: proposals.data?.items ?? [],
            signals: signals.data?.items ?? []
          },
          { t, agentTitles, formatDateTime: formatFiredAt }
        ),
        nowMs
      ),
    [runs.data, proposals.data, signals.data, agentTitles, nowMs, t]
  )

  return {
    groups,
    isPending: runs.isPending || (mattersEnabled && (proposals.isPending || signals.isPending)),
    isError: mattersEnabled && (proposals.isError || signals.isError),
    nowMs,
    refreshRuns: () => {
      void queryClient.invalidateQueries({ queryKey: qk.agentRuns.all() })
    }
  }
}
