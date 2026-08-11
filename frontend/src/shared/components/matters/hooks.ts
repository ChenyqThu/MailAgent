import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'

import { createMattersApi, createMatterChatApi } from '@shared/api/matters'
import type { MatterChatApi } from '@shared/api/matters'
import type { ReportAgentConfig } from '@shared/api/types'
import type {
  MatterAttentionListResponse,
  MatterAttentionSignal,
  MattersApi,
  MatterMutationOptions,
  MatterNotifyLevel,
  MatterNotifyLevelResponse,
  MatterRunListResponse,
  MatterRunStartResult,
  MatterUpdateListResponse,
  MatterUpdateReviewStatus
} from '@shared/api/types/matter'
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
        const body = (await response.json()) as {
          data?: { mattersEnabled?: unknown; matterAgentEnabled?: unknown }
        }
        return {
          mattersEnabled: body.data?.mattersEnabled === true,
          matterAgentEnabled: body.data?.matterAgentEnabled === true
        }
      } catch {
        return { mattersEnabled: false, matterAgentEnabled: false }
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return query.data ?? { mattersEnabled: false, matterAgentEnabled: false }
}

export function useMattersEnabled(): boolean {
  return useMatterFlags().mattersEnabled
}

const runKey = (matterId: string) => [...qk.matters.detail(matterId), 'runs'] as const
const updateKey = (matterId: string) => [...qk.matters.detail(matterId), 'updates'] as const
export const globalAttentionKey = () => [...qk.matters.all(), 'attention', 'open'] as const
export const matterAttentionKey = (matterId: string) =>
  [...qk.matters.detail(matterId), 'attention', 'open'] as const
export const notifyLevelKey = () => [...qk.matters.config(), 'notify-level'] as const

/** 匹配任意 matter 的 detail attention 缓存（matterId 未知时按形状判）。`matter.attention`
 *  SSE 到达时要失效**所有**已打开事项的信号缓存，而事件不带 matterId —— 判定放在 key 工厂
 *  旁边，别让消费方（useEventBridge）手抄 `['matters','detail',id,'attention',…]` 的下标。 */
export function isMatterAttentionDetailKey(key: readonly unknown[]): boolean {
  const probe = matterAttentionKey('*')
  return (
    key.length >= probe.length && key[0] === probe[0] && key[1] === probe[1] && key[3] === probe[3]
  )
}

export function useMatterRuns(
  matterId: string,
  enabled = true
): UseQueryResult<MatterRunListResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: runKey(matterId),
    queryFn: () => api.listRuns(matterId),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (run) => run.lifecycle_state === 'queued' || run.lifecycle_state === 'running'
      )
        ? 2000
        : false
  })
}

export function useMatterUpdates(
  matterId: string,
  reviewStatus: MatterUpdateReviewStatus = 'pending',
  enabled = true
): UseQueryResult<MatterUpdateListResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: [...updateKey(matterId), reviewStatus],
    queryFn: () => api.listUpdates(matterId, reviewStatus),
    enabled
  })
}

export function useGlobalAttention(enabled = true): UseQueryResult<MatterAttentionListResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: globalAttentionKey(),
    queryFn: () => api.listAttention('open'),
    enabled,
    staleTime: 15_000
  })
}

export function useMatterAttention(
  matterId: string,
  enabled = true
): UseQueryResult<MatterAttentionListResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: matterAttentionKey(matterId),
    queryFn: () => api.listMatterAttention(matterId, 'open'),
    enabled,
    staleTime: 15_000
  })
}

export type AttentionAction = 'resolved' | 'snoozed' | 'dismissed'
export interface AttentionActionInput {
  matterId: string
  signalId: number
  action: AttentionAction
}

function removeSignal(
  data: MatterAttentionListResponse | undefined,
  signalId: number
): MatterAttentionListResponse | undefined {
  return data ? { ...data, items: data.items.filter((signal) => signal.id !== signalId) } : data
}

export function useAttentionAction(): UseMutationResult<
  MatterAttentionSignal,
  Error,
  AttentionActionInput,
  { global?: MatterAttentionListResponse; detail?: MatterAttentionListResponse }
> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ matterId, signalId, action }) =>
      action === 'resolved'
        ? api.resolveAttention(matterId, signalId)
        : action === 'snoozed'
          ? api.snoozeAttention(matterId, signalId, { preset: '3d' })
          : api.dismissAttention(matterId, signalId),
    onMutate: async ({ matterId, signalId }) => {
      await Promise.all([
        client.cancelQueries({ queryKey: globalAttentionKey() }),
        client.cancelQueries({ queryKey: matterAttentionKey(matterId) })
      ])
      const global = client.getQueryData<MatterAttentionListResponse>(globalAttentionKey())
      const detail = client.getQueryData<MatterAttentionListResponse>(matterAttentionKey(matterId))
      client.setQueryData(globalAttentionKey(), removeSignal(global, signalId))
      client.setQueryData(matterAttentionKey(matterId), removeSignal(detail, signalId))
      return { global, detail }
    },
    onError: (_error, variables, context) => {
      if (context?.global) client.setQueryData(globalAttentionKey(), context.global)
      if (context?.detail)
        client.setQueryData(matterAttentionKey(variables.matterId), context.detail)
    },
    onSettled: (_data, _error, variables) =>
      Promise.all([
        client.invalidateQueries({ queryKey: globalAttentionKey() }),
        client.invalidateQueries({ queryKey: matterAttentionKey(variables.matterId) })
      ]).then(() => undefined)
  })
}

export function useNotifyLevel(enabled = true): UseQueryResult<MatterNotifyLevelResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: notifyLevelKey(),
    queryFn: () => api.getNotifyLevel(),
    enabled,
    staleTime: 30_000
  })
}

export function useSetNotifyLevel(): UseMutationResult<
  MatterNotifyLevelResponse,
  Error,
  MatterNotifyLevel
> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (level) => api.setNotifyLevel(level),
    onSuccess: (data) => client.setQueryData(notifyLevelKey(), data)
  })
}

export function useStartMatterRun(
  matterId: string
): UseMutationResult<MatterRunStartResult, Error, MatterMutationOptions> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (options: MatterMutationOptions) => api.startRun(matterId, options),
    onSuccess: () => client.invalidateQueries({ queryKey: runKey(matterId) })
  })
}

export function useMatterAgentProfiles(enabled = true): UseQueryResult<ReportAgentConfig[]> {
  const mailApi = useMailApi()
  return useQuery({
    queryKey: [...qk.matters.config(), 'agent-profiles'],
    queryFn: async () =>
      (await mailApi.report.getConfig()).filter((profile) => profile.type === 'custom'),
    enabled
  })
}
