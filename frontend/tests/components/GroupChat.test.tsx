// @vitest-environment happy-dom
//
// L4 群聊 — GroupChatWorkspace / GroupChatView 冒烟级组件契约（check 复核补测）。
//
// 不追求全覆盖，钉住最会碎的行为：
//   W1 群列表行渲染（标题 + 成员头像堆叠 ≤3 + 成员数）；
//   W2 「新建群聊」弹窗开合 + 候选过滤（只有 chat-capable：preprocess/search/项目周报不入群）；
//   W3 成员多选上限 5 → 第 6 个 checkbox 禁用；
//   W4 创建调用 newSession({groupMembers 按候选序, title}) + 创建后进入群聊视图；
//   V1 历史渲染（用户消息右对齐；speaker_agent_id 分派到正确成员的名字 + 头像）；
//   V2 无 @ 发送 → 成员按 members_json 序**串行**各回一轮（第一个未完成时第二个不发起）；
//   V3 @点名 → 只点名者回；
//   V4 某成员 run 失败 → 该气泡标失败，仍继续下一个成员。
//
// mock 面：useMailApi（listMessages/newSession/report.getConfig）+ groupChatClient
// （appendGroupUserMessage/runGroupSpeaker —— 组件直 import，模块 mock）+ AgentAvatar
// （渲染 data-avatar/data-size 探针，让「头像分派到哪个成员、哪个尺寸档」可断言）。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockGetConfig = vi.fn()
const mockListMessages = vi.fn()
const mockNewSession = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: { getConfig: mockGetConfig },
    chat: { listMessages: mockListMessages, newSession: mockNewSession }
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

  test('W3 成员多选上限 5：勾满 5 个后未勾的 checkbox 禁用', async () => {
    mockGetConfig.mockResolvedValue([
      ...AGENTS,
      cfg('a3', 'custom', { title: '成员三' }),
      cfg('a4', 'custom', { title: '成员四' }),
      cfg('a5', 'custom', { title: '成员五' })
    ]) // chat-capable 候选：邮件日报 + 调研员 + 跟进官 + 三/四/五 = 6 个
    renderWorkspace([])
    await waitFor(() => expect(screen.getByText('新建群聊')).toBeTruthy())
    fireEvent.click(screen.getByText('新建群聊'))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(6))
    const boxes = screen.getAllByRole('checkbox') as HTMLButtonElement[]
    for (let i = 0; i < 5; i++) fireEvent.click(boxes[i])
    await waitFor(() => expect(boxes[5].disabled).toBe(true))
    expect(boxes[4].disabled).toBe(false) // 已勾的仍可反选
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
