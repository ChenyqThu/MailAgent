// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { fetchUsageMock, clearLogsMock } = vi.hoisted(() => ({
  fetchUsageMock: vi.fn(),
  clearLogsMock: vi.fn()
}))

vi.mock('@shared/hooks/useLlmUsage', async () => {
  const actual = await vi.importActual<typeof import('@shared/hooks/useLlmUsage')>(
    '@shared/hooks/useLlmUsage'
  )
  return {
    ...actual,
    fetchLlmUsage: fetchUsageMock,
    clearLlmProbeLogs: clearLogsMock,
    useLlmUsage: (range: '24h' | '7d' | '30d', enabled = true) => {
      const data = fetchUsageMock(range) as
        | ReturnType<typeof makeFixture>
        | null
      return {
        data: enabled ? data : null,
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: async (): Promise<unknown> => fetchUsageMock(range)
      }
    }
  }
})

import i18n from '@shared/i18n'
import { UsageDashboardSection } from '@shared/components/settings/providers/UsageDashboardSection'
import type { LlmUsageData, LlmUsageRange } from '@shared/hooks/useLlmUsage'

await i18n.changeLanguage('zh-CN')

function makeFixture(range: LlmUsageRange): LlmUsageData {
  return {
    range,
    summary: {
      totalCalls: range === '24h' ? 2 : 7,
      totalInputTokens: 3200,
      uncachedInputTokens: 1350,
      outputTokens: 350,
      cacheReadTokens: 1750,
      cacheWriteTokens: 100,
      tokenCacheHitRatePct: 54.7,
      estimatedCostUsd: 0.0225,
      cacheSavedUsd: 0.0081
    },
    series: [
      {
        bucket: '2026-11-16',
        label: '11-16',
        calls: 3,
        inputTokens: 1600,
        uncachedInputTokens: 700,
        outputTokens: 150,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        tokenCacheHitRatePct: 50.0,
        costUsd: 0.011,
        cacheSavedUsd: 0.004
      },
      {
        bucket: '2026-11-17',
        label: '11-17',
        calls: 4,
        inputTokens: 1600,
        uncachedInputTokens: 650,
        outputTokens: 200,
        cacheReadTokens: 950,
        cacheWriteTokens: 0,
        tokenCacheHitRatePct: 59.4,
        costUsd: 0.0115,
        cacheSavedUsd: 0.0041
      }
    ],
    bySurface: [
      {
        surface: 'chat',
        calls: 4,
        inputTokens: 2000,
        uncachedInputTokens: 800,
        outputTokens: 200,
        cacheReadTokens: 1100,
        cacheWriteTokens: 100,
        tokenCacheHitRatePct: 55.0,
        costUsd: 0.015,
        cacheSavedUsd: 0.006
      },
      {
        surface: 'email_classify',
        calls: 3,
        inputTokens: 1200,
        uncachedInputTokens: 550,
        outputTokens: 150,
        cacheReadTokens: 650,
        cacheWriteTokens: 0,
        tokenCacheHitRatePct: 54.2,
        costUsd: 0.0075,
        cacheSavedUsd: 0.0021
      }
    ],
    byModel: [
      {
        model: 'claude-sonnet-4-6',
        providerId: 'default',
        calls: 7,
        inputTokens: 3200,
        uncachedInputTokens: 1350,
        outputTokens: 350,
        cacheReadTokens: 1750,
        cacheWriteTokens: 100,
        tokenCacheHitRatePct: 54.7,
        costUsd: 0.0225,
        cacheSavedUsd: 0.0081
      }
    ],
    probeLogs: [
      {
        id: 1,
        providerId: 'default',
        protocol: 'anthropic',
        model: 'claude-sonnet-4-6',
        kind: 'test',
        ok: true,
        statusCode: 200,
        errorCode: null,
        latencyMs: 42,
        message: null,
        createdAt: 1763350000000
      },
      {
        id: 2,
        providerId: 'relay-1',
        protocol: 'openai-compatible',
        model: 'gpt-4o',
        kind: 'runtime_error',
        ok: false,
        statusCode: 429,
        errorCode: 'E_QUOTA',
        latencyMs: 120,
        message: 'HTTP 429 rate limit reached',
        createdAt: 1763350100000
      }
    ]
  }
}

function renderDashboard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <UsageDashboardSection />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UsageDashboardSection', () => {
  test('renders 4 KPI cards, surface & model breakdowns, range toggle, error filter, and clear action', async () => {
    fetchUsageMock.mockImplementation((r: LlmUsageRange) => makeFixture(r))
    clearLogsMock.mockResolvedValue({ cleared: 2 })

    renderDashboard()

    expect(screen.getByText('54.7%')).toBeTruthy()
    expect(screen.getByText('3.5K')).toBeTruthy()
    expect(screen.getAllByText('$0.02').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('$0.0081')).toBeTruthy()

    // Breakdown rows
    expect(screen.getByText('对话问答')).toBeTruthy()
    expect(screen.getByText('邮件 AI 分类')).toBeTruthy()
    expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThanOrEqual(1)

    // Switch range 7d -> 24h
    fireEvent.click(screen.getByRole('button', { name: '24h' }))
    expect(fetchUsageMock).toHaveBeenCalledWith('24h')

    // Filter probelog to Errors only
    expect(screen.getByText('42ms')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '仅异常' }))
    expect(screen.queryByText('42ms')).toBeNull()
    expect(screen.getByText('HTTP 429 rate limit reached')).toBeTruthy()

    // Click Clear probelog button
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => expect(clearLogsMock).toHaveBeenCalledTimes(1))
  })

  test('renders full-width dashboard variant cleanly for Operations /admin/llm', () => {
    fetchUsageMock.mockImplementation((r: LlmUsageRange) => makeFixture(r))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <UsageDashboardSection variant="dashboard" />
      </QueryClientProvider>
    )

    expect(screen.getByRole('heading', { name: 'AI 用量与缓存监控' })).toBeTruthy()
    expect(screen.getByText('54.7%')).toBeTruthy()
    expect(screen.getByRole('button', { name: '24h' })).toBeTruthy()
  })
})
