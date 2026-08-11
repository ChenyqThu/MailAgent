import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'

import { createMattersApi, createMatterChatApi } from '@shared/api/matters'
import type { MatterChatApi } from '@shared/api/matters'
import type { ReportAgentConfig } from '@shared/api/types'
import type { MattersApi } from '@shared/api/types/matter'
import type { MatterMutationOptions, MatterRunListResponse, MatterRunStartResult, MatterUpdateListResponse, MatterUpdateReviewStatus } from '@shared/api/types/matter'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

export function useMattersApi(): MattersApi {
  return useMemo(() => createMattersApi(resolveApiBaseUrl()), [])
}

/** P3 — the Matter Chat surface's own serve-api face (context snapshot / scope audit / undo).
 *  Separate from `useMattersApi` for the same reason the factories are separate (api/matters.ts). */
export function useMatterChatApi(): MatterChatApi {
  return useMemo(() => createMatterChatApi(resolveApiBaseUrl()), [])
}

export function useMatterFlags(): { mattersEnabled: boolean; matterAgentEnabled: boolean } {
  const query = useQuery({
    queryKey: qk.matters.config(),
    queryFn: async (): Promise<{ mattersEnabled: boolean; matterAgentEnabled: boolean }> => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return { mattersEnabled: false, matterAgentEnabled: false }
        const body = (await response.json()) as { data?: { mattersEnabled?: unknown; matterAgentEnabled?: unknown } }
        return { mattersEnabled: body.data?.mattersEnabled === true, matterAgentEnabled: body.data?.matterAgentEnabled === true }
      } catch {
        return { mattersEnabled: false, matterAgentEnabled: false }
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return query.data ?? { mattersEnabled: false, matterAgentEnabled: false }
}

export function useMattersEnabled(): boolean { return useMatterFlags().mattersEnabled }

const runKey = (matterId: string) => [...qk.matters.detail(matterId), 'runs'] as const
const updateKey = (matterId: string) => [...qk.matters.detail(matterId), 'updates'] as const

export function useMatterRuns(matterId: string, enabled = true): UseQueryResult<MatterRunListResponse> {
  const api = useMattersApi()
  return useQuery({ queryKey: runKey(matterId), queryFn: () => api.listRuns(matterId), enabled, refetchInterval: (query) => query.state.data?.items.some((run) => run.lifecycle_state === 'queued' || run.lifecycle_state === 'running') ? 2000 : false })
}

export function useMatterUpdates(matterId: string, reviewStatus: MatterUpdateReviewStatus = 'pending', enabled = true): UseQueryResult<MatterUpdateListResponse> {
  const api = useMattersApi()
  return useQuery({ queryKey: [...updateKey(matterId), reviewStatus], queryFn: () => api.listUpdates(matterId, reviewStatus), enabled })
}

export function useStartMatterRun(matterId: string): UseMutationResult<MatterRunStartResult, Error, MatterMutationOptions> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMutation({ mutationFn: (options: MatterMutationOptions) => api.startRun(matterId, options), onSuccess: () => client.invalidateQueries({ queryKey: runKey(matterId) }) })
}

export function useMatterAgentProfiles(enabled = true): UseQueryResult<ReportAgentConfig[]> {
  const mailApi = useMailApi()
  return useQuery({
    queryKey: [...qk.matters.config(), 'agent-profiles'],
    queryFn: async () => (await mailApi.report.getConfig()).filter((profile) => profile.type === 'custom'),
    enabled
  })
}
