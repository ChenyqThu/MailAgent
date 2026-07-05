// Sprint 20 — /agents 数据层：TanStack Query 包装 report:* IPC + 响应式 useNarrow。
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import type {
  AgentRunHistoryItem,
  AgentRunPendingCount,
  AgentRunToolOptions,
  ChatOpennessFlags,
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

const LIST_KEY = ['report', 'list'] as const
const CONFIG_KEY = ['report', 'config'] as const

export function useReportList(cadence?: ReportCadence): {
  items: ReportListItem[]
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: [...LIST_KEY, cadence ?? 'all'],
    queryFn: () => api.report.list(cadence ? { cadence } : undefined),
    refetchOnWindowFocus: true
  })
  return { items: q.data ?? [], isLoading: q.isLoading }
}

export function useReport(reportId: string | null): {
  report: ReportDetail | null
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: ['report', 'get', reportId],
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
      // S5：custom agent run-now enqueue 后刷新 run 历史（前缀匹配 ['agent-runs', ...]）。
      void qc.invalidateQueries({ queryKey: ['agent-runs'] })
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
    queryKey: ['chat', 'kosAvailable'],
    queryFn: () => api.chat.kosAvailable(),
    staleTime: Infinity
  })
  return q.data ?? false
}

/** S5 — /chat/config.customAgentsEnabled（MAILAGENT_CUSTOM_AGENTS_ENABLED，默认 OFF）。
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
      execToolsEnabled: pick('execPolicyEnabled')
    }
  } catch {
    return {}
  }
}

export function useOpennessFlags(enabled: boolean): ChatOpennessFlags {
  const q = useQuery({
    queryKey: ['chat', 'config', 'opennessFlags'],
    queryFn: fetchOpennessFlags,
    enabled,
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? {}
}

export function useCustomAgentsEnabled(): boolean {
  const q = useQuery({
    queryKey: ['chat', 'config', 'customAgentsEnabled'],
    queryFn: fetchCustomAgentsEnabled,
    staleTime: 30_000,
    retry: false
  })
  return q.data ?? false
}

/** S6 W2（P5 红点链）— 全局 + per-agent 待审批（paused_pending）计数，5s 轮询（SystemAlertBadge 先例）。
 *  enabled=false（flag off / customAgentsEnabled=false）→ 不发请求、不轮询、恒返 {total:0,byAgent:{}}
 *  → 所有红点面字节级不渲染。读失败（flag off / 不可达）→ 服务端已守读优雅降级返 EMPTY。 */
export function useAgentPendingCount(enabled: boolean): AgentRunPendingCount {
  const api = useMailApi()
  const q = useQuery({
    queryKey: ['agent-runs', 'pending-count'],
    queryFn: () => api.report.pendingCount(),
    enabled,
    staleTime: 4_000,
    refetchInterval: enabled ? 5_000 : false
  })
  return q.data ?? EMPTY_PENDING_COUNT
}

/** S6 W2（P5 红点链 ④）— 全局待审批（paused_pending）run 列表，供 TitleBar 徽标 popover 直达记录。
 *  仅 enabled（popover 打开 + flag on）时发请求；读失败 / flag off → []（守读优雅降级）。 */
export function usePendingRuns(enabled: boolean): {
  runs: AgentRunHistoryItem[]
  isLoading: boolean
} {
  const api = useMailApi()
  const q = useQuery({
    queryKey: ['agent-runs', 'list', 'paused_pending'],
    queryFn: () => api.report.listRuns({ state: 'paused_pending', limit: 50 }),
    enabled,
    staleTime: 4_000
  })
  return { runs: q.data ?? [], isLoading: q.isLoading }
}

/** S5 — 某 custom agent 的 run 历史（listRuns，读失败返 []）。state 由后端 derive_agent_run_state
 *  单源投影，前端只穷举渲染不推导。agentId=null → 不发请求。 */
export function useAgentRuns(
  agentId: string | null,
  limit = 20
): { runs: AgentRunHistoryItem[]; isLoading: boolean; refetch: () => void } {
  const api = useMailApi()
  const q = useQuery({
    queryKey: ['agent-runs', agentId ?? 'all', limit],
    queryFn: () => api.report.listRuns({ agentId: agentId ?? undefined, limit }),
    enabled: agentId != null
  })
  return { runs: q.data ?? [], isLoading: q.isLoading, refetch: () => void q.refetch() }
}

/** R5 (task 07-05) — 项目周报同步执行历史（projectProgressRuns，读失败返 []）。
 *  自有 status 词表（processing/completed/failed/skipped，非 custom agent 的 8 值域）。
 *  enabled=false（抽屉未开）→ 不发请求。抽屉每次打开时 refetchOnMount 取最新。 */
export function useProjectProgressRuns(
  enabled: boolean,
  limit = 20
): { runs: ProjectProgressRunItem[]; isLoading: boolean } {
  const api = useMailApi()
  const q = useQuery({
    queryKey: ['project-progress-runs', limit],
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
    queryKey: ['agent-runs', 'tool-options'],
    queryFn: () => api.report.toolOptions(),
    enabled,
    staleTime: 60_000
  })
  return { options: q.data ?? EMPTY_TOOL_OPTIONS, isLoading: q.isLoading }
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
