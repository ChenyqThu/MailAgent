// @vitest-environment happy-dom
//
// dynamic-models — useLlmModels hook contract.
//
// Tests:
//   1. useUpstreamModels returns FALLBACK_MODELS shape on empty upstream list
//   2. useUpstreamModels passes through upstream model list
//   3. useUpstreamModels exposes error string from upstream response
//   4. useUpstreamModels.refresh invalidates and re-fetches
//   5. useEnabledModels falls back to FALLBACK_MODELS when rawEnabled is empty
//   6. useEnabledModels passes through configured enabled list directly

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import {
  useUpstreamModels,
  useEnabledModels,
  FALLBACK_MODELS
} from '../../src/shared/hooks/useLlmModels'
import type { LlmUpstreamModelsData } from '../../src/shared/api/types'

// ── mock useMailApi ───────────────────────────────────────────────────────────

const mockListUpstreamModels =
  vi.fn<
    (opts?: {
      refresh?: boolean
      provider?: 'main' | 'translate'
    }) => Promise<LlmUpstreamModelsData>
  >()

vi.mock('../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    llm: {
      listUpstreamModels: mockListUpstreamModels
    }
  })
}))

// ── mock global fetch (used by fetchEnabledModels in useLlmModels) ────────────

const mockFetch = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', mockFetch)

// ── helpers ───────────────────────────────────────────────────────────────────

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return {
    qc,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
  }
}

function mockChatConfigResponse(enabledModels: string[]): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: { enabledModels } })
  } as unknown as Response)
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── useUpstreamModels ─────────────────────────────────────────────────────────

describe('useUpstreamModels', () => {
  test('returns empty models list when upstream returns empty', async () => {
    mockListUpstreamModels.mockResolvedValue({ models: [], cached: false, cached_at: null })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpstreamModels(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.models).toEqual([])
    expect(result.current.error).toBeUndefined()
  })

  test('passes through upstream model list', async () => {
    const upstream = ['claude-sonnet-4-6', 'claude-opus-4-8', 'gpt-5.5']
    mockListUpstreamModels.mockResolvedValue({
      models: upstream,
      cached: true,
      cached_at: Date.now()
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpstreamModels(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.models).toEqual(upstream)
  })

  test('exposes error field from upstream response', async () => {
    mockListUpstreamModels.mockResolvedValue({
      models: [],
      cached: false,
      cached_at: null,
      error: 'api_base_not_configured'
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpstreamModels(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('api_base_not_configured')
  })

  test('refresh calls listUpstreamModels with refresh:true and invalidates cache', async () => {
    mockListUpstreamModels.mockResolvedValue({
      models: ['model-a'],
      cached: false,
      cached_at: null
    })
    const { wrapper, qc } = makeWrapper()
    const { result } = renderHook(() => useUpstreamModels(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    mockListUpstreamModels.mockResolvedValue({
      models: ['model-a', 'model-b'],
      cached: false,
      cached_at: null
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(mockListUpstreamModels).toHaveBeenCalledWith({ refresh: true, provider: 'main' })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['llm', 'upstream-models', 'main'] })
  })
})

// ── useEnabledModels ──────────────────────────────────────────────────────────

describe('useEnabledModels', () => {
  test('falls back to FALLBACK_MODELS when enabledModels is empty', async () => {
    mockChatConfigResponse([])
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useEnabledModels(), { wrapper })

    await waitFor(() => expect(result.current.rawEnabled).toBeDefined())
    expect(result.current.rawEnabled).toEqual([])
    expect(result.current.models).toEqual(FALLBACK_MODELS)
  })

  test('passes through configured enabled list directly', async () => {
    const configured = ['claude-sonnet-4-6', 'gpt-5.5']
    mockChatConfigResponse(configured)
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useEnabledModels(), { wrapper })

    await waitFor(() => expect(result.current.rawEnabled.length).toBeGreaterThan(0))
    expect(result.current.rawEnabled).toEqual(configured)
    expect(result.current.models).toEqual(configured)
  })

  test('falls back to FALLBACK_MODELS when fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useEnabledModels(), { wrapper })

    await waitFor(() => expect(result.current.rawEnabled).toBeDefined())
    expect(result.current.models).toEqual(FALLBACK_MODELS)
  })
})
