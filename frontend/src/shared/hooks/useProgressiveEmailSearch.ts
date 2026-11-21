// Progressive email search: Stage 1 immediate FTS -> Stage 2 background hybrid RRF when local
// semantic index is ready and populated (mirrors useProgressiveLibrarySearch without changing
// existing qk.palette.search Stage 1 cache keys or empty footer probe).

import { keepPreviousData, useQuery } from '@tanstack/react-query'

import type { MailApi, SearchResult } from '@shared/api/types'
import { qk } from '@shared/lib/queryKeys'

export interface ProgressiveEmailSearchOptions {
  readonly mailApi: Pick<MailApi, 'email'>
  readonly query: string
  readonly limit: number
  readonly enabled?: boolean
  readonly allowEmpty?: boolean
  readonly staleTime?: number
  readonly onMeasuredLatency?: (latencyMs: number) => void
}

export interface ProgressiveEmailSearchResult {
  readonly data: SearchResult | undefined
  readonly isPending: boolean
  readonly isFetching: boolean
  readonly isEnhancing: boolean
  readonly isPlaceholderData: boolean
  readonly isSuccess: boolean
  readonly refetch: () => Promise<unknown>
}

export function useProgressiveEmailSearch({
  mailApi,
  query,
  limit,
  enabled = true,
  allowEmpty = false,
  staleTime = 30_000,
  onMeasuredLatency
}: ProgressiveEmailSearchOptions): ProgressiveEmailSearchResult {
  const isEmpty = query.length === 0
  const stage1Enabled = enabled && (allowEmpty || !isEmpty)

  const stage1 = useQuery<SearchResult>({
    queryKey: qk.palette.search(query),
    queryFn: async () => {
      const t0 = performance.now()
      const r = await mailApi.email.search({
        query: isEmpty ? '' : query,
        limit: isEmpty ? 0 : limit
      })
      if (!isEmpty && onMeasuredLatency) {
        onMeasuredLatency(Math.round(performance.now() - t0))
      }
      return r
    },
    staleTime,
    placeholderData: keepPreviousData,
    enabled: stage1Enabled
  })

  const stage2Enabled =
    stage1Enabled &&
    !isEmpty &&
    !stage1.isPlaceholderData &&
    stage1.data?.semantic?.available === true &&
    stage1.data.semantic.indexed_emails > 0

  const stage2 = useQuery<SearchResult>({
    queryKey: stage2Enabled
      ? [...qk.palette.search(query), 'hybrid', limit]
      : [...qk.palette.search(''), 'hybrid-idle'],
    queryFn: () => mailApi.email.search({ query, limit, searchMode: 'hybrid' }),
    staleTime,
    enabled: stage2Enabled
  })

  const hasStage2 = stage2Enabled && stage2.data !== undefined

  return {
    data: hasStage2 ? stage2.data : stage1.data,
    isPending: stage1.isPending,
    isFetching: stage1.isFetching,
    isEnhancing: stage2Enabled && stage2.isFetching && stage2.data === undefined,
    isPlaceholderData: stage1.isPlaceholderData && !hasStage2,
    isSuccess: stage1.isSuccess,
    refetch: stage1.refetch
  }
}
