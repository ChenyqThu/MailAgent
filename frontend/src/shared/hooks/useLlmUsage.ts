// Phase 4 WP-4E — Cross-DB LLM Usage, Prompt Cache Hit Rate, & Probe Diagnostics hook.

import { useQuery } from '@tanstack/react-query'

import { request } from '@shared/api/http_client'
import { qk } from '@shared/lib/queryKeys'

import { resolveApiBaseUrl } from './useLlmModels'

export type LlmUsageRange = '24h' | '7d' | '30d'

export interface LlmUsageSummary {
  totalCalls: number
  totalInputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokenCacheHitRatePct: number
  estimatedCostUsd: number
  cacheSavedUsd: number
}

export interface LlmUsageBucket {
  bucket: string
  label: string
  calls: number
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokenCacheHitRatePct: number
  costUsd: number
  cacheSavedUsd: number
}

export interface LlmUsageSurfaceRow {
  surface: string
  calls: number
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokenCacheHitRatePct: number
  costUsd: number
  cacheSavedUsd: number
}

export interface LlmUsageModelRow {
  model: string
  providerId: string | null
  calls: number
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokenCacheHitRatePct: number
  costUsd: number
  cacheSavedUsd: number
}

export interface LlmProbeLogEntry {
  id: number
  providerId: string | null
  protocol: string | null
  model: string | null
  kind: string
  ok: boolean
  statusCode: number | null
  errorCode: string | null
  latencyMs: number | null
  message: string | null
  createdAt: number
}

export interface LlmUsageData {
  range: LlmUsageRange
  summary: LlmUsageSummary
  series: LlmUsageBucket[]
  bySurface: LlmUsageSurfaceRow[]
  byModel: LlmUsageModelRow[]
  probeLogs: LlmProbeLogEntry[]
}

export async function fetchLlmUsage(range: LlmUsageRange): Promise<LlmUsageData> {
  return request<LlmUsageData>(resolveApiBaseUrl(), 'GET', '/llm/providers/usage', {
    query: { range }
  })
}

export async function clearLlmProbeLogs(): Promise<{ cleared: number }> {
  return request<{ cleared: number }>(resolveApiBaseUrl(), 'DELETE', '/llm/providers/probelog')
}

export function useLlmUsage(
  range: LlmUsageRange,
  enabled = true
): {
  data: LlmUsageData | null
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  refetch: () => Promise<unknown>
} {
  const q = useQuery({
    queryKey: qk.llm.usage(range),
    queryFn: (): Promise<LlmUsageData> => fetchLlmUsage(range),
    enabled,
    staleTime: 15_000,
    retry: false
  })
  return {
    data: q.data && typeof q.data.summary === 'object' ? q.data : null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    isError: q.isError,
    refetch: (): Promise<unknown> => q.refetch()
  }
}
