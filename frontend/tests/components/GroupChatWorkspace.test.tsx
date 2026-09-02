// @vitest-environment happy-dom
//
// L4 群聊 UX 批 — 三栏工作区（清单列 / 建群对话框 / 详情面开合）的契约。
//
// 既有 W1–W6 留在 GroupChat.test.tsx（lane C 独占那份文件），本文件只加本批新增的面：
//   W7  行第二行 =「{前缀}：{预览}」+ 相对时间 + 未读点；W7b 发言中脉冲（事件 Map / 本地发送态）；
//   W7c 主助理投递的 user 行前缀是「主助理」不是「你」；
//   W8  没有 last_message → 回落「N 名成员」（与 W1 同一条文案）；
//   W9  行 hover 菜单：重命名内联 → updateSessionTitle；删除 → **先确认**再 deleteSession；
//   W10 零消息群直接出现在列表（serve-api 放宽 EXISTS 后不再靠 draftSession）；
//   W11 详情面开合按群记忆（切群不串台）；
//   W12 建群一次填齐：newSession + setGroupConfig({modes, judgeAgentId, topic})；
//   W13 第二步失败 → 删掉第一步建出来的会话（不留半建群）；
//   W14 labs off 建群：无模式无法官，只 newSession；W15 模板钮禁用且说明什么时候有。
//
// mock 面：useMailApi / groupSettings / useGroupTurnEvents（列表在场态的唯一订阅点）/
// GroupChatView（lane C 的消息流，这里只需要它的 props 接线）/ AgentAvatar 探针桩。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockGetConfig = vi.fn()
const mockListMessages = vi.fn()
const mockNewSession = vi.fn()
const mockUpdateTitle = vi.fn()
const mockDeleteSession = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: { getConfig: mockGetConfig },
    chat: {
      listMessages: mockListMessages,
      newSession: mockNewSession,
      updateSessionTitle: mockUpdateTitle,
      deleteSession: mockDeleteSession
    }
  })
}))

const mockGetLabs = vi.fn()
const mockSetGroupConfig = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getLabs: (...args: unknown[]) => mockGetLabs(...args),
  setLabs: vi.fn(),
  getGroupConfig: vi
    .fn()
    .mockResolvedValue({ modes: {}, config: { v: 1 }, members: [], judgeScopeStale: false }),
  setGroupConfig: (...args: unknown[]) => mockSetGroupConfig(...args),
  patchGroupMembers: vi.fn(),
  getGroupTurns: vi.fn().mockResolvedValue({ turns: [], hasMore: false }),
  getGroupMetrics: vi.fn().mockResolvedValue({
    silentRunRate: null,
    turnsPerHumanMessage: null,
    last1h: { turns: 0, tokens: 0, costUsd: null },
    last24h: { turns: 0, tokens: 0, costUsd: null },
    lastStopReason: null
  })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  useEnabledModels: () => ({ models: [], rawEnabled: [] }),
  fetchChatConfigModelsProbe: vi.fn().mockResolvedValue({
    enabledModels: [],
    providerRegistryEnabled: false,
    kosConsumerEnabled: false,
    kosConfigured: false
  })
}))

// 列表在场态：工作区订阅一次，这里直接给 Map（事件本身由 lane C 的 reducer 用例钉）。
const mockLiveMap = vi.fn()
vi.mock('../../src/shared/components/agents/groups/useGroupTurnEvents', () => ({
  useGroupLiveMap: (enabled: boolean) => mockLiveMap(enabled)
}))

// 群聊视图：本文件只关心工作区往下发的四个 props 接得对不对（消息流本身归 lane C）。
const mockViewProps = vi.fn()
vi.mock('../../src/shared/components/agents/groups/GroupChatView', () => ({
  GroupChatView: (props: {
    session: { id: number }
    detailsOpen: boolean
    onToggleDetails: () => void
    onSendingChange: (sending: boolean) => void
  }) => {
    mockViewProps(props)
    return (
      <div data-group-chat={props.session.id}>
        <button type="button" data-toggle-details onClick={props.onToggleDetails}>
          details
        </button>
        <button type="button" data-start-sending onClick={() => props.onSendingChange(true)}>
          send
        </button>
      </div>
    )
  }
}))

vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string; size?: number; title?: string }) => (
    <span data-avatar={props.agentId} data-size={props.size} title={props.title} />
  )
}))

import i18n from '@shared/i18n'
import type { ChatSession, ChatSessionListItem, ReportAgentConfig } from '@shared/api/types'
import { useSessionsSegment } from '@shared/state/sessions-segment'
import { GroupChatWorkspace } from '../../src/shared/components/agents/groups/GroupChatWorkspace'

const GATEWAY_PORT_KEY = 'mailagent:aiGatewayPort'

await i18n.changeLanguage('zh-CN')

function cfg(id: string, type: string, over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id,
    type,
    enabled: true,
    title: over.title ?? id,
    schedule: { cadence: 'daily', hours: [9] },
    model: 'claude-opus-4-8',
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

const AGENTS = [
  cfg('daily_email_digest', 'report', { title: '邮件日报' }),
  cfg('a1', 'custom', { title: '调研员' }),
  cfg('a2', 'custom', { title: '跟进官' })
]

/** 三天前 —— 相对时间恒走「M/D HH:MM」档，不依赖分钟档的活动时钟。 */
const OLD = Date.now() - 3 * 24 * 3600_000

function groupRow(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 300,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: '项目对齐群',
    archived: false,
    created_at: OLD,
    updated_at: OLD,
    origin: 'group',
    members_json: '["a1","a2"]',
    first_user_message: null,
    message_count: 2,
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

function renderWorkspace(items: ChatSessionListItem[] = [groupRow()], invalidate = vi.fn()) {
  const view = render(
    <GroupChatWorkspace
      headerSlot={<div data-header-slot />}
      items={items}
      invalidate={invalidate}
      narrow={false}
    />,
    { wrapper: makeQcWrapper() }
  )
  return { container: view.container, invalidate }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  useSessionsSegment.setState({
    segment: 'groups',
    activeGroupSessionId: null,
    detailsOpenBySession: {}
  })
  mockGetConfig.mockResolvedValue(AGENTS)
  mockListMessages.mockResolvedValue([])
  mockUpdateTitle.mockResolvedValue(undefined)
  mockDeleteSession.mockResolvedValue(undefined)
  mockSetGroupConfig.mockResolvedValue({
    modes: {},
    config: { v: 1 },
    members: [],
    judgeScopeStale: false
  })
  mockLiveMap.mockReturnValue(new Map())
  window.sessionStorage.setItem(GATEWAY_PORT_KEY, '8321')
  mockGetLabs.mockResolvedValue({ groupAgents: 'off' })
})

describe('GroupChatWorkspace — 清单列（本批新增）', () => {
  test('W7 行：「你：预览」+ 相对时间 + 未读点', async () => {
    const { container } = renderWorkspace([
      groupRow({
        last_read_at: OLD - 1000,
        last_message: {
          content: '大家好',
          role: 'user',
          speaker_agent_id: null,
          via: null,
          created_at: OLD
        }
      })
    ])
    await waitFor(() => expect(screen.getByText('项目对齐群')).toBeTruthy())
    expect(screen.getByText('你：大家好')).toBeTruthy()
    // 相对时间（三天前 → M/D HH:MM 档）。
    const row = container.querySelector('[data-group-row="300"]') as HTMLElement
    expect(row.textContent).toMatch(/\d+\/\d+ \d{2}:\d{2}/)
    // 未读 = 读过之后又有新内容，且不是当前选中行。
    expect(row.querySelector('[data-session-unread-dot]')).toBeTruthy()
  })

  test('W7b 发言中脉冲：事件 Map 命中的行有，别群没有；本地发送态同样点亮', async () => {
    mockLiveMap.mockReturnValue(new Map([[300, { inFlight: 'a1', preparing: null, queued: [] }]]))
    const { container } = renderWorkspace([groupRow(), groupRow({ id: 301, title: '四人群' })])
    await waitFor(() => expect(screen.getByText('项目对齐群')).toBeTruthy())
    const row300 = container.querySelector('[data-group-row="300"]') as HTMLElement
    const row301 = container.querySelector('[data-group-row="301"]') as HTMLElement
    expect(row300.querySelector('[aria-label="发言中"]')).toBeTruthy()
    await waitFor(() => expect(row300.textContent).toContain('调研员 正在输入…'))
    expect(row301.querySelector('[aria-label="发言中"]')).toBeNull()

    // labs off 没有服务端事件：v1 发送期间由群视图 onSendingChange 上抛，列表照样点亮。
    cleanup()
    mockLiveMap.mockReturnValue(new Map())
    const second = renderWorkspace([groupRow(), groupRow({ id: 301, title: '四人群' })])
    fireEvent.click(await screen.findByText('项目对齐群'))
    fireEvent.click(second.container.querySelector('[data-start-sending]') as HTMLElement)
    await waitFor(() =>
      expect(
        (second.container.querySelector('[data-group-row="300"]') as HTMLElement).querySelector(
          '[aria-label="发言中"]'
        )
      ).toBeTruthy()
    )
    expect(
      (second.container.querySelector('[data-group-row="301"]') as HTMLElement).querySelector(
        '[aria-label="发言中"]'
      )
    ).toBeNull()
  })

  test('W7c 主助理投递的 user 行 → 前缀「主助理」（不是「你」）', async () => {
    renderWorkspace([
      groupRow({
        last_message: {
          content: '帮我问一下进度',
          role: 'user',
          speaker_agent_id: null,
          via: 'main_agent',
          created_at: OLD
        }
      })
    ])
    await waitFor(() => expect(screen.getByText('主助理：帮我问一下进度')).toBeTruthy())
    expect(screen.queryByText('你：帮我问一下进度')).toBeNull()
  })

  test('W8 没有 last_message → 回落「N 名成员」（与 W1 同一条文案）', async () => {
    renderWorkspace([groupRow({ last_message: null })])
    await waitFor(() => expect(screen.getByText('2 名成员')).toBeTruthy())
  })

  test('W9 行菜单：重命名内联 → updateSessionTitle；删除 → 确认后 deleteSession', async () => {
    const { container, invalidate } = renderWorkspace()
    await waitFor(() => expect(screen.getByText('项目对齐群')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('更多'))
    fireEvent.click(await screen.findByText('重命名'))
    const input = (await screen.findByLabelText('重命名')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '攻坚群' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockUpdateTitle).toHaveBeenCalledWith(300, '攻坚群'))

    fireEvent.click(screen.getByLabelText('更多'))
    fireEvent.click(await screen.findByText('删除群'))
    // 🔴 点「删除群」只开确认框；没确认之前一条 DELETE 都不发。
    expect(mockDeleteSession).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('删除这个群？')).toBeTruthy())
    fireEvent.click(container.ownerDocument.querySelector('[data-confirm-action]') as HTMLElement)
    await waitFor(() => expect(mockDeleteSession).toHaveBeenCalledWith(300))
    expect(invalidate).toHaveBeenCalled()
  })

  test('W10 零消息群直接出现在列表（不依赖 draftSession）', async () => {
    const { container } = renderWorkspace([groupRow({ message_count: 0, last_message: null })])
    await waitFor(() => expect(container.querySelector('[data-group-row="300"]')).toBeTruthy())
    expect(screen.getByText('项目对齐群')).toBeTruthy()
  })

  test('W11 详情面开合按群记忆（切群不串台）', async () => {
    const { container } = renderWorkspace([groupRow(), groupRow({ id: 301, title: '四人群' })])
    fireEvent.click(await screen.findByText('项目对齐群'))
    await waitFor(() => expect(container.querySelector('[data-group-chat="300"]')).toBeTruthy())
    expect(container.querySelector('[data-group-details="300"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-toggle-details]') as HTMLElement)
    await waitFor(() => expect(container.querySelector('[data-group-details="300"]')).toBeTruthy())

    // 切到别的群：那个群的详情面是各自的记忆（默认关）。
    fireEvent.click(screen.getByText('四人群'))
    await waitFor(() => expect(container.querySelector('[data-group-chat="301"]')).toBeTruthy())
    expect(container.querySelector('[data-group-details="301"]')).toBeNull()
    // 切回来仍然开着。
    fireEvent.click(screen.getByText('项目对齐群'))
    await waitFor(() => expect(container.querySelector('[data-group-details="300"]')).toBeTruthy())
  })
})

describe('GroupChatWorkspace — 建群对话框（一次填齐）', () => {
  test('W12 labs on：newSession 后 setGroupConfig({modes, judgeAgentId, topic})', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    const created: ChatSession = {
      ...groupRow({ id: 555, title: '攻坚群' })
    } as unknown as ChatSession
    mockNewSession.mockResolvedValue(created)
    renderWorkspace([])
    fireEvent.click(await screen.findByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3))
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[1]) // 调研员
    fireEvent.click(boxes[2]) // 跟进官
    // 勾了人之后：占位仍是「新群聊」（W4 靠它），成员名走下方次级提示。
    expect((screen.getByPlaceholderText('新群聊') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/留空则用：调研员/)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('一句话说明这个群讨论什么'), {
      target: { value: '对齐本周进度' }
    })
    const a1Track = await screen.findByLabelText('调研员 的响应模式')
    fireEvent.click(
      Array.from(a1Track.querySelectorAll('button')).find(
        (b) => b.textContent === '实时'
      ) as HTMLButtonElement
    )
    fireEvent.click(screen.getByRole('combobox', { name: '法官（可选）' }))
    fireEvent.click(await screen.findByRole('option', { name: '跟进官' }))
    fireEvent.click(screen.getByText('创建'))

    await waitFor(() => expect(mockNewSession).toHaveBeenCalledTimes(1))
    expect(mockNewSession).toHaveBeenCalledWith({
      anchorType: 'general',
      backendKind: 'ai-sdk',
      groupMembers: ['a1', 'a2'],
      title: '调研员、跟进官'
    })
    await waitFor(() =>
      expect(mockSetGroupConfig).toHaveBeenCalledWith(555, {
        modes: { a1: 'realtime' },
        judgeAgentId: 'a2',
        topic: '对齐本周进度'
      })
    )
  })

  test('W13 第二步失败 → 删掉第一步建出来的会话（不留半建群）', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    mockNewSession.mockResolvedValue({ ...groupRow({ id: 556 }) } as unknown as ChatSession)
    mockSetGroupConfig.mockRejectedValue(new Error('boom'))
    renderWorkspace([])
    fireEvent.click(await screen.findByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3))
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.change(screen.getByPlaceholderText('一句话说明这个群讨论什么'), {
      target: { value: '有用途就有第二步' }
    })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(mockDeleteSession).toHaveBeenCalledWith(556))
    // 半建群不进列表（回滚了就当没建过）。
    expect(document.querySelector('[data-group-row="556"]')).toBeNull()
  })

  test('W14 labs off 建群：无响应模式、无法官，只 newSession', async () => {
    mockNewSession.mockResolvedValue({ ...groupRow({ id: 557 }) } as unknown as ChatSession)
    renderWorkspace([])
    fireEvent.click(await screen.findByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3))
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(screen.queryByLabelText('调研员 的响应模式')).toBeNull()
    expect(screen.queryByRole('combobox', { name: '法官（可选）' })).toBeNull()
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(mockNewSession).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockSetGroupConfig).not.toHaveBeenCalled()
  })

  test('W15 模板入口禁用且说明什么时候接入', async () => {
    renderWorkspace([])
    fireEvent.click(await screen.findByText('新建群聊'))
    const template = (await screen.findByText('从模板创建')).closest('button') as HTMLButtonElement
    expect(template.disabled).toBe(true)
    expect(screen.getByText('模板在下一批接入（狼人杀预设）')).toBeTruthy()
  })
})
