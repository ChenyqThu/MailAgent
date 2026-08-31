// @vitest-environment happy-dom
//
// task 08-27 P4a（lane team-shell）— 团队工作台（清单 + 两档视图 + 记录面壳）。
//
// 🔴 design §8.1 点名的恒绿陷阱，用例必须按它说的构造：
//   ① 「换成员恒回第一档」必须**先切到设置再换成员** —— tab 初值就是第一档，
//      只测「点 agent 后是第一档」是恒绿装饰；
//   ② 记录列穿插排序用例必须构造「会话时间落在执行之间」的数据（sessions 恰好在前时
//      去掉排序也看不出差别）——组件级再钉一次渲染顺序（纯函数级在 teamTimeline.test）。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// 团队页只消费 useNavigate 的返回（去对话 / 去报告按钮），不需要真路由树。
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))

// 设置档挂的是 agent-config lane 的真组件（CustomAgentSettings 等），它拉动态模型
// 清单 —— 与 CustomAgentTab.test 同款模块 mock。
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-opus-4-8', 'claude-fable-5'],
  useEnabledModels: () => ({
    models: ['claude-opus-4-8', 'claude-fable-5'],
    rawEnabled: ['claude-opus-4-8', 'claude-fable-5']
  }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() }),
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

const mockGetConfig = vi.fn()
const mockListRuns = vi.fn()
const mockReportList = vi.fn()
const mockProgressRuns = vi.fn()
const mockToolOptions = vi.fn()
const mockCreateAgent = vi.fn()
const mockSetConfig = vi.fn()
const mockRunNow = vi.fn()
const mockConnectorList = vi.fn()
const mockListAllSessions = vi.fn()
const mockListMessages = vi.fn()
const mockListSkills = vi.fn()
const mockListEnriched = vi.fn()
const mockAiFields = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      getConfig: mockGetConfig,
      listRuns: mockListRuns,
      list: mockReportList,
      projectProgressRuns: mockProgressRuns,
      toolOptions: mockToolOptions,
      createAgent: mockCreateAgent,
      setConfig: mockSetConfig,
      runNow: mockRunNow
    },
    connector: {
      list: mockConnectorList
    },
    chat: {
      listAllSessions: mockListAllSessions,
      listMessages: mockListMessages,
      listSkills: mockListSkills
    },
    email: {
      listEnriched: mockListEnriched,
      aiFields: mockAiFields
    }
  })
}))

import i18n from '@shared/i18n'
import type { ChatSessionListItem, ReportAgentConfig } from '@shared/api/types'
import { TeamWorkspace } from '../../src/shared/components/agents/team/TeamWorkspace'
import { useAgentsNavigation } from '../../src/shared/components/agents/navigation'

await i18n.changeLanguage('zh-CN')

function cfg(id: string, type: string, over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id,
    type,
    enabled: true,
    title: over.title ?? id,
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '',
    prompt_is_default: true,
    model: 'claude-opus-4-8',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    mark_read_after_processing: true,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

const AGENTS = [
  cfg('daily_email_digest', 'report', { title: '邮件日报' }),
  cfg('email_search_agent', 'search', { title: '搜索 Agent' }),
  cfg('email_preprocess_agent', 'preprocess', { title: 'AI 邮件预处理' }),
  cfg('project_progress_sync', 'project_progress', { title: '项目周报同步' }),
  cfg('dms_helper', 'custom', { title: '跟进员' })
]

function makeSession(over: Partial<ChatSessionListItem>): ChatSessionListItem {
  return {
    id: 100,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    origin: 'agent',
    agent_id: 'dms_helper',
    first_user_message: null,
    message_count: 1,
    email_subject: null,
    email_sender: null,
    ...over
  } as ChatSessionListItem
}

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

async function renderWorkspace(): Promise<HTMLElement> {
  const { container } = render(<TeamWorkspace />, { wrapper: makeQcWrapper() })
  await waitFor(() => {
    expect(container.querySelector('[data-team-member="member:agent:dms_helper"]')).toBeTruthy()
  })
  return container
}

function mockChatConfigFlags(customAgentsEnabled: boolean): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { customAgentsEnabled } })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.clearAllMocks()
  useAgentsNavigation.getState().clear()
  mockGetConfig.mockResolvedValue(AGENTS)
  mockListRuns.mockResolvedValue({ items: [], total: 0 })
  mockReportList.mockResolvedValue({ items: [], total: 0 })
  mockProgressRuns.mockResolvedValue([])
  mockToolOptions.mockResolvedValue({ tools: [], defaults: [] })
  mockConnectorList.mockResolvedValue([])
  mockListAllSessions.mockResolvedValue([])
  mockListMessages.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])
  mockListEnriched.mockResolvedValue([])
  mockAiFields.mockResolvedValue(null)
  // 默认关掉「新建智能体」门控（多数用例不关心它）；create 流的用例单独开。
  mockChatConfigFlags(false)
})

afterEach(() => cleanup())

describe('清单与分组', () => {
  test('内置/自定义两组；主 Agent 在最前', async () => {
    const container = await renderWorkspace()
    const keys = Array.from(container.querySelectorAll('[data-team-member]')).map((el) =>
      el.getAttribute('data-team-member')
    )
    expect(keys).toEqual([
      'member:main',
      'member:agent:daily_email_digest',
      'member:agent:email_search_agent',
      'member:agent:email_preprocess_agent',
      'member:agent:project_progress_sync',
      'member:agent:dms_helper'
    ])
    expect(screen.getByText('内置')).toBeTruthy()
    expect(screen.getByText('自定义')).toBeTruthy()
  })
})

describe('两档视图', () => {
  test('🔴 换成员恒回第一档（先切到设置再换成员，才测得到 reset）', async () => {
    const container = await renderWorkspace()
    // 进跟进员：默认第一档（对话）→ 新会话落点。
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    await waitFor(() => expect(container.querySelector('[data-team-new-session]')).toBeTruthy())
    // 切到设置档。
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    expect(container.querySelector('[data-team-settings]')).toBeTruthy()
    expect(container.querySelector('[data-team-record-pane]')).toBeNull()
    // 换成员（邮件日报，同样有两档）→ 必须回第一档，而不是停在设置。
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:daily_email_digest"]')!
    )
    await waitFor(() => expect(container.querySelector('[data-team-record-pane]')).toBeTruthy())
    expect(container.querySelector('[data-team-settings]')).toBeNull()
  })

  test('主 Agent：只有设置档 + 「去对话」按钮，无视图档切换', async () => {
    const container = await renderWorkspace()
    // 先停在别人的第一档（record），再切主 Agent —— 不能白屏。
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    fireEvent.click(container.querySelector('[data-team-member="member:main"]')!)
    await waitFor(() => expect(container.querySelector('[data-team-settings]')).toBeTruthy())
    expect(container.querySelector('[data-go-chat]')).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(container.querySelector('[data-team-record-pane]')).toBeNull()
  })

  test('搜索 Agent：只有设置档 + ⌘K 说明（主 session 拍板偏离 design §8.0）', async () => {
    const container = await renderWorkspace()
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:email_search_agent"]')!
    )
    await waitFor(() => expect(container.querySelector('[data-team-settings]')).toBeTruthy())
    expect(container.querySelector('[data-no-chat-reason]')?.textContent).toContain('⌘K')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})

describe('记录面壳', () => {
  test('🔴 记录列穿插按时间倒序（会话落在两次执行之间）+ ⚡自动标记 + 新对话默认落点', async () => {
    mockListRuns.mockResolvedValue({
      items: [
        {
          jobId: 1,
          agentId: 'dms_helper',
          state: 'completed',
          createdAt: 1_700_000_001_000,
          summary: '第一次执行',
          triggerKind: 'schedule'
        },
        {
          jobId: 3,
          agentId: 'dms_helper',
          state: 'failed',
          createdAt: 1_700_000_003_000,
          summary: '第三次执行',
          triggerKind: 'schedule'
        }
      ],
      total: 2
    })
    mockListAllSessions.mockResolvedValue([
      makeSession({ id: 100, updated_at: 1_700_000_002_000, title: '中间的会话' })
    ])
    const container = await renderWorkspace()
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    await waitFor(() =>
      expect(container.querySelectorAll('[data-record-row]').length).toBeGreaterThanOrEqual(3)
    )
    const rowKeys = Array.from(container.querySelectorAll('[data-record-row]')).map((el) =>
      el.getAttribute('data-record-row')
    )
    expect(rowKeys).toEqual(['run:3', 'session:100', 'run:1'])
    // ⚡自动：schedule run 与 origin=agent 会话都标。
    expect(container.querySelector('[data-record-row="run:3"] [data-auto-badge]')).toBeTruthy()
    // 能对话：顶部有「新对话」，默认落新会话（composer 禁用 + P4b 说明）。
    expect(container.querySelector('[data-record-new]')).toBeTruthy()
    expect(container.querySelector('[data-team-new-session]')).toBeTruthy()
    expect(container.querySelector('[data-pending-composer]')).toBeTruthy()
  })

  test('不能对话（项目周报）：无「新建」，默认落最新一条执行 + 顶部写明为什么不接', async () => {
    mockProgressRuns.mockResolvedValue([
      { internalId: 8, subject: '旧一封', status: 'completed', startedAt: 1_700_000_000 },
      { internalId: 9, subject: '新一封', status: 'failed', startedAt: 1_700_000_100 }
    ])
    const container = await renderWorkspace()
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:project_progress_sync"]')!
    )
    await waitFor(() => expect(container.querySelector('[data-team-progress-detail]')).toBeTruthy())
    expect(container.querySelector('[data-record-new]')).toBeNull()
    // 默认选中最新（startedAt 大的 internalId=9）。
    expect(
      container
        .querySelector('[data-team-progress-detail]')
        ?.getAttribute('data-team-progress-detail')
    ).toBe('9')
    expect(container.querySelector('[data-no-chat-reason]')?.textContent).toContain('不走 AI')
  })

  test('预处理：per-邮件清单 + 顶部说明（跟着收信逐封跑）', async () => {
    mockListEnriched.mockResolvedValue([
      {
        internal_id: 101,
        subject: '被分类的邮件',
        sender: 'a@x.test',
        date_received: '2026-08-30T10:00:00+08:00',
        mailbox: '收件箱',
        is_read: true,
        is_flagged: false,
        lang: 'zh',
        ai_priority: 'important',
        ai_action: '回复',
        ai_category: '💼 产品管理',
        attach_count: 0,
        is_important: false,
        processing_status: null,
        snippet: null
      },
      {
        internal_id: 102,
        subject: '没跑过 LLM 的邮件',
        sender: 'b@x.test',
        date_received: '2026-08-30T11:00:00+08:00',
        mailbox: '收件箱',
        is_read: true,
        is_flagged: false,
        lang: 'unknown',
        ai_priority: null,
        ai_action: null,
        ai_category: null,
        attach_count: 0,
        is_important: false,
        processing_status: null,
        snippet: null
      }
    ])
    const container = await renderWorkspace()
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:email_preprocess_agent"]')!
    )
    await waitFor(() =>
      expect(container.querySelector('[data-record-row="email:101"]')).toBeTruthy()
    )
    // 未分类的邮件不进执行面。
    expect(container.querySelector('[data-record-row="email:102"]')).toBeNull()
    expect(container.querySelector('[data-no-chat-reason]')?.textContent).toContain('流水线')
    expect(container.querySelector('[data-team-preprocess-detail]')).toBeTruthy()
  })
})

describe('新建智能体（design §8.4：新建走设置，只有设置档）', () => {
  test('flag 开 → 自定义组尾的「新建」行 → CustomAgentCreateView；点成员即退出新建态', async () => {
    mockChatConfigFlags(true)
    const container = await renderWorkspace()
    await waitFor(() => expect(container.querySelector('[data-team-create-row]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-team-create-row]')!)
    await waitFor(() => expect(container.querySelector('[data-team-create]')).toBeTruthy())
    // 新建态只有设置表单：无成员详情、无视图档。
    expect(container.querySelector('[data-team-member-detail]')).toBeNull()
    // 点任意成员 → 退出新建态回成员详情。
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    await waitFor(() =>
      expect(
        container.querySelector('[data-team-member-detail="member:agent:dms_helper"]')
      ).toBeTruthy()
    )
    expect(container.querySelector('[data-team-create]')).toBeNull()
  })

  test('flag 关 → 无「新建」行', async () => {
    const container = await renderWorkspace()
    expect(container.querySelector('[data-team-create-row]')).toBeNull()
  })
})

describe('跨页直达（通讯录「去配置」store-intent）', () => {
  test('store 点名 agent id → 选中该成员并落设置档，消费即清', async () => {
    useAgentsNavigation.getState().openConfig('dms_helper')
    const container = await renderWorkspace()
    await waitFor(() => {
      expect(
        container.querySelector('[data-team-member-detail="member:agent:dms_helper"]')
      ).toBeTruthy()
    })
    expect(container.querySelector('[data-team-settings]')).toBeTruthy()
    expect(useAgentsNavigation.getState().targetAgentId).toBeNull()
  })
})
