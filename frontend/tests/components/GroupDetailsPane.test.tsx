// @vitest-environment happy-dom
//
// L4 群聊 UX 批 — 群详情面契约（迁自 GroupSettingsDialog.test.tsx，S1–S3 语义保留、选择器换）。
//
//   S1 改响应模式 → PUT 只带那一个成员（即改即存，没有保存按钮）；分段控件靠 `details.modeAria`
//      定位 —— 这条同时钉住那个 aria key 没在 settings.* → details.* 迁移里被丢掉；
//   S2 主持人 Select 单选可空；judgeScopeStale → 警告行 +「重新确认」PUT 同值（重写 hash）；
//   S3 用量：两指标已知 / 未知 + 24h 行 + 小时地板进度条宽度 = used/cap；
//   S4 数值项 blur → PUT 数字；「恢复默认」→ PUT **null**（删键 ≠ 不传）；
//   S5 加人 Popover 排除已在群的；满员禁用；点选 → patchGroupMembers({add});
//   S6 移出 → **先二次确认**再 patchGroupMembers({remove});
//   S7 全群模型 → PUT modelOverride / null；S8 通知 Switch → PUT {notify:false};
//   S9 危险区：删除群 → deleteSession；清空历史 → DELETE messages/from/{firstId};
//   S10 labs off 只渲染 基本 / 成员 / 危险区（无模式、无主持人、无上限、无用量）+ labsOffNote；
//   S11 config 读失败 → loadFailed + 重试，不静默；S12 近期唤醒表色点 + 空态；
//   S13 主 Agent（保留 id `main`）在群里可以坐主持人位。
//
// mock 面：groupSettings（serve-api 客户端）+ http_client（清空历史打的是会话消息端点）+
// useMailApi（改名 / 删会话 / 列消息）+ useEnabledModels + AgentAvatar 探针桩。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockGetGroupConfig = vi.fn()
const mockSetGroupConfig = vi.fn()
const mockGetGroupMetrics = vi.fn()
const mockGetGroupTurns = vi.fn()
const mockPatchGroupMembers = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getGroupConfig: (...args: unknown[]) => mockGetGroupConfig(...args),
  setGroupConfig: (...args: unknown[]) => mockSetGroupConfig(...args),
  getGroupMetrics: (...args: unknown[]) => mockGetGroupMetrics(...args),
  getGroupTurns: (...args: unknown[]) => mockGetGroupTurns(...args),
  patchGroupMembers: (...args: unknown[]) => mockPatchGroupMembers(...args),
  getLabs: vi.fn(),
  setLabs: vi.fn()
}))

const mockRequest = vi.fn()
vi.mock('@shared/api/http_client', () => ({
  request: (...args: unknown[]) => mockRequest(...args)
}))

const mockListMessages = vi.fn()
const mockUpdateTitle = vi.fn()
const mockDeleteSession = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: {
      listMessages: mockListMessages,
      updateSessionTitle: mockUpdateTitle,
      deleteSession: mockDeleteSession
    }
  })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  useEnabledModels: () => ({ models: ['claude-opus-4-8'], rawEnabled: ['claude-opus-4-8'] }),
  // ModelSelectItems → useProviderRegistryEnabled 的 queryFn 从这个模块拿。
  fetchChatConfigModelsProbe: vi.fn().mockResolvedValue({
    enabledModels: ['claude-opus-4-8'],
    providerRegistryEnabled: false,
    kosConsumerEnabled: false,
    kosConfigured: false
  })
}))

vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string; size?: number; title?: string }) => (
    <span data-avatar={props.agentId} data-size={props.size} title={props.title} />
  )
}))

import i18n from '@shared/i18n'
import type { ChatSession } from '@shared/api/types'
import { GroupDetailsPane } from '../../src/shared/components/agents/groups/GroupDetailsPane'
import type {
  GroupCandidate,
  GroupMemberMeta
} from '../../src/shared/components/agents/groups/members'

await i18n.changeLanguage('zh-CN')

const MEMBER_IDS = ['a1', 'a2']
/** 主 Agent 在群里的名字来自 assistant identity（工作区拼进 memberMeta，这里当既成事实用）。 */
const MAIN_MEMBER_IDS = ['main', 'a1']
const MEMBER_META = new Map<string, GroupMemberMeta>([
  ['main', { title: '小欧' }],
  ['a1', { title: '调研员' }],
  ['a2', { title: '跟进官' }],
  ['a3', { title: '评审' }]
])

const SESSION: ChatSession = {
  id: 300,
  email_id: null,
  anchor_type: 'general',
  anchor_id: null,
  backend_kind: 'ai-sdk',
  backend_model: null,
  backend_agent_page_id: null,
  title: '项目对齐群',
  archived: false,
  created_at: 1,
  updated_at: 1,
  origin: 'group',
  members_json: '["a1","a2"]'
}

function candidate(id: string, title: string, model: string | null): GroupCandidate {
  return { id, title, avatar: null, model }
}

const CANDIDATES: GroupCandidate[] = [
  // 主 Agent 排在最前（工作区的候选序），且没有自己的模型。
  candidate('main', '小欧', null),
  candidate('a1', '调研员', 'claude-opus-4-8'),
  candidate('a2', '跟进官', 'claude-sonnet-4-8'),
  candidate('a3', '评审', 'claude-haiku-4-8')
]

const onMembersChanged = vi.fn()
const onDeleted = vi.fn()
const onRenamed = vi.fn()

function renderPane(labsOn = true, memberIds = MEMBER_IDS): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const { container } = render(
    createElement(
      QueryClientProvider,
      { client: qc },
      <GroupDetailsPane
        sessionId={300}
        session={SESSION}
        memberIds={memberIds}
        memberMeta={MEMBER_META}
        candidates={CANDIDATES}
        labsOn={labsOn}
        onClose={vi.fn()}
        onRenamed={onRenamed}
        onDeleted={onDeleted}
        onMembersChanged={onMembersChanged}
      />
    )
  )
  return container
}

const PAYLOAD = {
  modes: {},
  config: { v: 1 as const },
  members: MEMBER_IDS,
  judgeScopeStale: false
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetGroupConfig.mockResolvedValue(PAYLOAD)
  mockSetGroupConfig.mockResolvedValue(PAYLOAD)
  mockPatchGroupMembers.mockResolvedValue(PAYLOAD)
  mockGetGroupTurns.mockResolvedValue({ turns: [], hasMore: false })
  mockGetGroupMetrics.mockResolvedValue({
    silentRunRate: null,
    turnsPerHumanMessage: null,
    last1h: { turns: 0, tokens: 0, costUsd: null },
    last24h: { turns: 0, tokens: 0, costUsd: null },
    lastStopReason: null
  })
  mockListMessages.mockResolvedValue([{ id: 11 }, { id: 12 }])
  mockUpdateTitle.mockResolvedValue(undefined)
  mockDeleteSession.mockResolvedValue(undefined)
  mockRequest.mockResolvedValue(undefined)
  // ModelSelectItems 的 provider-registry 探针会打 /chat/config —— 桩掉，走它自己的 catch。
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline')))
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('GroupDetailsPane', () => {
  test('S1 改一位成员的响应模式 → PUT 只带改过的那个键（即改即存）', async () => {
    // a2 已经有一行 realtime：整表回写会把它一起写回去 —— 断言就是要挡住那种写法。
    // chainCap 只是哨兵：它的「恢复默认」钮只在服务端事实到达后才出现（不等这一拍就点，
    // 组件读到的 modes 还是空的，整表回写与只写一键**看起来一样**）。
    mockGetGroupConfig.mockResolvedValue({
      ...PAYLOAD,
      modes: { a2: 'realtime' },
      config: { v: 1, chainCap: 30 }
    })
    const container = renderPane()
    await waitFor(() => expect(container.querySelector('[data-reset="chainCap"]')).toBeTruthy())
    const track = screen.getByLabelText('调研员 的响应模式')
    const realtime = Array.from(track.querySelectorAll('button')).find(
      (b) => b.textContent === '实时'
    ) as HTMLButtonElement
    fireEvent.click(realtime)
    await waitFor(() => expect(mockSetGroupConfig).toHaveBeenCalledTimes(1))
    // 🔴 只有 a1；a2 没动 → 不在 payload 里；没有别的键被顺手回写。
    expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { modes: { a1: 'realtime' } })
  })

  test('S2 主持人 Select 单选可空；judgeScopeStale → 警告 +「重新确认」PUT 同值', async () => {
    renderPane()
    const trigger = await screen.findByRole('combobox', { name: '主持人位' })
    expect(screen.queryByText(/成员名单变过/)).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: '跟进官' }))
    await waitFor(() =>
      expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { judgeAgentId: 'a2' })
    )

    cleanup()
    mockSetGroupConfig.mockClear()
    mockGetGroupConfig.mockResolvedValue({
      ...PAYLOAD,
      config: { v: 1, judgeAgentId: 'a1' },
      judgeScopeStale: true
    })
    renderPane()
    await waitFor(() => expect(screen.getByText(/成员名单变过/)).toBeTruthy())
    fireEvent.click(screen.getByText('重新确认主持人位'))
    // 同值也要重写（服务端据此重算 judgeScopeHash = 重新确认那一刻的名单）。
    await waitFor(() =>
      expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { judgeAgentId: 'a1' })
    )
  })

  test('S3 用量：两指标 + 24h 行 + 小时地板进度条宽度 = used/cap', async () => {
    mockGetGroupConfig.mockResolvedValue({ ...PAYLOAD, config: { v: 1, hourlyTurns: 10 } })
    mockGetGroupMetrics.mockResolvedValue({
      silentRunRate: 0.263,
      turnsPerHumanMessage: 3.5,
      last1h: { turns: 7, tokens: 12_000, costUsd: null },
      last24h: { turns: 20, tokens: 40_000, costUsd: 0.4 },
      lastStopReason: 'chain_cap'
    })
    const container = renderPane()
    await waitFor(() => expect(screen.getByText('26.3%')).toBeTruthy())
    expect(screen.getByText('3.5')).toBeTruthy()
    // 整窗 cost 全 NULL = 未知（≠ $0.00）。
    expect(screen.getByText(/7 次 · 12000 token · —/)).toBeTruthy()
    // 24h 行照常有数字。
    expect(screen.getByText(/20 次 · 40000 token · \$0.40/)).toBeTruthy()
    expect(screen.getByText(/上次停止：这条对话链已达唤醒上限/)).toBeTruthy()
    // 进度条：7 / 配置的 10 = 70%；cost 未知 → 那条不画（不是画一条 0%）。
    const turnsBar = container.querySelector('[data-usage-bar="turns"]') as HTMLElement
    expect(turnsBar.style.width).toBe('70%')
    expect(container.querySelector('[data-usage-bar="cost"]')).toBeNull()
  })

  test('S4 数值项 blur → PUT 数字；「恢复默认」→ PUT null（删键）', async () => {
    mockGetGroupConfig.mockResolvedValue({ ...PAYLOAD, config: { v: 1, chainCap: 30 } })
    // 应答是服务端读回的新事实（组件拿它刷缓存）—— 写完 20 之后这一项仍是「有显式值」，
    // 「恢复默认」还在。
    mockSetGroupConfig.mockResolvedValue({ ...PAYLOAD, config: { v: 1, chainCap: 20 } })
    const container = renderPane()
    const input = (await screen.findByLabelText('一条链最多唤醒')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { chainCap: 20 }))

    mockSetGroupConfig.mockClear()
    fireEvent.click(container.querySelector('[data-reset="chainCap"]') as HTMLElement)
    // 🔴 显式 null（删键 = 恢复出厂默认）；undefined / 不传 = 不动，语义完全不同。
    await waitFor(() => expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { chainCap: null }))
  })

  test('S5 加人：候选排除已在群的；满员禁用；点选 → patchGroupMembers({add})', async () => {
    const container = renderPane()
    const add = await screen.findByText('加人')
    fireEvent.click(add)
    await waitFor(() => expect(document.querySelector('[data-add-member]')).toBeTruthy())
    expect(document.querySelector('[data-add-member="a3"]')).toBeTruthy()
    expect(document.querySelector('[data-add-member="a1"]')).toBeNull()
    fireEvent.click(document.querySelector('[data-add-member="a3"]') as HTMLElement)
    await waitFor(() => expect(mockPatchGroupMembers).toHaveBeenCalledWith(300, { add: ['a3'] }))
    expect(onMembersChanged).toHaveBeenCalled()

    // 满员：钮禁用 + 说明上限。
    cleanup()
    const full = Array.from({ length: 8 }, (_, i) => `m${i}`)
    mockGetGroupConfig.mockResolvedValue({ ...PAYLOAD, members: full })
    renderPane(true, full)
    await waitFor(() =>
      expect((screen.getByText('加人').closest('button') as HTMLButtonElement).disabled).toBe(true)
    )
    expect(container).toBeTruthy()
    expect(screen.getByText(/已达成员上限/)).toBeTruthy()
  })

  test('S6 移出：先二次确认，确认后才 patchGroupMembers({remove})', async () => {
    const container = renderPane()
    await waitFor(() => expect(container.querySelector('[data-remove-member="a2"]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-remove-member="a2"]') as HTMLElement)
    // 🔴 点一下不会直接踢人：先出确认框。
    expect(mockPatchGroupMembers).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText(/把 跟进官 移出群？/)).toBeTruthy())
    fireEvent.click(document.querySelector('[data-confirm-action]') as HTMLElement)
    await waitFor(() => expect(mockPatchGroupMembers).toHaveBeenCalledWith(300, { remove: ['a2'] }))
  })

  test('S7 全群模型：选模型 → PUT modelOverride；「各用各的」→ PUT null', async () => {
    mockGetGroupConfig.mockResolvedValue({
      ...PAYLOAD,
      config: { v: 1, modelOverride: 'claude-opus-4-8' }
    })
    renderPane()
    const trigger = await screen.findByRole('combobox', { name: '全群模型' })
    // 有 override 时，成员行的模型列显示 override 并标「全群统一」（不是各自的 model）。
    expect((await screen.findAllByText(/claude-opus-4-8 · 全群统一/)).length).toBe(2)
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: '各用各的' }))
    await waitFor(() =>
      expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { modelOverride: null })
    )
  })

  test('S8 本群通知 Switch → PUT {notify:false}', async () => {
    renderPane()
    const toggle = await screen.findByLabelText('本群通知')
    expect(toggle.getAttribute('aria-checked')).toBe('true') // 缺省 = 发
    fireEvent.click(toggle)
    await waitFor(() => expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { notify: false }))
  })

  test('S9 危险区：删除群 → deleteSession；清空历史 → DELETE messages/from/{firstId}', async () => {
    renderPane()
    fireEvent.click(await screen.findByText('删除群'))
    await waitFor(() => expect(screen.getByText(/项目对齐群/)).toBeTruthy())
    fireEvent.click(document.querySelector('[data-confirm-action="delete"]') as HTMLElement)
    await waitFor(() => expect(mockDeleteSession).toHaveBeenCalledWith(300))
    expect(onDeleted).toHaveBeenCalled()

    fireEvent.click(screen.getByText('清空历史'))
    await waitFor(() => expect(screen.getByText(/删除本群全部消息/)).toBeTruthy())
    fireEvent.click(document.querySelector('[data-confirm-action="clear"]') as HTMLElement)
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(
        expect.any(String),
        'DELETE',
        '/chat/sessions/300/messages/from/11'
      )
    )
  })

  test('S10 labs off：只渲染 基本 / 成员 / 危险区 + labsOffNote', async () => {
    renderPane(false)
    await waitFor(() => expect(screen.getByText('成员')).toBeTruthy())
    expect(screen.getByText('基本')).toBeTruthy()
    expect(screen.getByText('危险区')).toBeTruthy()
    expect(screen.getByText(/响应模式、主持人位、上限与用量/)).toBeTruthy()
    // v1 下不生效的东西一律不渲染（渲染出来就是骗人）。
    expect(screen.queryByLabelText('调研员 的响应模式')).toBeNull()
    expect(screen.queryByRole('combobox', { name: '主持人位' })).toBeNull()
    expect(screen.queryByText('上限与预算')).toBeNull()
    expect(screen.queryByText('用量')).toBeNull()
    // 成员本身还在（加 / 踢在 v1 也有意义）。
    expect(screen.getByText('调研员')).toBeTruthy()
    expect(screen.getByText('加人')).toBeTruthy()
    expect(mockGetGroupMetrics).not.toHaveBeenCalled()
  })

  test('S11 config 读失败 → 说明 + 重试钮（不静默空白）', async () => {
    mockGetGroupConfig.mockRejectedValue(new Error('boom'))
    renderPane()
    await waitFor(() => expect(screen.getByText('读不到群设置。')).toBeTruthy())
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(mockGetGroupConfig.mock.calls.length).toBeGreaterThan(1))
  })

  test('S12 近期唤醒表：每行一个 outcome 色点；无记录 → 空态', async () => {
    renderPane()
    await waitFor(() => expect(screen.getByText('还没有唤醒记录')).toBeTruthy())

    cleanup()
    mockGetGroupTurns.mockResolvedValue({
      turns: [
        {
          id: 9,
          runId: 'r1',
          chainId: 5,
          seq: 1,
          agentId: 'a1',
          triggerKind: 'human',
          outcome: 'silent',
          messageId: null,
          model: null,
          tokensInput: 100,
          tokensOutput: 20,
          costUsd: 0.01,
          error: null,
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_001_000
        }
      ],
      hasMore: false
    })
    const container = renderPane()
    await waitFor(() => expect(container.querySelector('[data-turn-row="9"]')).toBeTruthy())
    const row = container.querySelector('[data-turn-row="9"]') as HTMLElement
    expect(row.querySelector('[data-outcome="silent"]')).toBeTruthy()
    expect(row.textContent).toContain('沉默')
    expect(row.textContent).toContain('120')
  })

  test('S13 主 Agent 在名单里就能坐主持人位（judgeAgentId 写保留 id）', async () => {
    mockGetGroupConfig.mockResolvedValue({ ...PAYLOAD, members: MAIN_MEMBER_IDS })
    renderPane(true, MAIN_MEMBER_IDS)
    fireEvent.click(await screen.findByRole('combobox', { name: '主持人位' }))
    fireEvent.click(await screen.findByRole('option', { name: '小欧' }))
    await waitFor(() =>
      expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { judgeAgentId: 'main' })
    )
  })
})
