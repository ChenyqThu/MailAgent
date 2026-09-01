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
const mockRunLogSteps = vi.fn()
const mockToolOptions = vi.fn()
const mockCreateAgent = vi.fn()
const mockSetConfig = vi.fn()
const mockRunNow = vi.fn()
const mockConnectorList = vi.fn()
const mockListAllSessions = vi.fn()
const mockListGeneralSessions = vi.fn()
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
      runLogSteps: mockRunLogSteps,
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
      listGeneralSessions: mockListGeneralSessions,
      listMessages: mockListMessages,
      listSkills: mockListSkills
    },
    email: {
      listEnriched: mockListEnriched,
      aiFields: mockAiFields
    }
  })
}))

// P4b — 团队对话的运行时叶（AgentConversation 拖满整棵 assistant-ui 树 + gateway 探活）
// 打桩；真接线链（TeamRecordPane → TeamChatHost → agentIdentity）保持真组件。桩渲染
// 身份 data 属性，让「真 composer 在场且是这位成员的身份」可断言（matterChatNewSession
// 同款打桩纪律）。
vi.mock('../../src/shared/components/agents/AgentConversation', () => ({
  AgentConversation: (props: {
    agentIdentity?: { agentId: string; welcome: { title: string; hint: string } }
    activeItem: { id: number } | null
  }) => (
    <div
      data-live-conversation
      data-conversation-agent={props.agentIdentity?.agentId ?? ''}
      data-conversation-session={props.activeItem?.id ?? 'new'}
    />
  )
}))

// env store 的 refresh() 走 makeMailApi()（不是 useMailApi hook，见 env.ts 头注释）—— 团队页
// mount 时的自动刷新断言要打这个桩（AccountsTabNotionOauth.test 同款 mock 位置）。
const mockEnvGet = vi.fn()
vi.mock('@shared/api/factory', () => ({
  makeMailApi: () => ({ env: { get: mockEnvGet, set: vi.fn() } })
}))

import i18n from '@shared/i18n'
import { useToastStore } from '@shared/state/toast'
import { useEnvStore } from '@shared/state/env'
import type { ChatSessionListItem, ReportAgentConfig, EnvSnapshot } from '@shared/api/types'
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

/** 记录列的会话源现在是**两条**查询（origin='agent' headless run 会话 + origin='team'
 *  人以 agent 身份开的会话）。mockResolvedValue 会让同一份数据被两条查询各返一次 →
 *  同一个 session 在时间线里出现两遍（React 还会报 duplicate key）。按 origin 分流。 */
function setAgentSessions(list: ChatSessionListItem[], teamList: ChatSessionListItem[] = []): void {
  mockListAllSessions.mockImplementation((opts?: { origin?: string }) =>
    Promise.resolve(opts?.origin === 'agent' ? list : opts?.origin === 'team' ? teamList : [])
  )
}

/** 导入入口也走裸 fetch（POST /report-agents/import），与 /chat/config 同一个桩 —— 必须
 *  按 URL 分流，否则 config 的响应会把导入结果一并冒充掉。 */
let importReply: { ok: boolean; statusText?: string; body: unknown } = {
  ok: true,
  body: { data: {} }
}
/** 导入请求发出的那一刻的钩子（用例用它把新 agent 加进 getConfig 的返回）。 */
let onImportRequest: (() => void) | null = null
function mockChatConfigFlags(
  customAgentsEnabled: boolean,
  flags: Record<string, boolean> = {}
): void {
  global.fetch = vi.fn().mockImplementation((input: unknown) => {
    if (String(input).includes('/report-agents/import')) {
      onImportRequest?.()
      return Promise.resolve({
        ok: importReply.ok,
        statusText: importReply.statusText ?? '',
        json: async () => importReply.body
      })
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({
        data: {
          customAgentsEnabled,
          agentPluginsEnabled: true,
          calendarTriggerEnabled: true,
          ...flags
        }
      })
    })
  }) as unknown as typeof fetch
}

function importBodyOf(call: unknown[]): unknown {
  return JSON.parse(String((call[1] as { body?: unknown }).body))
}

function envSnapshot(values: Record<string, string> = {}): EnvSnapshot {
  return {
    path: '/tmp/.env',
    exists: true,
    values,
    managedKeys: Object.keys(values),
    secretKeys: []
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAgentsNavigation.getState().clear()
  useEnvStore.setState({ state: { status: 'idle' } })
  mockEnvGet.mockResolvedValue(envSnapshot())
  mockGetConfig.mockResolvedValue(AGENTS)
  mockListRuns.mockResolvedValue({ items: [], total: 0 })
  mockReportList.mockResolvedValue({ items: [], total: 0 })
  mockProgressRuns.mockResolvedValue([])
  mockRunLogSteps.mockResolvedValue([])
  mockToolOptions.mockResolvedValue({ tools: [], defaults: [] })
  mockConnectorList.mockResolvedValue([])
  setAgentSessions([])
  mockListGeneralSessions.mockResolvedValue([])
  mockListMessages.mockResolvedValue([])
  mockListSkills.mockResolvedValue([])
  mockListEnriched.mockResolvedValue([])
  mockAiFields.mockResolvedValue(null)
  importReply = { ok: true, body: { data: {} } }
  onImportRequest = null
  useToastStore.getState().clear()
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
    // 进跟进员：默认第一档（对话）→ 新会话落点（P4b：真 composer 宿主）。
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    await waitFor(() => expect(container.querySelector('[data-team-chat-host]')).toBeTruthy())
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
    setAgentSessions([makeSession({ id: 100, updated_at: 1_700_000_002_000, title: '中间的会话' })])
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
    // 能对话：顶部有「新对话」，默认落新会话 —— P4b 起是**真 composer**（TeamChatHost 挂
    // AgentConversation，身份 = 这位成员），禁用占位条已随写侧接通退役。
    expect(container.querySelector('[data-record-new]')).toBeTruthy()
    expect(container.querySelector('[data-team-chat-host="member:agent:dms_helper"]')).toBeTruthy()
    expect(
      container.querySelector('[data-live-conversation]')?.getAttribute('data-conversation-agent')
    ).toBe('dms_helper')
    expect(container.querySelector('[data-pending-composer]')).toBeNull()
  })

  test('P4b — 记录列点中 origin=team 会话 → 续聊（真 composer）；origin=agent 保持只读', async () => {
    setAgentSessions(
      [makeSession({ id: 300, updated_at: 1_700_000_001_000, title: 'headless 记录' })],
      [
        makeSession({
          id: 301,
          updated_at: 1_700_000_002_000,
          title: '上次以它身份的对话',
          origin: 'team'
        })
      ]
    )
    const container = await renderWorkspace()
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    await waitFor(() =>
      expect(container.querySelector('[data-record-row="session:301"]')).toBeTruthy()
    )
    // team 会话 → TeamChatHost（真 composer），activeItem 是该行。
    fireEvent.click(container.querySelector('[data-record-row="session:301"]')!)
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-live-conversation]')
          ?.getAttribute('data-conversation-session')
      ).toBe('301')
    )
    // agent 会话（headless 降级形态行）→ 只读详情，无 composer（P4 红线镜像）。
    fireEvent.click(container.querySelector('[data-record-row="session:300"]')!)
    await waitFor(() =>
      expect(container.querySelector('[data-team-session-detail="300"]')).toBeTruthy()
    )
    expect(container.querySelector('[data-live-conversation]')).toBeNull()
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

  // 08-31 — r10 §0 抓到的缺陷：失败的预处理在读侧分不出来（没有 labels ⇒ 被列表面的
  // labels 判据整批滤掉），团队页里根本看不见。
  test('🔴 预处理失败行可见且标失败态（判据是 llm_status，不是 labels 派生字段）', async () => {
    mockListEnriched.mockResolvedValue([
      {
        internal_id: 103,
        subject: '分类失败的邮件',
        sender: 'c@x.test',
        date_received: '2026-08-30T12:00:00+08:00',
        mailbox: '收件箱',
        is_read: true,
        is_flagged: false,
        lang: 'unknown',
        // 失败行没有任何 labels 派生字段 —— 这正是它此前被滤掉的原因。
        ai_priority: null,
        ai_action: null,
        ai_category: null,
        attach_count: 0,
        is_important: false,
        processing_status: null,
        snippet: null,
        llm_status: 'failed'
      }
    ])
    mockAiFields.mockResolvedValue({
      internal_id: 103,
      processing_status: null,
      mailbox: '收件箱',
      is_read: true,
      is_flagged: false,
      ai_priority: null,
      ai_action: null,
      ai_review_status: 'pending',
      sentiment: null,
      ai_model: 'claude-fable-5',
      labels_raw: null,
      llm_status: 'failed',
      latency_ms: 4200,
      input_tokens: 1200,
      output_tokens: 0,
      retry_count: 3,
      last_error: 'upstream 529 overloaded'
    })
    const container = await renderWorkspace()
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:email_preprocess_agent"]')!
    )
    const row = await waitFor(() => {
      const el = container.querySelector('[data-record-row="email:103"]')
      expect(el).toBeTruthy()
      return el!
    })
    // 状态点用 fail 色（成功行是 bg-ok），失败一眼看得出来。
    expect(row.querySelector('.bg-fail')).toBeTruthy()
    // 详情给出错误原文 + 耗时 + 重试次数，并写清为什么这么处置。
    await waitFor(() => expect(screen.getByText('upstream 529 overloaded')).toBeTruthy())
    expect(screen.getByText('4.2s')).toBeTruthy()
    expect(screen.getByText('这一封没跑通')).toBeTruthy()
  })

  // 08-31 — 报告 / 画像 / 项目周报的过程台账（agent_run_log）与 async_jobs run、会话
  // 同一条时间线穿插，不另开一栏。
  test('🔴 run_log 行穿插进记录列，点开走步骤合成的 transcript', async () => {
    mockListRuns.mockResolvedValue({
      items: [
        {
          jobId: 1,
          agentId: 'dms_helper',
          state: 'completed',
          createdAt: 1_700_000_001_000,
          summary: '老台账的执行',
          triggerKind: 'schedule'
        },
        {
          kind: 'run_log',
          runLogId: 5,
          jobId: 5,
          agentId: 'dms_helper',
          state: 'completed',
          createdAt: new Date(1_700_000_003_000).toISOString(),
          summary: '新台账的执行',
          triggerKind: 'schedule',
          triggerDetail: '按日排程'
        }
      ],
      total: 2
    })
    setAgentSessions([makeSession({ id: 100, updated_at: 1_700_000_002_000, title: '中间的会话' })])
    mockRunLogSteps.mockResolvedValue([
      { seq: 0, kind: 'trig', detail: '按日排程', payload: null, ok: null, ms: null },
      { seq: 1, kind: 'out', detail: '这是步骤合成的输出', payload: null, ok: null, ms: null }
    ])
    const container = await renderWorkspace()
    fireEvent.click(container.querySelector('[data-team-member="member:agent:dms_helper"]')!)
    await waitFor(() =>
      expect(container.querySelector('[data-record-row="runlog:5"]')).toBeTruthy()
    )
    const rowKeys = Array.from(container.querySelectorAll('[data-record-row]')).map((el) =>
      el.getAttribute('data-record-row')
    )
    // 时间倒序穿插：run_log(t3) > 会话(t2) > 老 run(t1)，不按来源分块。
    expect(rowKeys).toEqual(['runlog:5', 'session:100', 'run:1'])
    fireEvent.click(container.querySelector('[data-record-row="runlog:5"]')!)
    await waitFor(() => expect(screen.getByText('这是步骤合成的输出')).toBeTruthy())
    expect(mockRunLogSteps).toHaveBeenCalledWith(5)
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

// 08-31 — P4a 丢掉的 Agent Plugin 入口（导入 / 用模板创建）恢复到清单列。链路是
// POST /report-agents/import，不是技能包那条 zip 链。
describe('导入 Agent / 用模板创建', () => {
  const IMPORTED = cfg('meeting_prep_agent', 'custom', { title: '会前准备' })

  /** 导入成功后清单里才有这行 —— 让 getConfig 在导入请求发出后多返一行（invalidate 会重取）。 */
  function serveImportedAgentAfterCall(): void {
    let served = [...AGENTS]
    mockGetConfig.mockImplementation(async () => served)
    importReply = { ok: true, body: { data: { agent: IMPORTED } } }
    onImportRequest = () => {
      served = [...AGENTS, IMPORTED]
    }
  }

  test('flag 开 → 清单列新建行下有两个入口；MAILAGENT_AGENT_PLUGINS 关 → 都不在', async () => {
    mockChatConfigFlags(true)
    const container = await renderWorkspace()
    await waitFor(() => expect(container.querySelector('[data-team-import]')).toBeTruthy())
    expect(container.querySelector('[data-team-import-file]')?.textContent).toBe('导入 Agent')
    expect(container.querySelector('[data-team-import-template]')?.textContent).toBe(
      '用模板创建：会前准备'
    )
    // 日历触发在场（桩里 calendarTriggerEnabled=true）→ 不挂那句警示。
    expect(container.querySelector('[data-team-import-calendar-warn]')).toBeNull()

    cleanup()
    mockChatConfigFlags(true, { agentPluginsEnabled: false })
    const off = await renderWorkspace()
    await waitFor(() => expect(off.querySelector('[data-team-create-row]')).toBeTruthy())
    expect(off.querySelector('[data-team-import]')).toBeNull()
  })

  test('日历触发未启用 → 模板入口旁给出前置说明', async () => {
    mockChatConfigFlags(true, { calendarTriggerEnabled: false })
    const container = await renderWorkspace()
    await waitFor(() =>
      expect(container.querySelector('[data-team-import-calendar-warn]')?.textContent).toBe(
        '需启用日历同步'
      )
    )
  })

  test('用模板创建 → POST {template:meeting_prep} → 选中新成员并落设置档', async () => {
    mockChatConfigFlags(true)
    serveImportedAgentAfterCall()
    const container = await renderWorkspace()
    await waitFor(() => expect(container.querySelector('[data-team-import-template]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-team-import-template]')!)

    await waitFor(() => {
      expect(
        container.querySelector('[data-team-member-detail="member:agent:meeting_prep_agent"]')
      ).toBeTruthy()
    })
    expect(container.querySelector('[data-team-settings]')).toBeTruthy()
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/report-agents/import')
    )!
    expect(String(call[0])).toBe('http://127.0.0.1:8200/api/report-agents/import')
    expect((call[1] as { method?: string }).method).toBe('POST')
    expect(importBodyOf(call)).toEqual({ template: 'meeting_prep' })
  })

  test('选文件导入 → POST {payload}；未满足依赖逐条列出（提示活过跳转，挂在清单列）', async () => {
    mockChatConfigFlags(true)
    serveImportedAgentAfterCall()
    importReply = {
      ok: true,
      body: {
        data: {
          agent: IMPORTED,
          unmet_dependencies: [
            { type: 'skill', ref: 'meeting_notes' },
            { type: 'connector', ref: 'notion' }
          ]
        }
      }
    }
    const container = await renderWorkspace()
    await waitFor(() => expect(container.querySelector('[data-team-import]')).toBeTruthy())
    const input = container.querySelector('[data-team-import] input[type="file"]')!
    const file = new File([JSON.stringify({ agent: { title: '会前准备' } })], 'agent-x.json', {
      type: 'application/json'
    })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(
        container.querySelector('[data-team-member-detail="member:agent:meeting_prep_agent"]')
      ).toBeTruthy()
    })
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/report-agents/import')
    )!
    expect(importBodyOf(call)).toEqual({ payload: { agent: { title: '会前准备' } } })
    // 提示留在清单列（跳去新成员的设置档后仍在），且把依赖插值出来 —— 不是字面 {items}。
    expect(container.querySelector('[data-team-import-notice]')?.textContent).toBe(
      '未满足依赖：skill: meeting_notes, connector: notion'
    )
  })

  test('导入失败不吞错：走 toast 报出后端原因，且不跳转', async () => {
    mockChatConfigFlags(true)
    importReply = {
      ok: false,
      statusText: 'Bad Request',
      body: { error: { message: '包格式不对' } }
    }
    const container = await renderWorkspace()
    await waitFor(() => expect(container.querySelector('[data-team-import-template]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-team-import-template]')!)

    await waitFor(() => {
      const toast = useToastStore.getState().items.find((i) => i.title === '导入 Agent')
      expect(toast?.detail).toBe('包格式不对')
      expect(toast?.variant).toBe('error')
    })
    expect(container.querySelector('[data-team-import-notice]')).toBeNull()
    expect(container.querySelector('[data-team-member-detail="member:main"]')).toBeTruthy()
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

// 08-31 回归修复：env store 默认 idle，仅 SettingsShell mount 时 refresh。清单列的启停
// 徽标（TeamMemberList）与设置档的 enable/model 预填（Preprocess/ProjectProgressSettings）
// 都读它 —— 没开过设置页的会话进团队页必须自己拉一次，否则两个 agent 恒显示禁用
// （P4a 从 AgentsTab 迁移时丢了这段 mount 补丁）。
describe('env store 自动刷新（团队页 mount 不依赖先开过设置页）', () => {
  afterEach(() => useEnvStore.setState({ state: { status: 'idle' } }))

  test('mount 时 env store 为 idle → 自动 refresh 一次，状态转 ready', async () => {
    useEnvStore.setState({ state: { status: 'idle' } })
    mockEnvGet.mockResolvedValue(envSnapshot({ LLM_AGENT_ENABLED: 'true' }))
    await renderWorkspace()
    await waitFor(() => expect(mockEnvGet).toHaveBeenCalledTimes(1))
    expect(useEnvStore.getState().state.status).toBe('ready')
  })

  test('mount 时 env store 已 ready → 不重复 refresh', async () => {
    useEnvStore.setState({ state: { status: 'ready', snapshot: envSnapshot() } })
    await renderWorkspace()
    // 给其余 mount 副作用一点时间落定，再确认没有多余的 env:get 调用。
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled())
    expect(mockEnvGet).not.toHaveBeenCalled()
  })
})

// 配置页视觉批（lane C）——设置档外壳收敛的两条不变量。
describe('设置档外壳收敛', () => {
  test('外层页头已显示成员名 → 骨架页头不再重复渲染标题（同名标题只有一条）', async () => {
    const container = await renderWorkspace()
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:email_search_agent"]')!
    )
    await waitFor(() => expect(container.querySelector('[data-team-settings]')).toBeTruthy())
    // 收敛前这里是 2 条：团队页 52px 页头一条 + 配置页骨架页头一条。
    expect(screen.getAllByRole('heading', { name: '搜索 Agent' })).toHaveLength(1)
    // 角色副标题是外层页头没有的信息 —— 骨架退成动作栏后它必须留着。
    expect(screen.getByText('内置成员')).toBeTruthy()
  })

  test('详情区只剩一层滚动容器（外层交给骨架自己滚）', async () => {
    const container = await renderWorkspace()
    fireEvent.click(
      container.querySelector('[data-team-member="member:agent:email_search_agent"]')!
    )
    await waitFor(() => expect(container.querySelector('[data-team-settings]')).toBeTruthy())
    const host = container.querySelector<HTMLElement>('[data-team-settings]')!
    const isScroller = (el: HTMLElement): boolean =>
      el.classList.contains('overflow-y-auto') || el.style.overflowY === 'auto'
    // 外壳自己不滚（收敛前它是 overflow-y-auto）。
    expect(isScroller(host)).toBe(false)
    // 里面恰好一层在滚 —— 骨架那层，不多不少。
    expect([...host.querySelectorAll<HTMLElement>('*')].filter(isScroller)).toHaveLength(1)
  })
})
