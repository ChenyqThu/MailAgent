// 渐进式资料库搜索（Stage 1 毫秒级 FTS → Stage 2 可取消后台 hybrid 语义增强）。
//
// Stage 1 先发 `mode='fts'`：后端零 ONNX 推理立即返结果，并透过 `semantic.available` 告知
// 本地语义权重是否在盘；仅当 `semantic.available === true` 且 Stage 1 已落在当前 query 时，
// 再后台并发 `mode='hybrid'`。输入变化时 TanStack Query 自动取消 in-flight AbortSignal。
// 🔴 Stage 2 禁止用 keepPreviousData，避免上一词的 hybrid 结果覆盖当前词的新 FTS 结果。

import { keepPreviousData, useQuery } from '@tanstack/react-query'

import type { LibraryApi } from '@shared/api/library'
import type { LibrarySearchResponse } from '@shared/api/types/library'

export interface ProgressiveLibrarySearchOptions {
  api: Pick<LibraryApi, 'search'>
  query: string
  limit: number
  enabled?: boolean
  staleTime?: number
  queryKeyPrefix?: readonly unknown[]
}

export interface ProgressiveLibrarySearchResult {
  data: LibrarySearchResponse | undefined
  isPending: boolean
  isFetching: boolean
  isEnhancing: boolean
  isPlaceholderData: boolean
  isError: boolean
  error: unknown
}

export function useProgressiveLibrarySearch({
  api,
  query,
  limit,
  enabled = true,
  staleTime = 10_000,
  queryKeyPrefix = ['library', 'search']
}: ProgressiveLibrarySearchOptions): ProgressiveLibrarySearchResult {
  const trimmed = query.trim()
  const active = enabled && trimmed !== ''

  const stage1 = useQuery<LibrarySearchResponse>({
    queryKey: active ? [...queryKeyPrefix, trimmed, limit, 'fts'] : [...queryKeyPrefix, 'none', 'fts'],
    queryFn: ({ signal }) => api.search(trimmed, limit, 'fts', signal),
    enabled: active,
    placeholderData: keepPreviousData,
    staleTime
  })

  const stage2Enabled =
    active && !stage1.isPlaceholderData && stage1.data?.semantic?.available === true

  const stage2 = useQuery<LibrarySearchResponse>({
    queryKey: stage2Enabled
      ? [...queryKeyPrefix, trimmed, limit, 'hybrid']
      : [...queryKeyPrefix, 'none', 'hybrid'],
    queryFn: ({ signal }) => api.search(trimmed, limit, 'hybrid', signal),
    enabled: stage2Enabled,
    staleTime
  })

  const hasStage2 = stage2Enabled && stage2.data !== undefined

  return {
    data: hasStage2 ? stage2.data : stage1.data,
    isPending: stage1.isPending,
    isFetching: stage1.isFetching,
    isEnhancing: stage2Enabled && stage2.isFetching && stage2.data === undefined,
    isPlaceholderData: stage1.isPlaceholderData && !hasStage2,
    isError: stage1.isError,
    error: stage1.error
  }
}
