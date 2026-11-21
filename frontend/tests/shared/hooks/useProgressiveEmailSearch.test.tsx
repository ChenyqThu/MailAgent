// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import type { SearchResult } from '@shared/api/types'
import { useProgressiveEmailSearch } from '@shared/hooks/useProgressiveEmailSearch'

afterEach(() => {
  cleanup()
})

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('useProgressiveEmailSearch', () => {
  test('stays on Stage 1 FTS when semantic is unavailable', async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ internal_id: 1, subject: 'Budget', sender: 'finance@acme.com', rank: -1 }],
      total_indexed: 100,
      semantic: { available: false, model: null, indexed_emails: 0 }
    } satisfies Partial<SearchResult>)

    const { result } = renderHook(
      () =>
        useProgressiveEmailSearch({
          mailApi: { email: { search: searchMock } as never },
          query: 'budget',
          limit: 12
        }),
      { wrapper: wrapper() }
    )

    await waitFor(() => expect(result.current.data?.items.length).toBe(1))
    expect(searchMock).toHaveBeenCalledTimes(1)
    expect(searchMock).toHaveBeenCalledWith({ query: 'budget', limit: 12 })
  })

  test('fires Stage 2 hybrid only after Stage 1 reports semantic.available and indexed_emails > 0', async () => {
    const searchMock = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        total_indexed: 50,
        semantic: { available: true, model: 'embeddinggemma-300m-q4-mrl256', indexed_emails: 40 }
      })
      .mockResolvedValueOnce({
        items: [{ internal_id: 99, subject: 'Annual Health Benefit', lane: 'vec' }],
        total_indexed: 50,
        search_mode: 'hybrid'
      })

    const { result } = renderHook(
      () =>
        useProgressiveEmailSearch({
          mailApi: { email: { search: searchMock } as never },
          query: '医院检查',
          limit: 12
        }),
      { wrapper: wrapper() }
    )

    await waitFor(() => expect(result.current.data?.items[0]?.internal_id).toBe(99))
    expect(searchMock).toHaveBeenCalledTimes(2)
    expect(searchMock).toHaveBeenNthCalledWith(1, { query: '医院检查', limit: 12 })
    expect(searchMock).toHaveBeenNthCalledWith(2, {
      query: '医院检查',
      limit: 12,
      searchMode: 'hybrid'
    })
  })
})
