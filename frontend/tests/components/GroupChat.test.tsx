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
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: { getConfig: mockGetConfig },
    chat: {
      listMessages: mockListMessages,
      newSession: mockNewSession,
      onTurnPersisted: mockOnTurnPersisted
    }
  })
}))

const mockGetLabs = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getLabs: (...args: unknown[]) => mockGetLabs(...args),
  setLabs: vi.fn(),
  getGroupConfig: vi.fn().mockResolvedValue({ modes: {}, config: { v: 1 } }),
  setGroupConfig: vi.fn(),
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
vi.mock('@shared/assistant/groupChatClient', () => ({
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
import { useSessionsSegment } from '@shared/state/sessions-segment'
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
  useSessionsSegment.setState({ segment: 'groups', activeGroupSessionId: null })
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
    <GroupChatWorkspace
      headerSlot={<div data-header-slot />}
      items={items}
      invalidate={vi.fn()}
      narrow={false}
    />,
    { wrapper: makeQcWrapper() }
  )
  return container
}

describe('GroupChatWorkspace', () => {
  test('W1 群列表行：标题 + 成员头像堆叠（≤3，members_json 序）+ 成员数', async () => {
    const container = renderWorkspace([
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
    expect(container.querySelector('[data-header-slot]')).toBeTruthy()
  })

  test('W2 新建群聊弹窗开合 + 候选过滤（只有 chat-capable 成员）', async () => {
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    expect(screen.queryByText('群名')).toBeNull() // 弹窗未开
    fireEvent.click(screen.getByText('新建群聊'))
    await waitFor(() => expect(screen.getByText('群名')).toBeTruthy())
    // 候选 = report + custom（chat-capable）；预处理/搜索/项目周报 + 主 Agent 不入群。
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
    // chat-capable 候选：邮件日报 + 调研员 + 跟进官 + extras = MAX + 3 个（> MAX，够勾满还剩）。
    mockGetConfig.mockResolvedValue([...AGENTS, ...extras])
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    fireEvent.click(screen.getByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(MAX_GROUP_MEMBERS + 3))
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
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3))
    // 反着点（先跟进官后调研员）—— 创建 payload 仍按候选序 [a1, a2]。
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[2]) // 跟进官
    fireEvent.click(boxes[1]) // 调研员
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
    expect(useSessionsSegment.getState().activeGroupSessionId).toBe(555)
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
    // 用户消息先落库，且第一个发言者是成员序第一位 a1。
    expect(mockAppendUser).toHaveBeenCalledWith(300, '大家汇报下')
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
    // 齿轮只在 labs on 时渲染 —— 它出现 = 开关已读到并生效。
    await waitFor(() => expect(screen.getByLabelText('群设置')).toBeTruthy())
  }

  test('V5 发送只 append，不调 runGroupSpeaker（发言循环在服务端）', async () => {
    const container = renderView()
    await waitForLabsOn()
    await sendText(container, '大家汇报下')
    await waitFor(() => expect(mockAppendUser).toHaveBeenCalledWith(300, '大家汇报下'))
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
      <GroupChatWorkspace
        headerSlot={<div data-header-slot />}
        items={[groupRow()]}
        invalidate={vi.fn()}
        narrow={false}
      />,
      { wrapper: makeQcWrapper() }
    )
    const aside = container.querySelector('aside[data-nav-second]') as HTMLElement | null
    expect(aside).not.toBeNull()
    // 宽度来自对话域记忆（默认 336），不是手抄 336。
    expect(aside!.className).toContain('w-[var(--app-second-w,336px)]')
    expect(aside!.style.visibility).not.toBe('hidden')

    const { container: hidden } = render(
      <GroupChatWorkspace
        headerSlot={<div data-header-slot />}
        items={[groupRow()]}
        invalidate={vi.fn()}
        narrow={false}
        navHidden
      />,
      { wrapper: makeQcWrapper() }
    )
    const asideHidden = hidden.querySelector('aside[data-nav-second]') as HTMLElement
    expect(asideHidden.style.width).toBe('0px')
    expect(asideHidden.style.visibility).toBe('hidden')
  })
})
