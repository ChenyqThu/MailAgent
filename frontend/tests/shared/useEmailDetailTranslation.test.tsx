// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockGetCached, mockTranslateBatch, mockDeleteCached, mockAbortTranslate } = vi.hoisted(
  () => ({
    mockGetCached: vi.fn(),
    mockTranslateBatch: vi.fn(),
    mockDeleteCached: vi.fn(),
    mockAbortTranslate: vi.fn()
  })
)

const mockMailApi = {
  ai: {
    getCached: mockGetCached,
    translateBatch: mockTranslateBatch,
    deleteCached: mockDeleteCached,
    abortTranslate: mockAbortTranslate
  }
}

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => mockMailApi
}))

vi.mock('@shared/hooks/useShortcut', () => ({
  useShortcut: vi.fn()
}))

import { useEmailDetailTranslation } from '../../src/shared/components/email/detail/useEmailDetailTranslation'
import type { TranslateBatchResult, TranslationSegment } from '../../src/shared/api/types'

const SEGMENTS: TranslationSegment[] = [
  { src: 'Hello world.', tgt: '你好，世界。' },
  { src: 'Second line.', tgt: '第二行。' }
]

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCached.mockResolvedValue(null)
  mockDeleteCached.mockResolvedValue(true)
})

afterEach(cleanup)

describe('useEmailDetailTranslation', () => {
  test('keeps ephemeral segments visible and surfaces E_CACHE_WRITE_FAILED on persistence failure', async () => {
    const ephemeralResult: TranslateBatchResult = {
      internalId: 101,
      targetLang: 'zh',
      segments: SEGMENTS,
      source: 'on_demand',
      model: 'test-model',
      fetchedAt: null,
      latencyMs: 12,
      failedBatches: 0,
      totalBatches: 1,
      cacheWriteFailed: true
    }
    mockTranslateBatch.mockResolvedValueOnce(ephemeralResult)

    const { result, rerender } = renderHook(
      ({ internalId }: { internalId: number | null }) =>
        useEmailDetailTranslation({ internalId, langIsEn: true }),
      {
        initialProps: { internalId: 101 as number | null },
        wrapper: createWrapper()
      }
    )

    await waitFor(() => expect(mockGetCached).toHaveBeenCalledWith(101, 'zh'))

    act(() => {
      result.current.startTranslate()
    })

    await waitFor(() => expect(result.current.activeSegments).toEqual(SEGMENTS))
    expect(result.current.translateError?.code).toBe('E_CACHE_WRITE_FAILED')
    expect(result.current.hasCache).toBe(false)
    expect(result.current.translateStatus).toBe('error')

    act(() => {
      result.current.dismissTranslateError()
    })

    expect(result.current.translateError).toBeNull()
    expect(result.current.translateStatus).toBe('translated')
    expect(result.current.activeSegments).toEqual(SEGMENTS)

    rerender({ internalId: 202 })

    await waitFor(() => expect(result.current.activeSegments).toBeNull())
    expect(result.current.translateError).toBeNull()
    expect(result.current.translateStatus).toBe('idle')
  })
})
