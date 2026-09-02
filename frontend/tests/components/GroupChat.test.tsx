// @vitest-environment happy-dom
//
// L4 群聊 — GroupChatWorkspace / GroupChatView 冒烟级组件契约（check 复核补测）。
//
// 不追求全覆盖，钉住最会碎的行为：
//   W1 群列表行渲染（标题 + 成员头像堆叠 ≤3 + 成员数）；
//   W2 「新建群聊」弹窗开合 + 候选过滤（只有 chat-capable：preprocess/search/项目周报不入群）；
//   W3 成员多选上限 MAX_GROUP_MEMBERS → 第 MAX+1 个 checkbox 禁用；
//   W4 创建调用 newSession({groupMembers 按候选序, title}) + 创建后进入群聊视图；
//   W5/W6 拿不到本地 gateway（端口缺席 / web 构建的空串基址）→ 建群入口禁用 + 说明为什么；
//   V1 历史渲染（用户消息右对齐；speaker_agent_id 分派到正确成员的名字 + 头像）；
//   V1b 主 Agent 成员（保留 id `main`）的名字与头像走 assistant identity；
//   V2 无 @ 发送 → 成员按 members_json 序**串行**各回一轮（第一个未完成时第二个不发起）；
//   V3 @点名 → 只点名者回；
//   V4 某成员 run 失败 → 该气泡标失败，仍继续下一个成员。
//   ── g1 labs on（服务端编排）──
//   V5 发送只 append，**不**调 runGroupSpeaker（发言循环在服务端）；
//   V6 `chat:turn-persisted` 广播（本群）→ 重新拉 transcript；
//   V7 停止按钮 → POST /api/ai/run/stop。
//
// 🔴 V2/V3/V4 是 labs off 的 v1 回归钉（AC9），随 g1 一字未改。
//
// mock 面：useMailApi（listMessages/newSession/onTurnPersisted/report.getConfig）+ groupChatClient
// （appendGroupUserMessage/runGroupSpeaker —— 组件直 import，模块 mock）+ groupSettings
// （labs / 群设置的 serve-api 客户端）+ AgentAvatar（渲染 data-avatar/data-size 探针，让
// 「头像分派到哪个成员、哪个尺寸档」可断言）。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockGetConfig = vi.fn()
const mockListMessages = vi.fn()
const mockNewSession = vi.fn()
const mockOnTurnPersisted = vi.fn()
// UX 批：群视图新接的三个 ChatApi 面（事件订阅 / 已读水位 / 前台上报）。
const mockOnGroupTurn = vi.fn()
const mockMarkRead = vi.fn(async () => undefined)
const mockSetForeground = vi.fn(async () => undefined)
// 🔴 同一个对象：真 useMailApi 返回稳定实例，视图的 effect 把 mailApi 放进 deps；每次 render
// 造新对象会让「选中即已读」「订阅事件」这类 effect 每帧重跑，V21 的计数就失真。
const mockGetAssistantIdentity = vi.fn()
const mockMailApi = {
  report: { getConfig: mockGetConfig },
  chat: {
    listMessages: mockListMessages,
    newSession: mockNewSession,
    onTurnPersisted: mockOnTurnPersisted,
    onGroupTurn: mockOnGroupTurn,
    markSessionRead: mockMarkRead,
    setGroupForeground: mockSetForeground,
    getAssistantIdentity: mockGetAssistantIdentity
  }
}
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => mockMailApi
}))

const mockGetLabs = vi.fn()
const mockGetGroupTurns = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getLabs: (...args: unknown[]) => mockGetLabs(...args),
  setLabs: vi.fn(),
  getGroupConfig: vi.fn().mockResolvedValue({ modes: {}, config: { v: 1 } }),
  setGroupConfig: vi.fn(),
  getGroupTurns: (...args: unknown[]) => mockGetGroupTurns(...args),
  getGroupMetrics: vi.fn().mockResolvedValue({
    silentRunRate: null,
    turnsPerHumanMessage: null,
    last1h: { turns: 0, tokens: 0, costUsd: null },
    last24h: { turns: 0, tokens: 0, costUsd: null },
    lastStopReason: null
  })
}))

const mockAppendUser = vi.fn()
const mockRunSpeaker = vi.fn()
// probeGroupRun / retryGroupTurn 保留真实现：它们只是 fetch 的薄封装，用例经 vi.stubGlobal('fetch') 桩。
vi.mock('@shared/assistant/groupChatClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/assistant/groupChatClient')>()),
  appendGroupUserMessage: (...args: unknown[]) => mockAppendUser(...args),
  runGroupSpeaker: (...args: unknown[]) => mockRunSpeaker(...args)
}))

// AgentAvatar 探针桩：真组件拖 bot-avatar 渲染链，这里只需要「谁的头像、哪个尺寸」。
vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string; size?: number; title?: string }) => (
    <span data-avatar={props.agentId} data-size={props.size} title={props.title} />
  )
}))

import i18n from '@shared/i18n'
import type { ChatSession, ChatSessionListItem, ReportAgentConfig } from '@shared/api/types'
import { __resetAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { useGroupsView } from '@shared/state/groups-view'
import { GroupChatWorkspace } from '../../src/shared/components/agents/groups/GroupChatWorkspace'
import { GroupChatView } from '../../src/shared/components/agents/groups/GroupChatView'
import type { GroupMemberMeta } from '../../src/shared/components/agents/groups/members'
import { MAX_GROUP_MEMBERS } from '../../src/ai-gateway/groupFloors'

/** renderer 认 gateway 的口子（sessionStorage stash，见 assistant/runtime/flags.ts）。 */
const GATEWAY_PORT_KEY = 'mailagent:aiGatewayPort'

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
  cfg('a1', 'custom', { title: '调研员' }),
  cfg('a2', 'custom', { title: '跟进官' })
]

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
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    origin: 'group',
    members_json: '["a1","a2"]',
    first_user_message: '大家好',
    message_count: 2,
    email_subject: null,
    email_sender: null,
    ...over
  } as ChatSessionListItem
}

const VIEW_SESSION: ChatSession = {
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

const MEMBER_META = new Map<string, GroupMemberMeta>([
  ['a1', { title: '调研员' }],
  ['a2', { title: '跟进官' }]
])

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function msg(
  id: number,
  role: 'user' | 'assistant',
  content: string,
  speaker: string | null = null
): Record<string, unknown> {
  return {
    id,
    session_id: 300,
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

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  // 模块级缓存（TTL 60s）跨用例存活 —— 不清就只有第一条用例真的走一次取。
  __resetAssistantIdentity()
  useGroupsView.setState({ activeGroupSessionId: null })
  mockGetAssistantIdentity.mockResolvedValue({ name: '小欧', avatar: null })
  mockGetConfig.mockResolvedValue(AGENTS)
  mockListMessages.mockResolvedValue([])
  mockAppendUser.mockResolvedValue(1)
  mockRunSpeaker.mockResolvedValue({ messageId: 2, content: 'ok' })
  // 默认 = 桌面（有 gateway）+ labs off，即 v1 路径；labs on 的用例各自覆写。
  window.sessionStorage.setItem(GATEWAY_PORT_KEY, '8321')
  mockGetLabs.mockResolvedValue({ groupAgents: 'off' })
  mockOnTurnPersisted.mockReturnValue(() => undefined)
})

function renderWorkspace(items: ChatSessionListItem[] = [groupRow()]): HTMLElement {
  const { container } = render(
    <GroupChatWorkspace items={items} invalidate={vi.fn()} narrow={false} />,
    { wrapper: makeQcWrapper() }
  )
  return container
}

describe('GroupChatWorkspace', () => {
  test('W1 群列表行：标题 + 成员头像堆叠（≤3，members_json 序）+ 成员数', async () => {
    renderWorkspace([
      groupRow(),
      groupRow({ id: 301, title: '四人群', members_json: '["a1","a2","x3","x4"]' })
    ])
    await waitFor(() => expect(screen.getByText('项目对齐群')).toBeTruthy())
    expect(screen.getByText('四人群')).toBeTruthy()
    // 两人群：a1 + a2 各一个 20px 头像。
    const row1 = screen.getByText('项目对齐群').closest('button') as HTMLElement
    expect(row1.querySelectorAll('[data-avatar]')).toHaveLength(2)
    expect(row1.querySelector('[data-avatar="a1"]')).toBeTruthy()
    // 四人群：堆叠截断到 3。
    const row2 = screen.getByText('四人群').closest('button') as HTMLElement
    expect(row2.querySelectorAll('[data-avatar]')).toHaveLength(3)
    // 成员数文案（memberCount，两行各自的数字）。
    expect(screen.getByText('2 名成员')).toBeTruthy()
    expect(screen.getByText('4 名成员')).toBeTruthy()
  })

  test('W2 新建群聊弹窗开合 + 候选过滤（只有 chat-capable 成员）', async () => {
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    expect(screen.queryByText('群名')).toBeNull() // 弹窗未开
    fireEvent.click(screen.getByText('新建群聊'))
    await waitFor(() => expect(screen.getByText('群名')).toBeTruthy())
    // 候选 = 主 Agent + report + custom（chat-capable）；预处理/搜索/项目周报不入群。
    await waitFor(() => expect(screen.getByText('小欧')).toBeTruthy())
    expect(screen.getByText('邮件日报')).toBeTruthy()
    expect(screen.getByText('调研员')).toBeTruthy()
    expect(screen.getByText('跟进官')).toBeTruthy()
    expect(screen.queryByText('AI 邮件预处理')).toBeNull()
    expect(screen.queryByText('搜索 Agent')).toBeNull()
    expect(screen.queryByText('项目周报同步')).toBeNull()
    // 关闭（取消按钮）。
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByText('群名')).toBeNull())
  })

  test('W3 成员多选上限 = MAX_GROUP_MEMBERS：勾满后未勾的 checkbox 禁用', async () => {
    // 🔴 上限不写死在用例里：它是 groupFloors.ts 的常量（跨语言闸盯着 TS / Python / SQL CHECK
    // 三处），写死 8 会让「改了常量但忘了改 UI」这类漂移在这条用例上仍然绿。
    const extras = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) =>
      cfg(`x${i}`, 'custom', { title: `成员${i}` })
    )
    // 候选：主 Agent + 邮件日报 + 调研员 + 跟进官 + extras = MAX + 4 个（> MAX，够勾满还剩）。
    mockGetConfig.mockResolvedValue([...AGENTS, ...extras])
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    fireEvent.click(screen.getByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(MAX_GROUP_MEMBERS + 4))
    const boxes = screen.getAllByRole('checkbox') as HTMLButtonElement[]
    for (let i = 0; i < MAX_GROUP_MEMBERS; i++) fireEvent.click(boxes[i])
    await waitFor(() => expect(boxes[MAX_GROUP_MEMBERS].disabled).toBe(true))
    expect(boxes[MAX_GROUP_MEMBERS - 1].disabled).toBe(false) // 已勾的仍可反选
  })

  test('W4 创建：newSession({groupMembers 按候选序, title}) + 创建后进入群聊视图', async () => {
    const created: ChatSession = { ...VIEW_SESSION, id: 555, title: '攻坚群' }
    mockNewSession.mockResolvedValue(created)
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    fireEvent.click(screen.getByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(4))
    // 反着点（先跟进官后调研员）—— 创建 payload 仍按候选序 [a1, a2]。
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[3]) // 跟进官
    fireEvent.click(boxes[2]) // 调研员
    fireEvent.change(screen.getByPlaceholderText('新群聊'), { target: { value: '攻坚群' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(mockNewSession).toHaveBeenCalledTimes(1))
    expect(mockNewSession).toHaveBeenCalledWith({
      anchorType: 'general',
      backendKind: 'ai-sdk',
      groupMembers: ['a1', 'a2'],
      title: '攻坚群'
    })
    // 创建后：draft 会话被选中 → 右侧群聊视图挂载。
    await waitFor(() => expect(document.querySelector('[data-group-chat="555"]')).toBeTruthy())
    expect(useGroupsView.getState().activeGroupSessionId).toBe(555)
  })

  test('W5 拿不到本地 gateway（web）：建群入口禁用并说明原因', async () => {
    // 群聊发言链路走本地 gateway，web 上恒 E_UNSUPPORTED —— 建群不该在那里放行。
    window.sessionStorage.removeItem(GATEWAY_PORT_KEY)
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    const button = screen.getByText('新建群聊').closest('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/远程网页版建不了群/)).toBeTruthy()
    // 点了也开不出弹窗。
    fireEvent.click(button)
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByText('群名')).toBeNull()
  })

  test('W6 web 构建（gateway 基址是空串，不是 null）同样禁用建群', async () => {
    // 🔴 这条钉的是判据本身：resolveAiGatewayBaseUrl 在 web 构建下返回**空串**（同源代理语义），
    // 用 `!= null` 判「有没有 gateway」会在 web 上放行建群 —— 正好漏掉要堵的那个洞。
    window.sessionStorage.removeItem(GATEWAY_PORT_KEY)
    const previous = process.env.VITE_BUILD_TARGET
    process.env.VITE_BUILD_TARGET = 'web'
    try {
      renderWorkspace([])
      await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
      const button = screen.getByText('新建群聊').closest('button') as HTMLButtonElement
      expect(button.disabled).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.VITE_BUILD_TARGET
      else process.env.VITE_BUILD_TARGET = previous
    }
  })
})

function renderView(): HTMLElement {
  const { container } = render(
    <GroupChatView session={VIEW_SESSION} memberMeta={MEMBER_META} onActivity={vi.fn()} />,
    { wrapper: makeQcWrapper() }
  )
  return container
}

async function sendText(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.click(screen.getByLabelText('发送'))
}

describe('GroupChatView', () => {
  test('V1 历史渲染：用户消息右对齐；speaker_agent_id 分派到正确成员的名字与头像', async () => {
    mockListMessages.mockResolvedValue([
      msg(1, 'user', '大家汇报下'),
      msg(2, 'assistant', '调研进展如下', 'a1'),
      msg(3, 'assistant', '我的跟进结论', 'a2')
    ])
    renderView()
    await waitFor(() => expect(screen.getByText('调研进展如下')).toBeTruthy())
    // 用户气泡右对齐（self-end 容器）。
    expect(screen.getByText('大家汇报下').closest('.self-end')).toBeTruthy()
    // a1 的气泡：名字是「调研员」（气泡的前一个兄弟 = 名字行），头像探针 data-avatar=a1 且是 30 档。
    const a1Bubble = screen.getByText('调研进展如下')
    expect(a1Bubble.previousElementSibling?.textContent).toBe('调研员')
    const a1Row = a1Bubble.closest('.flex.max-w-\\[86\\%\\]') as HTMLElement
    expect(a1Row.querySelector('[data-avatar="a1"][data-size="30"]')).toBeTruthy()
    // a2 的气泡分派到「跟进官」。
    expect(screen.getByText('我的跟进结论').previousElementSibling?.textContent).toBe('跟进官')
  })

  test('V1b 主 Agent 成员的气泡：名字与头像走 assistant identity，不是裸的保留 id', async () => {
    // 经工作区渲染（而不是直接给 GroupChatView 塞一份含 main 的 memberMeta）：要钉的正是
    // 「workspace 把主 Agent 拼进 memberMeta」这一段接线 —— 手写的 meta 会让它恒绿。
    mockListMessages.mockResolvedValue([msg(2, 'assistant', '我来汇总一下', 'main')])
    renderWorkspace([groupRow({ members_json: '["main","a1"]' })])
    fireEvent.click(await screen.findByText('项目对齐群'))
    const bubble = await screen.findByText('我来汇总一下')
    await waitFor(() => expect(bubble.previousElementSibling?.textContent).toBe('小欧'))
    const row = bubble.closest('.flex.max-w-\\[86\\%\\]') as HTMLElement
    expect(row.querySelector('[data-avatar="main"][data-size="30"]')).toBeTruthy()
  })

  test('V2 无 @ 发送：先落用户消息，成员按 members_json 序串行各回一轮', async () => {
    let resolveFirst!: () => void
    mockRunSpeaker
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = () => res({ messageId: 11, content: 'A 说完了' })
          })
      )
      .mockImplementationOnce(() => Promise.resolve({ messageId: 12, content: 'B 说完了' }))
    const container = renderView()
    await sendText(container, '大家汇报下')
    await waitFor(() => expect(mockRunSpeaker).toHaveBeenCalledTimes(1))
    // 用户消息先落库（T2 起第三参恒是附件数组，无附件 = 空数组），且第一个发言者是成员序第一位 a1。
    expect(mockAppendUser).toHaveBeenCalledWith(300, '大家汇报下', [])
    expect(mockRunSpeaker.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 300,
      speakAsAgentId: 'a1'
    })
    // 串行：a1 未完成期间 a2 绝不发起。
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRunSpeaker).toHaveBeenCalledTimes(1)
    resolveFirst()
    await waitFor(() => expect(mockRunSpeaker).toHaveBeenCalledTimes(2))
    expect(mockRunSpeaker.mock.calls[1]?.[0]).toMatchObject({ speakAsAgentId: 'a2' })
  })

  test('V3 @点名：只有被点名的成员回复', async () => {
    const container = renderView()
    await sendText(container, '@跟进官 你说说')
    await waitFor(() => expect(mockAppendUser).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockRunSpeaker).toHaveBeenCalledTimes(1))
    // 等一拍确认没有第二个 speaker 被追加。
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRunSpeaker).toHaveBeenCalledTimes(1)
    expect(mockRunSpeaker.mock.calls[0]?.[0]).toMatchObject({ speakAsAgentId: 'a2' })
  })

  test('V4 某成员 run 失败：该气泡标失败，仍继续下一个成员', async () => {
    mockRunSpeaker
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve({ messageId: 12, content: 'B 说完了' }))
    const container = renderView()
    await sendText(container, '大家汇报下')
    await waitFor(() => expect(mockRunSpeaker).toHaveBeenCalledTimes(2))
    // 失败气泡标失败（speakerFailed 文案含错误信息），且落在 a1 名下。
    await waitFor(() => expect(screen.getByText(/本条回复失败.*boom/)).toBeTruthy())
    // 第二个成员照常发言。
    expect(mockRunSpeaker.mock.calls[1]?.[0]).toMatchObject({ speakAsAgentId: 'a2' })
  })
})

describe('GroupChatView（labs on：服务端编排）', () => {
  // gateway 的两个探针端点（/run/active、/run/stop）由组件直 fetch —— 桩掉全局 fetch，
  // 默认「没人在发言」，需要发言态的用例各自覆写。
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ active: false }) })
    vi.stubGlobal('fetch', mockFetch)
  })

  const waitForLabsOn = async (): Promise<void> => {
    // 根元素的 data-group-mode 只在 labs 读到后才有值 —— "orchestrated" 出现 = 开关已读到并生效。
    await waitFor(() =>
      expect(document.querySelector('[data-group-mode="orchestrated"]')).toBeTruthy()
    )
  }

  test('V5 发送只 append，不调 runGroupSpeaker（发言循环在服务端）', async () => {
    const container = renderView()
    await waitForLabsOn()
    await sendText(container, '大家汇报下')
    await waitFor(() => expect(mockAppendUser).toHaveBeenCalledWith(300, '大家汇报下', []))
    // 等一拍确认 renderer 没有自己起发言循环。
    await new Promise((r) => setTimeout(r, 30))
    expect(mockRunSpeaker).not.toHaveBeenCalled()
  })

  test('V6 本群的 turn-persisted 广播 → 重新拉 transcript（别群的不动）', async () => {
    renderView()
    await waitForLabsOn()
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledTimes(1))
    const handler = mockOnTurnPersisted.mock.calls[0]?.[0] as (p: {
      sessionId: number
      status: string
      runId: string | null
    }) => void
    expect(typeof handler).toBe('function')
    // 别的会话：不刷本群。
    handler({ sessionId: 999, status: 'finished', runId: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(mockListMessages).toHaveBeenCalledTimes(1)
    // 本群：invalidate → refetch。
    handler({ sessionId: 300, status: 'finished', runId: null })
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledTimes(2))
  })

  test('V7 有人在发言时出现停止按钮 → POST /api/ai/run/stop', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/run/active')
          ? { ok: true, json: async () => ({ active: true, runId: 'r1', ageMs: 10 }) }
          : { ok: true, json: async () => ({ stopped: true }) }
      )
    )
    renderView()
    await waitForLabsOn()
    const stopButton = await waitFor(() => screen.getByLabelText('停止本轮'))
    fireEvent.click(stopButton)
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(
          (call) =>
            String(call[0]).endsWith('/api/ai/run/stop') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        )
      ).toBe(true)
    )
  })

  test('V8 地板命中的 system 行渲染成「已停止：<原因>」', async () => {
    mockListMessages.mockResolvedValue([
      msg(1, 'user', '大家汇报下'),
      {
        ...msg(2, 'assistant', '收到', 'a1'),
        id: 3,
        role: 'system',
        content: '',
        metadata: JSON.stringify({ kind: 'group_stop', reason: 'chain_cap', runId: 'r1' }),
        speaker_agent_id: null
      }
    ])
    renderView()
    await waitFor(() => expect(screen.getByText(/已停止：这条对话链已达唤醒上限/)).toBeTruthy())
  })
})

describe('GroupChatWorkspace — 二级栏契约（09-01 侧栏批）', () => {
  test('W6 清单列读 --app-second-w 且 navHidden 时整列隐藏（与 AgentThreadList 同契约）', () => {
    const { container } = render(
      <GroupChatWorkspace items={[groupRow()]} invalidate={vi.fn()} narrow={false} />,
      { wrapper: makeQcWrapper() }
    )
    const aside = container.querySelector('aside[data-nav-second]') as HTMLElement | null
    expect(aside).not.toBeNull()
    // 宽度来自对话域记忆（默认 336），不是手抄 336。
    expect(aside!.className).toContain('w-[var(--app-second-w,336px)]')
    expect(aside!.style.visibility).not.toBe('hidden')

    const { container: hidden } = render(
      <GroupChatWorkspace items={[groupRow()]} invalidate={vi.fn()} narrow={false} navHidden />,
      { wrapper: makeQcWrapper() }
    )
    const asideHidden = hidden.querySelector('aside[data-nav-second]') as HTMLElement
    expect(asideHidden.style.width).toBe('0px')
    expect(asideHidden.style.visibility).toBe('hidden')
  })
})

// ── L4 群聊 UX 批（lane C）：事件驱动的在场态 / 台账还原 / 重试 / composer ──────────────────
//
//   V9  labs 未 resolve 时点发送不分派；resolve 为 on 只 append、为 off 才起 v1 循环；
//   V10 start → 「A 正在输入…」；delta → live 气泡含累计文本；spoke + refetch → 落库气泡替换不重复；
//   V11 silent → meta 行且无气泡；V12 failed → 重试钮 → POST retry{agentId, chainId}；
//       409 E_RUN_STOPPED → 禁用 + retryStopped；E_LABS_ORCHESTRATED → retryOrchestratedOnly；
//   V13 探针 group.preparing 且无租约 → 停止钮；V14 no_candidates 事件行 + 台账推导行；
//   V15 markdown 渲染 <strong>；V16 owner 消息 @ chip 带成员色；V17 刷新还原四条 meta 文案；
//   V18 @ 弹层键盘；V19 「将唤醒 N 位」；V20 探针不可达 / web 说明条 + composer 禁用；
//   V21 选中即 markSessionRead；V22 labs off 不订阅事件；V23 无消息不请求台账。

import { act } from '@testing-library/react'
import type { GroupTurnEvent } from '../../src/ai-gateway/groupTurnEvent'

function turnEvent(
  over: Partial<GroupTurnEvent> & { phase: GroupTurnEvent['phase'] }
): GroupTurnEvent {
  return {
    v: 1,
    sessionId: 300,
    runId: 'r1',
    chainId: 1,
    seq: 1,
    agentId: 'a1',
    ts: Date.now(),
    queued: [],
    chainProgress: { counted: 1, cap: 12 },
    ...over
  }
}

function groupTurn(
  over: Partial<{
    id: number
    runId: string
    chainId: number
    seq: number
    agentId: string
    outcome: string
    error: string | null
    startedAt: number
  }>
): Record<string, unknown> {
  return {
    id: 1,
    runId: 'r1',
    chainId: 1,
    seq: 1,
    agentId: 'a1',
    triggerKind: 'human',
    outcome: 'silent',
    messageId: null,
    model: null,
    tokensInput: null,
    tokensOutput: null,
    costUsd: null,
    error: null,
    startedAt: 2,
    finishedAt: null,
    ...over
  }
}

describe('GroupChatView（UX 批：事件 / 台账 / 重试 / composer）', () => {
  const mockFetch = vi.fn()
  let turnHandlers: Array<(e: unknown) => void> = []

  const okJson = (body: unknown) => ({ ok: true, json: async () => body })
  const routeFetch = (
    groupChat: () => unknown,
    runActive: () => unknown = () => okJson({ active: false })
  ) =>
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/run/active') ? runActive() : groupChat())
    )

  beforeEach(() => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(okJson({ active: false }))
    vi.stubGlobal('fetch', mockFetch)
    turnHandlers = []
    mockOnGroupTurn.mockImplementation((h: (e: unknown) => void) => {
      turnHandlers.push(h)
      return () => {
        turnHandlers = turnHandlers.filter((x) => x !== h)
      }
    })
    mockGetGroupTurns.mockResolvedValue({ turns: [], hasMore: false })
  })

  const emit = (over: Partial<GroupTurnEvent> & { phase: GroupTurnEvent['phase'] }): void => {
    act(() => {
      for (const h of turnHandlers) h(turnEvent(over))
    })
  }
  const waitForOn = (): Promise<void> =>
    waitFor(() => expect(document.querySelector('[data-group-mode="orchestrated"]')).toBeTruthy())
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

  test('V9 labs 未 resolve 时点发送 → 不分派；resolve 为 on → 只 appendUser', async () => {
    let resolveLabs!: (v: { groupAgents: 'on' | 'off' }) => void
    mockGetLabs.mockReset()
    mockGetLabs.mockImplementation(() => new Promise((res) => (resolveLabs = res)))
    const container = renderView()
    await sendText(container, '大家汇报下')
    await tick()
    expect(mockAppendUser).not.toHaveBeenCalled()
    expect(mockRunSpeaker).not.toHaveBeenCalled()
    resolveLabs({ groupAgents: 'on' })
    await waitFor(() => expect(mockAppendUser).toHaveBeenCalledWith(300, '大家汇报下', []))
    await tick()
    expect(mockRunSpeaker).not.toHaveBeenCalled()
  })

  test('V9b labs 未 resolve 时点发送；resolve 为 off → runSpeaker（v1 循环）', async () => {
    let resolveLabs!: (v: { groupAgents: 'on' | 'off' }) => void
    mockGetLabs.mockReset()
    mockGetLabs.mockImplementation(() => new Promise((res) => (resolveLabs = res)))
    const container = renderView()
    await sendText(container, '大家汇报下')
    await tick()
    expect(mockRunSpeaker).not.toHaveBeenCalled()
    resolveLabs({ groupAgents: 'off' })
    // 无 @ → v1 循环按成员序各回一轮（a1 → a2），与 V2 同一路径。
    await waitFor(() => expect(mockRunSpeaker).toHaveBeenCalledTimes(2))
    expect(mockRunSpeaker.mock.calls[0]?.[0]).toMatchObject({ speakAsAgentId: 'a1' })
    expect(mockRunSpeaker.mock.calls[1]?.[0]).toMatchObject({ speakAsAgentId: 'a2' })
  })

  test('V10 start → 正在输入；delta → 累计正文；spoke + refetch → 落库气泡替换、不重复', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '大家汇报下')])
    renderView()
    await waitForOn()
    await waitFor(() => expect(screen.getByText('大家汇报下')).toBeTruthy())
    emit({ phase: 'start' })
    // T2：start（尚无正文）→ 在场行 connecting；有正文后转 writing（都在 turn-presence 那一行）。
    await waitFor(() => expect(screen.getByText('正在连接…')).toBeTruthy())
    emit({ phase: 'delta', text: '调研进' })
    await waitFor(() => expect(screen.getByText('调研进')).toBeTruthy())
    expect(screen.getByText('正在回复…')).toBeTruthy()
    emit({ phase: 'delta', text: '调研进展如下' })
    await waitFor(() => expect(screen.getByText('调研进展如下')).toBeTruthy())
    expect(screen.queryByText('调研进')).toBeNull()
    expect(screen.queryByText('正在连接…')).toBeNull()
    // spoke：overlay 顶上；落库行到达后同 messageId 去重 → 仍只有一条。
    mockListMessages.mockResolvedValue([
      msg(1, 'user', '大家汇报下'),
      msg(2, 'assistant', '调研进展如下', 'a1')
    ])
    emit({ phase: 'spoke', text: '调研进展如下', messageId: 2 })
    expect(screen.getAllByText('调研进展如下')).toHaveLength(1)
    const handler = mockOnTurnPersisted.mock.calls[0]?.[0] as (p: unknown) => void
    act(() => handler({ sessionId: 300, status: 'finished', runId: 'r1' }))
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledTimes(2))
    await tick()
    expect(screen.getAllByText('调研进展如下')).toHaveLength(1)
    // 落库气泡挂在 a1 名下（V1 同一 DOM 契约）。
    expect(screen.getByText('调研进展如下').previousElementSibling?.textContent).toBe('调研员')
  })

  test('V11 silent 事件 → meta 行「本轮选择不发言」且无气泡', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '大家汇报下')])
    renderView()
    await waitForOn()
    emit({ phase: 'start' })
    emit({ phase: 'silent', usage: { model: 'm', tokensInput: 1, tokensOutput: 1, costUsd: null } })
    await waitFor(() => expect(screen.getByText('调研员 本轮选择不发言')).toBeTruthy())
    expect(document.querySelector('[data-avatar="a1"][data-size="30"]')).toBeNull()
    // T2：silent 收尾 → 三元组空且最后一条留痕不是 failed → 整条在场行卸载。
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })

  test('V12 failed 事件 → 重试钮 → POST retry{agentId, chainId}；409 E_RUN_STOPPED → 禁用 + retryStopped', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '大家汇报下')])
    routeFetch(() => okJson({ ok: true, queued: true }))
    renderView()
    await waitForOn()
    emit({ phase: 'failed', error: 'boom', chainId: 7 })
    await waitFor(() => expect(screen.getByText(/本轮失败：boom/)).toBeTruthy())
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some((call) => {
          if (!String(call[0]).endsWith('/api/ai/group-chat')) return false
          const body = JSON.parse((call[1] as { body: string }).body) as {
            sessionId: number
            retry?: { agentId: string; chainId: number }
          }
          return body.sessionId === 300 && body.retry?.agentId === 'a1' && body.retry.chainId === 7
        })
      ).toBe(true)
    )
    // 重试中，直到点击之后的第一条事件（requeue 发的 queued）到达。
    expect(screen.getByText('重试中…')).toBeTruthy()
    emit({ phase: 'queued', agentId: null, seq: null, queued: ['a1'], chainId: 7 })
    await waitFor(() => expect(screen.getByText('重试')).toBeTruthy())
    // 该链已被停掉：gateway 409 → 钮禁用 + 人话。
    routeFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'E_RUN_STOPPED', hint: 'chain stopped' })
    }))
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(screen.getByText('本链已停止，发一条新消息继续')).toBeTruthy())
    expect(
      (screen.getByText('本链已停止，发一条新消息继续').closest('button') as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  test('V12b 409 E_LABS_ORCHESTRATED → retryOrchestratedOnly', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '大家汇报下')])
    routeFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'E_LABS_ORCHESTRATED', hint: 'labs off' })
    }))
    renderView()
    await waitForOn()
    emit({ phase: 'failed', error: 'boom' })
    await waitFor(() => expect(screen.getByText('重试')).toBeTruthy())
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(screen.getByText(/重试需要开启/)).toBeTruthy())
  })

  test('V12c failed → 在场行进 error（留痕经 live 传到 GroupThread；身份取自那条留痕）', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '大家汇报下')])
    renderView()
    await waitForOn()
    emit({ phase: 'start' })
    await waitFor(() => expect(screen.getByText('正在连接…')).toBeTruthy())
    // failed 清掉在写者 → 三元组全空。在场者身份只能来自失败留痕，否则整行不画、error 支是死码。
    emit({ phase: 'failed', error: 'boom' })
    await waitFor(() => expect(screen.getByText('响应出错')).toBeTruthy())
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('sad')
    // 终态不挂秒表（走动的读数会读成「还在跑」）。
    expect(screen.queryByTitle('本回合已运行')).toBeNull()
  })

  test('V13 /run/active 返回 group.preparing 且无租约 → 停止钮渲染', async () => {
    routeFetch(
      () => okJson({ ok: true }),
      () =>
        okJson({
          active: true,
          runId: null,
          group: { inFlight: null, preparing: 'a1', queued: [] }
        })
    )
    renderView()
    await waitForOn()
    await waitFor(() => expect(screen.getByLabelText('停止本轮')).toBeTruthy())
    // preparing 的成员进在场行（它已出队、尚未拿到租约）——判据是 group.preparing，不是 active 标志。
    // T2：preparing 归写者半边，文案是 AI Chat 那句「正在连接…」（探针只有种子、无事件，不算静默）。
    await waitFor(() => expect(screen.getByTestId('turn-presence')).toBeTruthy())
    expect(screen.getByText('正在连接…')).toBeTruthy()
  })

  test('V14 no_candidates：事件 → 提示行；刷新后由台账推导（链根零 turn 行且非最后一条）', async () => {
    renderView()
    await waitForOn()
    emit({
      phase: 'no_candidates',
      agentId: null,
      seq: null,
      runId: null,
      chainId: 5,
      reason: 'no_realtime_members'
    })
    await waitFor(() => expect(screen.getByText(/这条消息没有唤醒任何成员/)).toBeTruthy())
    cleanup()
    // 另一例：无事件，两条 user 消息、台账为空 → 第一条下方有该行、第二条（最后一条）没有。
    mockListMessages.mockResolvedValue([msg(1, 'user', '一'), msg(2, 'user', '二')])
    renderView()
    await waitForOn()
    await waitFor(() => expect(screen.getByText('二')).toBeTruthy())
    await waitFor(() => expect(mockGetGroupTurns).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByText(/这条消息没有唤醒任何成员/)).toHaveLength(1))
    const row = screen.getByText(/这条消息没有唤醒任何成员/).closest('div') as HTMLElement
    // 该行紧跟第一条消息组之后、第二条之前。
    const first = screen.getByText('一').closest('.self-end') as HTMLElement
    expect(first.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const second = screen.getByText('二').closest('.self-end') as HTMLElement
    expect(row.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('V15 成员消息 markdown：**粗** 渲染为 strong', async () => {
    mockListMessages.mockResolvedValue([msg(2, 'assistant', '**粗** 正文', 'a1')])
    renderView()
    await waitForOn()
    await waitFor(() => expect(document.querySelector('[data-streamdown="strong"]')).toBeTruthy())
    expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('粗')
  })

  test('V16 owner 消息 @跟进官 → chip 元素带成员色', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '@跟进官 看一下')])
    renderView()
    await waitForOn()
    const chip = await waitFor(() => document.querySelector('[data-mention="a2"]') as HTMLElement)
    expect(chip.textContent).toBe('@跟进官')
    // 成员色按 members_json 序：a2 是第二位 → NAME_COLORS[1]（--c-info）。
    expect(chip.getAttribute('style')).toContain('--c-info')
    expect(document.querySelector('[data-mention="a1"]')).toBeNull()
  })

  test('V17 刷新还原：无事件但台账含 silent + 三种 skipped 行 → 四条不同 meta 文案', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '开始')])
    mockGetGroupTurns.mockResolvedValue({
      turns: [
        groupTurn({
          id: 4,
          seq: 4,
          agentId: 'a2',
          outcome: 'skipped',
          error: 'removed',
          startedAt: 5
        }),
        groupTurn({
          id: 3,
          seq: 3,
          agentId: 'a1',
          outcome: 'skipped',
          error: 'no_new_messages',
          startedAt: 4
        }),
        groupTurn({
          id: 2,
          seq: 2,
          agentId: 'a2',
          outcome: 'skipped',
          error: 'monologue',
          startedAt: 3
        }),
        groupTurn({ id: 1, seq: 1, agentId: 'a1', outcome: 'silent', startedAt: 2 })
      ],
      hasMore: false
    })
    renderView()
    await waitForOn()
    await waitFor(() => expect(screen.getByText('调研员 本轮选择不发言')).toBeTruthy())
    expect(screen.getByText('跟进官 已跳过（上一条就是它说的）')).toBeTruthy()
    expect(screen.getByText('调研员 已跳过（没有新消息可回应）')).toBeTruthy()
    expect(screen.getByText('跟进官 已不在群里，排队项已丢弃')).toBeTruthy()
    // 台账传了 since = 最早消息时间。
    expect(mockGetGroupTurns).toHaveBeenCalledWith(300, expect.objectContaining({ since: 1 }))
  })

  test('V18 composer @ 弹层：首项「所有人」；ArrowDown+Enter 采纳第二项；Esc 关闭；弹层开时 Enter 不发送', async () => {
    const container = renderView()
    await waitForOn()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const options = screen.getAllByRole('option')
    expect(options[0].textContent).toContain('所有人')
    expect(options[1].textContent).toContain('调研员')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe('@调研员 '))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(mockAppendUser).not.toHaveBeenCalled()
    // Esc 关闭。
    fireEvent.change(textarea, { target: { value: '@调研员 @', selectionStart: 6 } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(mockAppendUser).not.toHaveBeenCalled()
  })

  test('V19 「将唤醒 N 位」：@所有人 → N=成员数；无 @ 零 realtime → wakeNone', async () => {
    const container = renderView()
    await waitForOn()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@所有人 开会', selectionStart: 7 } })
    await waitFor(() => expect(screen.getByText('将唤醒 2 位')).toBeTruthy())
    fireEvent.change(textarea, { target: { value: '大家好', selectionStart: 3 } })
    await waitFor(() => expect(screen.getByText(/不会唤醒任何人/)).toBeTruthy())
  })

  test('V20 探针 fetch 抛错 → gatewayUnreachable 说明条 + composer 禁用，历史仍渲染；无 baseUrl → gatewayWebOnly', async () => {
    mockListMessages.mockResolvedValue([msg(1, 'user', '大家汇报下')])
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const container = renderView()
    await waitForOn()
    await waitFor(() => expect(screen.getByText(/本机 AI 服务未连接/)).toBeTruthy())
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText('大家汇报下')).toBeTruthy()
    cleanup()
    window.sessionStorage.removeItem(GATEWAY_PORT_KEY)
    const web = renderView()
    await waitFor(() => expect(screen.getByText(/群聊是桌面功能/)).toBeTruthy())
    expect((web.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true)
  })

  test('V21 选中群 → markSessionRead 被调一次', async () => {
    renderView()
    await waitForOn()
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(300))
    expect(mockMarkRead).toHaveBeenCalledTimes(1)
  })

  test('V22 labs off：不订阅 group-turn 事件源', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'off' })
    renderView()
    await waitFor(() => expect(document.querySelector('[data-group-mode="v1"]')).toBeTruthy())
    await tick()
    expect(mockOnGroupTurn).not.toHaveBeenCalled()
  })

  test('V23 无消息（清空历史后）→ 台账不请求', async () => {
    mockListMessages.mockResolvedValue([])
    renderView()
    await waitForOn()
    await waitFor(() => expect(mockListMessages).toHaveBeenCalled())
    await tick()
    expect(mockGetGroupTurns).not.toHaveBeenCalled()
  })
})

// ── T2 lane K：composer 换内胆（useExternalStoreRuntime 只包 composer 段）──────────────────
//
//   K1 工具条无 controls：只有「+」与发送（没有模型 / skill / 授权 / effort），「+」菜单只剩附件项；
//   K2 粘贴 PNG / 文本文件 → chip；发送 body 带 attachments（图片 text=null、文本带正文）+ 发送后 chip 清空；
//   K3 labs off（v1）发送同样带 attachments；
//   K4 刷新后落库 user 行的 metadata.attachments → 气泡下 chip（文件名 + 大小），附件正文 / 围栏块不进
//      气泡，脏 metadata 不炸不画；
//   K5 条数上限：一次粘贴 GROUP_ATTACHMENTS_MAX + 1 份 → 只收 MAX 份 + toast。
//
// 粘贴的驱动方式抄 tests/shared/assistant/composer_paste_image.test.tsx（createEvent.paste 挂 clipboardData）。

import { createEvent } from '@testing-library/react'
import { GROUP_ATTACHMENTS_MAX } from '@shared/chat_model'
import { useToastStore } from '@shared/state/toast'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngFile(name = 'screenshot.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}

function textFile(name: string, content: string, type = 'text/plain'): File {
  return new File([content], name, { type })
}

function firePaste(el: Element, files: File[]): void {
  const clipboardData = {
    files,
    items: files.map((f) => ({ kind: 'file', type: f.type })),
    types: [],
    getData: () => ''
  }
  fireEvent(el, createEvent.paste(el, { clipboardData }))
}

describe('GroupChatView（T2 lane K：composer 换内胆 / 附件）', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'on' })
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ active: false }) })
    vi.stubGlobal('fetch', mockFetch)
    mockOnGroupTurn.mockReturnValue(() => undefined)
    mockGetGroupTurns.mockResolvedValue({ turns: [], hasMore: false })
    useToastStore.setState({ items: [] })
  })

  const waitForOn = (): Promise<void> =>
    waitFor(() => expect(document.querySelector('[data-group-mode="orchestrated"]')).toBeTruthy())
  const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
    container.querySelector('textarea') as HTMLTextAreaElement

  test('K1 工具条无 controls：只有「+」与发送；「+」菜单只有附件项', async () => {
    const container = renderView()
    await waitForOn()
    const form = container.querySelector('form') as HTMLFormElement
    expect(form).not.toBeNull()
    const labels = Array.from(form.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label')
    )
    expect(labels).toEqual(['添加', '发送'])
    fireEvent.click(screen.getByLabelText('添加'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['添加附件'])
  })

  test('K2 粘贴 PNG + 文本 → chip；发送 body 带 attachments（图片 text=null）；发送后 chip 清空', async () => {
    const container = renderView()
    await waitForOn()
    const textarea = textareaOf(container)
    const png = pngFile()
    firePaste(textarea, [png])
    await waitFor(() => expect(screen.getByText('screenshot.png')).toBeTruthy())
    // 图片只留档的提示随图片 chip 出现。
    expect(screen.getByText(/图片只留档/)).toBeTruthy()
    const txt = textFile('notes.txt', 'hello log')
    firePaste(textarea, [txt])
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy())
    await sendText(container, '看看这两个文件')
    await waitFor(() => expect(mockAppendUser).toHaveBeenCalledTimes(1))
    expect(mockAppendUser).toHaveBeenCalledWith(300, '看看这两个文件', [
      { filename: 'screenshot.png', size: png.size, mimeType: 'image/png', text: null },
      { filename: 'notes.txt', size: txt.size, mimeType: 'text/plain', text: 'hello log' }
    ])
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull())
    expect(screen.queryByText(/图片只留档/)).toBeNull()
  })

  test('K3 labs off（v1）发送同样带 attachments，随后照常起 speaker 循环', async () => {
    mockGetLabs.mockResolvedValue({ groupAgents: 'off' })
    const container = renderView()
    await waitFor(() => expect(document.querySelector('[data-group-mode="v1"]')).toBeTruthy())
    const md = textFile('a.md', '# 标题', 'text/markdown')
    firePaste(textareaOf(container), [md])
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy())
    await sendText(container, '@调研员 看看')
    await waitFor(() =>
      expect(mockAppendUser).toHaveBeenCalledWith(300, '@调研员 看看', [
        { filename: 'a.md', size: md.size, mimeType: 'text/markdown', text: '# 标题' }
      ])
    )
    await waitFor(() => expect(mockRunSpeaker).toHaveBeenCalledTimes(1))
    expect(mockRunSpeaker.mock.calls[0]?.[0]).toMatchObject({ speakAsAgentId: 'a1' })
  })

  test('K4 落库 user 行的 metadata.attachments → 气泡下 chip；正文 / 围栏块不进气泡；脏 metadata 不炸', async () => {
    mockListMessages.mockResolvedValue([
      {
        ...msg(1, 'user', '看看这个'),
        metadata: JSON.stringify({
          attachments: [
            { filename: 'notes.txt', size: 2048, mimeType: 'text/plain', text: 'secret body' },
            { filename: 'x.png', size: 0, mimeType: 'image/png', text: null }
          ]
        })
      },
      { ...msg(2, 'user', '脏的'), metadata: '{"attachments":"nope"' },
      msg(3, 'assistant', '收到', 'a1')
    ])
    renderView()
    await waitForOn()
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy())
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    expect(screen.getByText('x.png')).toBeTruthy()
    // 正文仍是气泡 div 的直接文本（DOM 契约）；附件正文与围栏块都不进气泡。
    const bubble = screen.getByText('看看这个')
    expect(bubble.textContent).toBe('看看这个')
    expect(screen.queryByText(/secret body/)).toBeNull()
    // chip 行是气泡的下一个兄弟，同在右对齐列里；size=0 的那件不写大小。
    const chips = bubble.nextElementSibling as HTMLElement
    expect(chips.hasAttribute('data-group-attachments')).toBe(true)
    expect(chips.closest('.self-end')).toBeTruthy()
    expect(chips.querySelectorAll('span[title]')).toHaveLength(2)
    expect(chips.textContent).toBe('notes.txt2.0 KBx.png')
    // 脏 metadata：不炸、不画；成员气泡没有 chip 行。
    expect(screen.getByText('脏的').nextElementSibling).toBeNull()
    expect(screen.getByText('收到').nextElementSibling).toBeNull()
  })

  test('K5 一次粘贴超过上限 → 只收 GROUP_ATTACHMENTS_MAX 份，超出的 toast', async () => {
    const container = renderView()
    await waitForOn()
    const files = Array.from({ length: GROUP_ATTACHMENTS_MAX + 1 }, (_, i) =>
      textFile(`f${i}.txt`, `${i}`)
    )
    firePaste(textareaOf(container), files)
    await waitFor(() => expect(screen.getByText(`f${GROUP_ATTACHMENTS_MAX - 1}.txt`)).toBeTruthy())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(`f${GROUP_ATTACHMENTS_MAX}.txt`)).toBeNull()
    expect(
      useToastStore.getState().items.some((item) => item.title.includes(`${GROUP_ATTACHMENTS_MAX}`))
    ).toBe(true)
  })
})
