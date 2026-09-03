// @vitest-environment happy-dom
//
// T3 — 话题面（GroupThreadPane → GroupChatView 的 thread 模式 → GroupChatWorkspace 右栏互斥）：
//   P1 根消息（父群消息缓存里那条）原样挂在消息流上方 + 说话人名字；话题历史正序渲染在它下面；
//   P2 零回复 → 话题自己的空态文案（不是群的三种空态）；
//   P3 打开即已读：markSessionRead(话题 id) 恰一次（父群那条不在这里）；
//   P4 Esc / 关闭钮 / 「在群里查看」→ onClose；
//   P5 与详情面互斥（工作区）：两键同时为真时画话题面不画详情面；点详情钮 → 收话题开详情；
//      再点名话题（navigateToGroupThread 的写法）→ 收详情开话题；
//   P6 前台上报二元组：群视图报 {groupId, threadId}，话题面自己不报。
//
// mock 面抄 GroupChat.test.tsx（useMailApi / groupSettings / groupChatClient / AgentAvatar），labs off
// 走 v1 路径 —— 话题面要钉的是接线，不是编排。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockGetConfig = vi.fn()
const mockListMessages = vi.fn()
const mockMarkRead = vi.fn(async () => undefined)
const mockSetForeground = vi.fn(
  async (_target: { groupId: number; threadId: number | null } | null) => undefined
)
const mockGetAssistantIdentity = vi.fn()
const mockMailApi = {
  report: { getConfig: mockGetConfig },
  chat: {
    listMessages: mockListMessages,
    newSession: vi.fn(),
    onTurnPersisted: vi.fn(() => () => undefined),
    onGroupTurn: vi.fn(() => () => undefined),
    markSessionRead: mockMarkRead,
    setGroupForeground: mockSetForeground,
    getAssistantIdentity: mockGetAssistantIdentity,
    updateSessionTitle: vi.fn(),
    deleteSession: vi.fn()
  }
}
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => mockMailApi
}))

const mockListGroupThreads = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getLabs: vi.fn().mockResolvedValue({ groupAgents: 'off' }),
  setLabs: vi.fn(),
  getGroupConfig: vi.fn().mockResolvedValue({
    modes: {},
    config: { v: 1 },
    members: ['a1', 'a2'],
    judgeScopeStale: false
  }),
  setGroupConfig: vi.fn(),
  patchGroupMembers: vi.fn(),
  getGroupTurns: vi.fn().mockResolvedValue({ turns: [], hasMore: false }),
  getGroupMetrics: vi.fn().mockResolvedValue({
    silentRunRate: null,
    turnsPerHumanMessage: null,
    last1h: { turns: 0, tokens: 0, costUsd: null },
    last24h: { turns: 0, tokens: 0, costUsd: null },
    lastStopReason: null
  }),
  listGroupThreads: (...args: unknown[]) => mockListGroupThreads(...args),
  createGroupThread: vi.fn()
}))

vi.mock('@shared/assistant/groupChatClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/assistant/groupChatClient')>()),
  appendGroupUserMessage: vi.fn(),
  runGroupSpeaker: vi.fn()
}))

vi.mock('@shared/api/http_client', () => ({ request: vi.fn() }))

vi.mock('@shared/hooks/useLlmModels', () => ({
  useEnabledModels: () => ({ models: ['claude-opus-4-8'], rawEnabled: ['claude-opus-4-8'] }),
  fetchChatConfigModelsProbe: vi.fn().mockResolvedValue({
    enabledModels: ['claude-opus-4-8'],
    providerRegistryEnabled: false,
    kosConsumerEnabled: false,
    kosConfigured: false
  })
}))

vi.mock('../../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string; size?: number; title?: string }) => (
    <span data-avatar={props.agentId} data-size={props.size} title={props.title} />
  )
}))

import i18n from '@shared/i18n'
import type { ChatSession, ChatSessionListItem } from '@shared/api/types'
import type { GroupThreadSummary } from '@shared/chat_model'
import { __resetAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { useGroupsView } from '@shared/state/groups-view'
import { GroupThreadPane } from '../../../src/shared/components/agents/groups/GroupThreadPane'
import { GroupChatWorkspace } from '../../../src/shared/components/agents/groups/GroupChatWorkspace'
import type { GroupMemberMeta } from '../../../src/shared/components/agents/groups/members'

const GATEWAY_PORT_KEY = 'mailagent:aiGatewayPort'

await i18n.changeLanguage('zh-CN')

const GROUP: ChatSession = {
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

const GROUP_ROW: ChatSessionListItem = {
  ...GROUP,
  first_user_message: '大家汇报下',
  message_count: 2,
  email_subject: null,
  email_sender: null
} as ChatSessionListItem

const MEMBER_META = new Map<string, GroupMemberMeta>([
  ['a1', { title: '调研员' }],
  ['a2', { title: '跟进官' }]
])

const THREAD: GroupThreadSummary = {
  sessionId: 900,
  rootMessageId: 2,
  title: '调研进展如下',
  replyCount: 2,
  lastMessage: { role: 'assistant', content: '补充如下', speakerAgentId: 'a2', createdAt: 11 },
  updatedAt: 11,
  unread: false
}

function msg(
  id: number,
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
  speaker: string | null = null
): Record<string, unknown> {
  return {
    id,
    session_id: sessionId,
    role,
    content,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    context_tokens: null,
    speaker_agent_id: speaker,
    created_at: id,
    updated_at: id
  }
}

const GROUP_MESSAGES = [
  msg(1, 300, 'user', '大家汇报下'),
  msg(2, 300, 'assistant', '调研进展如下', 'a1')
]
const THREAD_MESSAGES = [
  msg(10, 900, 'user', '@跟进官 展开说说'),
  msg(11, 900, 'assistant', '补充如下', 'a2')
]

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function renderPane(onClose = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <GroupThreadPane
      groupId={300}
      threadId={900}
      group={GROUP}
      memberMeta={MEMBER_META}
      onClose={onClose}
    />,
    { wrapper: makeQcWrapper() }
  )
  return onClose
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetAssistantIdentity()
  window.sessionStorage.setItem(GATEWAY_PORT_KEY, '8321')
  mockGetConfig.mockResolvedValue([])
  mockGetAssistantIdentity.mockResolvedValue({ name: '小欧', avatar: null })
  mockListGroupThreads.mockResolvedValue([THREAD])
  mockListMessages.mockImplementation(async (sessionId: number) =>
    sessionId === 300 ? GROUP_MESSAGES : sessionId === 900 ? THREAD_MESSAGES : []
  )
  useGroupsView.setState({
    activeGroupSessionId: null,
    detailsOpenBySession: {},
    activeThreadBySession: {}
  })
})

afterEach(() => {
  cleanup()
})

describe('GroupThreadPane', () => {
  test('P1 根消息挂在消息流上方（带说话人名字）；话题历史在它下面正序渲染', async () => {
    renderPane()
    const pane = (await waitFor(() => {
      const el = document.querySelector('[data-group-thread-pane="900"]')
      expect(el).toBeTruthy()
      return el
    })) as HTMLElement
    // 根消息块：父群第 2 条 + 说话人「调研员」。
    const rootBlock = (await waitFor(() => {
      const el = pane.querySelector('[data-thread-root="2"]')
      expect(el).toBeTruthy()
      return el
    })) as HTMLElement
    expect(rootBlock.textContent).toContain('调研进展如下')
    expect(rootBlock.textContent).toContain('调研员')
    expect(rootBlock.querySelector('[data-avatar="a1"]')).toBeTruthy()
    // 话题历史：两条按序在 transcript 里（根消息不在 transcript 里）。
    const transcript = (await waitFor(() => {
      const el = pane.querySelector('[data-group-transcript]')
      expect(el?.textContent).toContain('补充如下')
      return el
    })) as HTMLElement
    expect(transcript.textContent).toContain('展开说说')
    expect(transcript.textContent).not.toContain('调研进展如下')
    expect(
      transcript.textContent!.indexOf('展开说说') < transcript.textContent!.indexOf('补充如下')
    ).toBe(true)
    // 群头是「话题」+ 摘要，不是群名。
    expect(screen.getByText('话题')).toBeTruthy()
    expect(pane.textContent).not.toContain('项目对齐群')
  })

  test('P2 零回复 → 话题空态', async () => {
    mockListMessages.mockImplementation(async (sessionId: number) =>
      sessionId === 300 ? GROUP_MESSAGES : []
    )
    renderPane()
    await waitFor(() => expect(screen.getByText('还没有回复，@ 一位成员开始讨论')).toBeTruthy())
  })

  test('P3 打开即已读：markSessionRead(900) 恰一次', async () => {
    renderPane()
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(900))
    await new Promise((r) => setTimeout(r, 30))
    expect(mockMarkRead).toHaveBeenCalledTimes(1)
  })

  test('P4 Esc / 关闭钮 / 「在群里查看」→ onClose', async () => {
    const onClose = renderPane()
    await waitFor(() => expect(document.querySelector('[data-thread-root="2"]')).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('关闭话题'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByText('在群里查看'))
    expect(onClose).toHaveBeenCalledTimes(3)
    // 已被 preventDefault 的 Esc（composer 的 @ 弹层在用）不关面。
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    ev.preventDefault()
    document.dispatchEvent(ev)
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('GroupChatWorkspace — 话题面与详情面互斥', () => {
  function renderWorkspace(): void {
    render(<GroupChatWorkspace items={[GROUP_ROW]} invalidate={vi.fn()} narrow={false} />, {
      wrapper: makeQcWrapper()
    })
  }

  test('P5 两键同时为真 → 话题面顶掉详情面；点详情钮收话题开详情；再点名话题收详情开话题', async () => {
    useGroupsView.setState({
      activeGroupSessionId: 300,
      detailsOpenBySession: { 300: true },
      activeThreadBySession: { 300: 900 }
    })
    renderWorkspace()
    await waitFor(() =>
      expect(document.querySelector('[data-group-thread-pane="900"]')).toBeTruthy()
    )
    expect(document.querySelector('[data-group-details]')).toBeNull()

    // 群头的详情钮（话题面的群头没有它 → 只有这一颗）。
    fireEvent.click(screen.getByLabelText('群详情'))
    await waitFor(() => expect(document.querySelector('[data-group-details="300"]')).toBeTruthy())
    expect(document.querySelector('[data-group-thread-pane]')).toBeNull()
    expect(useGroupsView.getState().activeThreadBySession[300]).toBeNull()
    expect(useGroupsView.getState().detailsOpenBySession[300]).toBe(true)

    // 通知直达 / 点卡的写法：只点名话题，不碰详情键 —— 派生规则让话题面照样顶上。
    act(() => {
      useGroupsView.getState().setActiveThread(300, 900)
    })
    await waitFor(() =>
      expect(document.querySelector('[data-group-thread-pane="900"]')).toBeTruthy()
    )
    expect(document.querySelector('[data-group-details]')).toBeNull()
  })

  test('P6 前台上报二元组：群视图报 {300, 900}，话题面自己不报', async () => {
    useGroupsView.setState({ activeGroupSessionId: 300, activeThreadBySession: { 300: 900 } })
    renderWorkspace()
    await waitFor(() =>
      expect(document.querySelector('[data-group-thread-pane="900"]')).toBeTruthy()
    )
    await waitFor(() =>
      expect(mockSetForeground).toHaveBeenCalledWith({ groupId: 300, threadId: 900 })
    )
    expect(mockSetForeground.mock.calls.some((c) => c[0]?.groupId === 900)).toBe(false)
  })
})
