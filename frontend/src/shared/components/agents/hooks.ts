// Sprint 20 — /agents 数据层：TanStack Query 包装 report:* IPC + 响应式 useNarrow。
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import type {
  ReportAgentConfig,
  ReportCadence,
  ReportConfigPatch,
  ReportDetail,
  ReportListItem,
  ReportRunResult
} from '@shared/api/types'

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
  run: (agentId: string, opts?: { cadence?: ReportCadence }) => Promise<ReportRunResult>
  isRunning: boolean
} {
  const api = useMailApi()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: ({ agentId, cadence }: { agentId: string; cadence?: ReportCadence }) =>
      api.report.runNow(agentId, cadence ? { cadence } : undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY })
    }
  })
  return {
    run: (agentId, opts) => mut.mutateAsync({ agentId, cadence: opts?.cadence }),
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
