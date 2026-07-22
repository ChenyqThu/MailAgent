// @vitest-environment happy-dom
//
// codex MEDIUM-2 (part 2) — a report agent's card shows its latest report via a per-agent query
// (report.list({ agentId, limit: 1 })), NOT by find()-ing the全部-list first page. Regression: a
// low-frequency agent whose newest report fell past the first 50 rows used to render "no report".
// This test proves the card reads the per-agent result even when the (mocked) global first page is
// empty. useMailApi is mocked so the real hooks (useReportConfig / useLatestReport / useRunNow /
// useSetConfig) run against it.
import { beforeAll, afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: false, scopeRef: { current: null } })
}))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

const REPORT_AGENT_ID = 'daily'
const LATEST = {
  id: 'rep-latest',
  agent_id: REPORT_AGENT_ID,
  cadence: 'daily',
  report_date: '2026-07-01',
  window_start: '2026-07-01T00:00:00Z',
  window_end: '2026-07-02T00:00:00Z',
  status: 'ready',
  counts: { total: 3 },
  headline: '低频日报最新一份',
  model: 'claude-sonnet-4-6',
  input_tokens: null,
  output_tokens: null,
  cost_usd: null,
  error: null,
  created_at: null,
  generated_at: null
}

// report.list: per-agent (agentId+limit:1) returns LATEST; the global first page is EMPTY (simulates
// the agent's report having fallen past page 1). The OLD find()-the-first-page code would show
// "no report"; the per-agent query surfaces LATEST.
const mockList = vi.fn(
  async (opts?: { agentId?: string; limit?: number }): Promise<unknown> =>
    opts?.agentId === REPORT_AGENT_ID ? { items: [LATEST], total: 1 } : { items: [], total: 60 }
)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      list: mockList,
      get: vi.fn().mockResolvedValue(null),
      getConfig: vi.fn().mockResolvedValue([
        {
          id: REPORT_AGENT_ID,
          type: 'report',
          enabled: true,
          title: '每日摘要',
          schedule: { cadence: 'daily', hours: [9] },
          window_hours: 24,
          prompt: 'x',
          prompt_is_default: true,
          model: 'claude-sonnet-4-6',
          tools_json: [],
          kos_enrich: false,
          trigger_mode: 'rolling_24h',
          timezone: '',
          body_full_priorities: [],
          updated_at: null
        }
      ]),
      setConfig: vi.fn(),
      runNow: vi.fn(),
      delete: vi.fn(),
      pendingCount: vi.fn().mockResolvedValue({ total: 0, byAgent: {} })
    },
    chat: { kosAvailable: vi.fn().mockResolvedValue(false) }
  })
}))

import i18n from '@shared/i18n'
import { AgentsTab } from '../../src/shared/components/agents/AgentsTab'

await i18n.changeLanguage('zh-CN')

function renderUi(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
  })
}

afterEach(() => cleanup())

describe('AgentCard — latest report via per-agent query (codex MEDIUM-2)', () => {
  test('shows the agent latest report even when the global first page is empty', async () => {
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    await waitFor(() => expect(screen.getByText('低频日报最新一份')).toBeTruthy())
    // it queried per-agent (agentId + limit:1), not the unfiltered list.
    expect(
      mockList.mock.calls.some(([opts]) => opts?.agentId === REPORT_AGENT_ID && opts?.limit === 1)
    ).toBe(true)
  })
})
