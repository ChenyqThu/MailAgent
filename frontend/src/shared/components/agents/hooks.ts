// Sprint 20 — /agents 数据层：TanStack Query 包装 report:* IPC + 响应式 useNarrow。
import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import { qk } from '@shared/lib/queryKeys'
import { isSessionUnread } from '@shared/lib/chatUnread'
import { useEventsStatusStore } from '@shared/state/eventsStatus'
import type {
  AgentRunHistoryItem,
  AgentRunPendingCount,
  AgentRunToolOptions,
  ChatOpennessFlags,
  ConnectorSummary,
  ProjectProgressRunItem,
  ReportAgentConfig,
  ReportAgentCreateInput,
  ReportCadence,
  ReportConfigPatch,
  ReportDetail,
  ReportListItem,
  ReportRunResult
} from '@shared/api/types'

const EMPTY_PENDING_COUNT: AgentRunPendingCount = { total: 0, byAgent: {} }
const EMPTY_UNREAD_COUNT = { total: 0, byAgent: {} as Record<string, number> }

const LIST_KEY = qk.report.list()
const CONFIG_KEY = qk.report.config()
// codex MEDIUM-2 — prefix of every per-agent latest-report query (['report','latest',agentId]);
// the paginated LIST_KEY (['report','list']) does NOT cover it, so run-now / delete bust it too.
const LATEST_KEY = ['report', 'latest'] as const

// task 07-21 — 报告中心列表分页大小（滚动预取，见 ReportsPage）。
const REPORT_PAGE_SIZE = 50

export function useReportList(cadence?: ReportCadence): {
  items: ReportListItem[]
  /** 同 cadence filter 下的总数（后端 meta.total），列表头展示 + hasMore 判断用。 */
  total: number
  isLoading: boolean
  /** 还有更多页可拉（items.length < total）。 */
  hasMore: boolean
  /** 正在拉下一页（滚动预取节流用，避免同一 tick 重复触发）。 */
  isFetchingMore: boolean
  /** 拉下一页（offset = 已加载条数）。hasMore=false / 拉取中时调用是 no-op。 */
  fetchMore: () => void
} {
  const api = useMailApi()
  const q = useInfiniteQuery({
    queryKey: qk.report.listCadence(cadence ?? 'all'),
    queryFn: ({ pageParam }) =>
      api.report.list({ cadence, limit: REPORT_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    refetchOnWindowFocus: true
  })
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  const total = q.data?.pages[q.data.pages.length - 1]?.total ?? 0
  return {
    items,
    total,
    isLoading: q.isLoading,
    hasMore: q.hasNextPage ?? false,
    isFetchingMore: q.isFetchingNextPage,
    fetchMore: () => void q.fetchNextPage()
  }
}

/** codex MEDIUM-2 — the single most-recent report for ONE agent, via the list endpoint's agentId
 *  filter + limit:1 (report_date DESC). Reliable regardless of the paginated全部-list first page:
 *  a low-frequency report agent whose latest report fell past the first 50 rows used to render
 *  "no report" on its card. Cheap (report agents number in the single digits) + React Query cached;
 *  invalidated on run-now / delete via the LATEST_KEY prefix (see useRunNow / useDeleteReport). */
export function useLatestReport(agentId: string): ReportListItem | null {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.report.latest(agentId),
    queryFn: async () => {
      const { items } = await api.report.list({ agentId, limit: 1 })
      return items[0] ?? null
    }
  })
  return q.data ?? null
}

export function useReport(reportId: string | null): {
  report: ReportDetail | null
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.report.get(reportId),
    queryFn: () => (reportId ? api.report.get(reportId) : Promise.resolve(null)),
    enabled: !!reportId
  })
  return { report: q.data ?? null, isLoading: q.isLoading }
}

export function useReportConfig(): { agents: ReportAgentConfig[]; isLoading: boolean } {
  const api = useMailApi()
  const q = useQuery({ queryKey: CONFIG_KEY, queryFn: () => api.report.getConfig() })
  return { agents: q.data ?? [], isLoading: q.isLoading }
}

export function useRunNow(): {
  run: (
    agentId: string,
    opts?: { cadence?: ReportCadence; type?: string }
  ) => Promise<ReportRunResult>
  isRunning: boolean
} {
  const api = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: ({
      agentId,
      cadence,
      type
    }: {
      agentId: string
      cadence?: ReportCadence
      type?: string
    }) => api.report.runNow(agentId, { cadence, type }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY })
      void qc.invalidateQueries({ queryKey: LATEST_KEY })
      // S5：custom agent run-now enqueue 后刷新 run 历史（前缀匹配 ['agent-runs', ...]）。
      void qc.invalidateQueries({ queryKey: qk.agentRuns.all() })
    }
  })
  return {
    run: (agentId, opts) => mut.mutateAsync({ agentId, cadence: opts?.cadence, type: opts?.type }),
    isRunning: mut.isPending
  }
}

export function useDeleteReport(): {
  remove: (reportId: string) => Promise<void>
  isDeleting: boolean
} {
  const api = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: (reportId: string) => api.report.delete(reportId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY })
      void qc.invalidateQueries({ queryKey: LATEST_KEY })
    }
  })
  return { remove: (id) => mut.mutateAsync(id), isDeleting: mut.isPending }
}

/** F4b — 新建一行 agent（search agent 用，type='search'）。成功后 invalidate
 *  getConfig 查询，让 AgentsTab 列表 + 命令面板 runSearchAgent 取到新行。 */
export function useCreateAgent(): {
  create: (input: ReportAgentCreateInput) => Promise<ReportAgentConfig>
  isCreating: boolean
} {
  const api = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: (input: ReportAgentCreateInput) => api.report.createAgent(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONFIG_KEY })
    }
  })
  return { create: (input) => mut.mutateAsync(input), isCreating: mut.isPending }
}

/** F4b — 删除一行 agent（search agent 用）。成功后 invalidate getConfig 查询。 */
export function useDeleteAgent(): {
  remove: (agentId: string) => Promise<{ deleted: string }>
  isDeleting: boolean
} {
  const api = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: (agentId: string) => api.report.deleteAgent(agentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONFIG_KEY })
    }
  })
  return { remove: (id) => mut.mutateAsync(id), isDeleting: mut.isPending }
}

export function useSetConfig(): {
  save: (agentId: string, patch: ReportConfigPatch) => Promise<ReportAgentConfig>
  isSaving: boolean
} {
  const api = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: ({ agentId, patch }: { agentId: string; patch: ReportConfigPatch }) =>
      api.report.setConfig(agentId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONFIG_KEY })
    }
  })
  return {
    save: (agentId, patch) => mut.mutateAsync({ agentId, patch }),
    isSaving: mut.isPending
  }
}

/** KOS（Gbrain）是否已配好（KOS_MCP_BASE + OAuth creds）→ 决定是否展示「Gbrain
 *  知识库增强」配置项。未配好返回 false（隐藏该项）。复用 chat:kosAvailable IPC，
 *  Query 缓存去重（与 MessageList 的保存按钮同一信号）。 */
export function useKosAvailable(): boolean {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.chat.kosAvailable(),
    queryFn: () => api.chat.kosAvailable(),
    staleTime: Infinity
  })
  return q.data ?? false
}

/** S5 — /chat/config.customAgentsEnabled（MAILAGENT_CUSTOM_AGENTS_ENABLED，默认 ON）。
 *  镜像 fetchSkillInstallEnabled 先例：未配 / 不可达 → false（隐藏 custom 入口，字节级同现状）。 */
async function fetchCustomAgentsEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { customAgentsEnabled?: unknown } }
    return body?.data?.customAgentsEnabled === true
  } catch {
    return false
  }
}

/** R3 (task 07-05) — /chat/config 开放性 flag 分面。与 fetchCustomAgentsEnabled 的
 *  false-on-failure 不同：这里区分 false（字段明确 off → 控件禁用 + 提示）与 undefined
 *  （旧后端无字段 / 不可达 → 按现状渲染不禁用），故失败/缺字段一律回 undefined。 */
async function fetchOpennessFlags(): Promise<ChatOpennessFlags> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return {}
    const body = (await resp.json()) as { data?: Record<string, unknown> }
    const pick = (key: string): boolean | undefined =>
      typeof body?.data?.[key] === 'boolean' ? (body.data[key] as boolean) : undefined
    return {
      sessionToolsEnabled: pick('sessionToolsEnabled'),
      configToolsEnabled: pick('configToolsEnabled'),
      webToolsEnabled: pick('webToolsEnabled'),
      execToolsEnabled: pick('execPolicyEnabled'),
      connectorToolsEnabled: pick('connectorToolsEnabled')
    }
  } catch {
    return {}
  }
}

export function useOpennessFlags(enabled: boolean): ChatOpennessFlags {
  const q = useQuery({
    queryKey: qk.chat.config('opennessFlags'),
    queryFn: fetchOpennessFlags,
    enabled,
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? {}
}

export function useCustomAgentsEnabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('customAgentsEnabled'),
    queryFn: fetchCustomAgentsEnabled,
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? false
}

/** /chat/config.customAgentCallEnabled（MAILAGENT_CUSTOM_AGENT_CALL，默认 ON）。
 *  renderer 只用它隐藏 @Agent 入口；gateway 是否注册工具仍由 electron main 的同名 flag 决定。 */
export function useCustomAgentCallEnabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('customAgentCallEnabled'),
    queryFn: async () => {
      try {
        const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
        if (!resp.ok) return false
        const body = (await resp.json()) as { data?: { customAgentCallEnabled?: unknown } }
        return body?.data?.customAgentCallEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? false
}

/** P1 — /chat/config.sessionProvenanceEnabled（MAILAGENT_SESSION_PROVENANCE，默认 ON）。
 *  该 flag 仍由 Electron main 决定 gateway 行为；renderer 只消费 serve-api 对同一 .env 的
 *  main-env-only 热读投影，避免绕过 env:get 白名单直接读取 snapshot。缺字段/不可达时隐藏未读 UI。 */
export function useSessionProvenanceEnabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('sessionProvenanceEnabled'),
    queryFn: async () => {
      try {
        const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
        if (!resp.ok) return false
        const body = (await resp.json()) as { data?: { sessionProvenanceEnabled?: unknown } }
        return body?.data?.sessionProvenanceEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? false
}

export function useTriggerV2Enabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('triggerV2Enabled'),
    queryFn: async () => {
      try {
        const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
        if (!resp.ok) return false
        const body = (await resp.json()) as { data?: { triggerV2Enabled?: unknown } }
        return body?.data?.triggerV2Enabled === true
      } catch {
        return false
      }
    },
    staleTime: 15_000
  })
  return q.data === true
}

export function useCalendarTriggerEnabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('calendarTriggerEnabled'),
    queryFn: async () => {
      try {
        const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
        if (!resp.ok) return false
        const body = (await resp.json()) as { data?: { calendarTriggerEnabled?: unknown } }
        return body?.data?.calendarTriggerEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 15_000
  })
  return q.data === true
}

export function useAgentPluginsEnabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('agentPluginsEnabled'),
    queryFn: async () => {
      try {
        const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
        if (!resp.ok) return false
        const body = (await resp.json()) as { data?: { agentPluginsEnabled?: unknown } }
        return body?.data?.agentPluginsEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 15_000
  })
  return q.data === true
}

/** S6 W2（P5 红点链）— 全局 + per-agent 待审批（paused_pending）计数，5s 轮询。
 *  enabled=false（flag off / customAgentsEnabled=false）→ 不发请求、不轮询、恒返 {total:0,byAgent:{}}
 *  → 所有红点面字节级不渲染。读失败（flag off / 不可达）→ 服务端已守读优雅降级返 EMPTY。 */
export function useAgentPendingCount(enabled: boolean): AgentRunPendingCount {
  const api = useMailApi()
  // perf-sse-realtime R1-5: `agent.run.changed` SSE (useEventBridge 失效
  // qk.agentRuns.all() 前缀) 承担实时性, connected 时轮询降为 30s 兜底; 无桥保持 5s。
  const sseConnected = useEventsStatusStore((s) => s.status.state === 'connected')
  const q = useQuery({
    queryKey: qk.agentRuns.pendingCount(),
    queryFn: () => api.report.pendingCount(),
    enabled,
    staleTime: 4_000,
    refetchInterval: enabled ? (sseConnected ? 30_000 : 5_000) : false
  })
  return q.data ?? EMPTY_PENDING_COUNT
}

export function useAgentUnreadCount(enabled: boolean): {
  total: number
  byAgent: Record<string, number>
} {
  const api = useMailApi()
  // 同 useAgentPendingCount: agent.run.changed 事件失效 qk.chat.agentUnread(),
  // connected 时 30s 兜底。
  const sseConnected = useEventsStatusStore((s) => s.status.state === 'connected')
  const q = useQuery({
    queryKey: qk.chat.agentUnread(),
    queryFn: async () => {
      const sessions = await api.chat.listAllSessions({ includeArchived: false, origin: 'agent' })
      const byAgent: Record<string, number> = {}
      let total = 0
      for (const session of sessions) {
        if (!isSessionUnread(session) || !session.agent_id) continue
        total += 1
        byAgent[session.agent_id] = (byAgent[session.agent_id] ?? 0) + 1
      }
      return { total, byAgent }
    },
    enabled,
    staleTime: 4_000,
    refetchInterval: enabled ? (sseConnected ? 30_000 : 5_000) : false
  })
  return q.data ?? EMPTY_UNREAD_COUNT
}

/** S6 W2（P5 红点链 ④）— 全局待审批（paused_pending）run 列表，供 TitleBar 徽标 popover 直达记录。
 *  仅 enabled（popover 打开 + flag on）时发请求；读失败 / flag off → []（守读优雅降级）。
 *  红点弹层只看最近 50 条待审批，不需要分页 —— 只取 items，不消费 total。 */
export function usePendingRuns(enabled: boolean): {
  runs: AgentRunHistoryItem[]
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.agentRuns.pausedPending(),
    queryFn: () => api.report.listRuns({ state: 'paused_pending', limit: 50 }),
    enabled,
    staleTime: 4_000
  })
  return { runs: q.data?.items ?? [], isLoading: q.isLoading }
}

/** S5 — 某 custom agent 的 run 历史（listRuns，读失败返 []）。state 由后端 derive_agent_run_state
 *  单源投影，前端只穷举渲染不推导。agentId=null → 不发请求。
 *  task 07-21 — `limit` 现作分页大小（每页条数），支持 loadMore（RunHistorySection 的
 *  「加载更多」按钮）；AgentRecordView / AgentsTab 只用 runs（首页/首屏够用），不受影响。 */
export function useAgentRuns(
  agentId: string | null,
  limit = 20
): {
  runs: AgentRunHistoryItem[]
  isLoading: boolean
  refetch: () => void
  total: number
  hasMore: boolean
  isLoadingMore: boolean
  loadMore: () => void
} {
  const api = useMailApi()
  const q = useInfiniteQuery({
    queryKey: qk.agentRuns.list(agentId, limit),
    queryFn: ({ pageParam }) =>
      api.report.listRuns({ agentId: agentId ?? undefined, limit, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    enabled: agentId != null
  })
  const runs = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  const total = q.data?.pages[q.data.pages.length - 1]?.total ?? 0
  return {
    runs,
    isLoading: q.isLoading,
    refetch: () => void q.refetch(),
    total,
    hasMore: q.hasNextPage ?? false,
    isLoadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage()
  }
}

/** R5 (task 07-05) — 项目周报同步执行历史（projectProgressRuns，读失败返 []）。
 *  自有 status 词表（processing/completed/failed/skipped，非 custom agent 的 9 值域）。
 *  enabled=false（抽屉未开）→ 不发请求。抽屉每次打开时 refetchOnMount 取最新。 */
export function useProjectProgressRuns(
  enabled: boolean,
  limit = 20
): { runs: ProjectProgressRunItem[]; isLoading: boolean } {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.projectProgressRuns(limit),
    queryFn: () => api.report.projectProgressRuns(limit),
    enabled,
    staleTime: 4_000
  })
  return { runs: q.data ?? [], isLoading: q.isLoading }
}

// 稳定空清单单例：q.data 未就绪时恒返同一引用，避免消费方 useEffect 依赖 options.defaults
// 时因新数组引用每渲染都触发（→ 无限 setState 循环）。
const EMPTY_TOOL_OPTIONS: AgentRunToolOptions = { tools: [], defaults: [] }

/** S5 — custom agent allowed_tools 可选清单（后端权威投影，前端不硬编码工具名）。
 *  enabled=false（flag off / 抽屉未开）→ 不发请求；失败返 EMPTY_TOOL_OPTIONS。 */
export function useToolOptions(enabled: boolean): {
  options: AgentRunToolOptions
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.agentRuns.toolOptions(),
    queryFn: () => api.report.toolOptions(),
    enabled,
    staleTime: 60_000
  })
  return { options: q.data ?? EMPTY_TOOL_OPTIONS, isLoading: q.isLoading }
}

// PR4 T3 — connector 行集合的稳定空单例（镜像 EMPTY_TOOL_OPTIONS 的引用稳定纪律）。
const EMPTY_CONNECTORS: ConnectorSummary[] = []

/** MCP connector PR4 T3 — 第七「外部服务」能力卡的行数据源（GET /api/connector 全集）。
 *  enabled=false（抽屉未开）→ 不发请求；失败降级空数组（卡内只剩存量 grant 行 / 空态），
 *  🔴 但**不触碰 grant state** —— 行不可见时已配授权仍以抽屉 state 为准物化，绝不静默丢。 */
export function useConnectorOptions(enabled: boolean): ConnectorSummary[] {
  const api = useMailApi()
  const q = useQuery({
    queryKey: qk.connectors(),
    queryFn: () => api.connector.list(),
    enabled,
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? EMPTY_CONNECTORS
}

/** 窄屏（< 780px）→ 报告/会话用单栏 + 返回栈（移植自设计稿 useNarrow）。 */
export function useNarrow(breakpoint = 780): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const on = (): void => setNarrow(window.innerWidth < breakpoint)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [breakpoint])
  return narrow
}
