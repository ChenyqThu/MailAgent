// @vitest-environment happy-dom
//
// S5 W5a — 项目周报同步（type='project_progress'）专型行 Settings。覆盖：
//   • i18n zh/en agents.projectProgress key 对齐
//   • AgentsTab 第五 filter → project_progress 卡片渲染（仅当行存在）
//   • 总闸 off（env PROJECT_PROGRESS_SYNC_ENABLED 未开）→ 卡片显「总闸未开」态
//   • 总闸 on + 行 enabled → 「已启用」；总闸 on + 行 disabled → 「已停用」
//   • 无 project_progress 行 → section 不渲染（老库未迁移）
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: [],
  useEnabledModels: () => ({ models: [], rawEnabled: [] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() }),
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

const mockGetConfig = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      get: vi.fn().mockResolvedValue(null),
      getConfig: mockGetConfig,
      setConfig: vi.fn(),
      runNow: vi.fn(),
      delete: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
      listRuns: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      toolOptions: vi.fn().mockResolvedValue({ tools: [], defaults: [] })
    },
    chat: { kosAvailable: vi.fn().mockResolvedValue(false) }
  })
}))

import i18n from '@shared/i18n'
import { AgentsTab } from '../../src/shared/components/agents/AgentsTab'
import { useEnvStore } from '@shared/state/env'
import type { ReportAgentConfig } from '@shared/api/types'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

// custom flag 端点（AgentsTab mount 时 fetch /chat/config）—— 项目周报不依赖它，恒返 false。
function stubFlagFetch(): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { customAgentsEnabled: false } })
  }) as unknown as typeof fetch
}

function setEnvMaster(on: boolean): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: { PROJECT_PROGRESS_SYNC_ENABLED: on ? 'true' : 'false' },
        managedKeys: [],
        secretKeys: []
      }
    }
  })
}

function makePpCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'project_progress_sync',
    type: 'project_progress',
    enabled: true,
    title: '项目周报同步',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '',
    prompt_is_default: true,
    model: '',
    tools_json: null,
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    trigger: { v: 1, kind: 'email_filter', subject_pattern: '\\[weekly\\]', sender_pattern: '' },
    tool_policy: null,
    budget: null,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}
function renderUi(ui: React.ReactElement) {
  return render(ui, { wrapper: makeQcWrapper() })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('i18n — agents.projectProgress key 对齐', () => {
  test('zh / en 顶层 key 一致', () => {
    const zhKeys = Object.keys(zhCommon.agents.projectProgress).sort()
    const enKeys = Object.keys(enCommon.agents.projectProgress).sort()
    expect(zhKeys).toEqual(enKeys)
  })
})

describe('AgentsTab — 项目周报同步区', () => {
  test('行存在 + 总闸 on + 行 enabled → section + 卡片 + 「已启用」', async () => {
    stubFlagFetch()
    setEnvMaster(true)
    mockGetConfig.mockResolvedValue([makePpCfg({ enabled: true })])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    // section 标题 + 卡片 title 同名「项目周报同步」→ 两处（findAllByText 避 multiple-match 抛错）。
    expect((await screen.findAllByText('项目周报同步')).length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByText('已启用')).toBeTruthy()
    expect(screen.queryByText('总闸未开')).toBeNull()
  })

  test('总闸 off → 卡片显「总闸未开」（不显已启用/已停用）', async () => {
    stubFlagFetch()
    setEnvMaster(false)
    mockGetConfig.mockResolvedValue([makePpCfg({ enabled: true })])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    expect(await screen.findByText('总闸未开')).toBeTruthy()
    expect(screen.queryByText('已启用')).toBeNull()
  })

  test('总闸 on + 行 disabled → 「已停用」', async () => {
    stubFlagFetch()
    setEnvMaster(true)
    mockGetConfig.mockResolvedValue([makePpCfg({ enabled: false })])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    expect(await screen.findByText('已停用')).toBeTruthy()
  })

  test('无 project_progress 行 → section 不渲染（老库未迁移）', async () => {
    stubFlagFetch()
    setEnvMaster(true)
    mockGetConfig.mockResolvedValue([])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    // 等预处理区渲染出来（确保列表已加载），再断言项目周报 section header 不在场。
    await screen.findByText('AI 邮件预处理')
    expect(screen.queryByText('项目周报同步')).toBeNull()
  })
})
