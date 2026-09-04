// @vitest-environment happy-dom
//
// task 09-03 Lane A —— 排队输入接进 AgentConversation（AI Chat 的真场地）。
//
// 0902 那一批只把排队接在 AiChatPanel 上，而那个组件只有 PopoutShell（弹出窗）在用；owner 日常的
// dock / 浮窗 / 标签 / 事项对话全走 AgentConversation → AgentComposer，那条链路上一个 queued 字样
// 都没有 ⇒ 「回答时根本无法发送消息」。本文件钉的是这条链路上的三件事：
//   ① composerControls 带上排队三件套，且 queueModeActive 的判据是「前台在跑 / 后台在跑 / 有待决
//      审批」三选一（composer 据此决定 Enter 与发送键的去向）；
//   ② onEnqueueQueuedInput 真的 POST /api/ai/queued-input；
//   ③ 排队气泡（QueuedInputBar）挂在消息流末尾，且已被信封带走的行按 rowIds 隐去。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import type {
  ChatMessage,
  ChatSession,
  ChatSessionListItem,
  QueuedInput
} from '@shared/api/types'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import i18n from '@shared/i18n'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null
}))

const { stableMailApi, capture } = vi.hoisted(() => ({
  stableMailApi: {
    settings: { secretsStatus: vi.fn(async () => ({ llmApiKey: true })) },
    chat: {
      newSession: vi.fn(),
      markSessionRead: vi.fn(async () => {}),
      onTurnPersisted: vi.fn(() => () => {}),
      onSessionUpdated: vi.fn(() => () => {}),
      onQueuedInputChanged: vi.fn(() => () => {}),
      listMessages: vi.fn(async () => []),
      listGeneralSessions: vi.fn(async (): Promise<ChatSession[]> => []),
      updateSessionModel: vi.fn(async () => {})
    },
    email: {
      get: vi.fn(async (id: number) => ({ internal_id: id, subject: `邮件 ${id}` })),
      body: vi.fn(async () => ({ content: '' }))
    },
    llm: { upstreamModels: vi.fn(async () => []), enabledModels: vi.fn(async () => []) }
  },
  capture: {
    composerControls: null as ChatComposerControls | null,
    queuedBarProps: null as Record<string, unknown> | null,
    onRunningChange: null as ((running: boolean) => void) | null,
    backgroundActive: false
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] }),
  resolveApiBaseUrl: () => ''
}))
vi.mock('@shared/assistant/runtime/AiSdkRuntimeProvider', () => ({
  AiSdkRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
// ThreadRunningBridge：把「前台流在跑」的扳机交给用例（真组件要 runtime 上下文）。
vi.mock('@shared/assistant/runtime/ThreadRunningBridge', () => ({
  ThreadRunningBridge: ({ onRunningChange }: { onRunningChange?: (r: boolean) => void }) => {
    capture.onRunningChange = onRunningChange ?? null
    return null
  }
}))
vi.mock('@shared/assistant/runtime/useBackgroundChatRun', () => ({
  useBackgroundChatRun: () => ({
    backgroundActive: capture.backgroundActive,
    backgroundStartedAt: null
  })
}))
vi.mock('@shared/components/agents/AgentRecordView', () => ({
  AgentRecordConversation: () => <div data-testid="agent-record" />
}))
// 外部指令派发：真组件要 runtime 上下文（本文件把 runtime provider 桩成透传 div）。
vi.mock('@shared/assistant/components/ChatPromptDispatcher', () => ({
  ChatPromptDispatcher: () => null
}))
// AgentThread：只渲染 pendingSlot（本文件关心的就是「排队气泡挂没挂进消息流」）。
vi.mock('@shared/components/agents/AgentThread', () => ({
  AgentThread: ({ pendingSlot }: { pendingSlot?: React.ReactNode }) => (
    <div data-testid="thread">{pendingSlot}</div>
  )
}))
// QueuedInputBar：真组件要 runtime 上下文（useAui），本文件只验它挂在哪、拿到了什么 props。
vi.mock('@shared/assistant/components/QueuedInputBar', () => ({
  QueuedInputBar: (props: Record<string, unknown>) => {
    capture.queuedBarProps = props
    return <div data-testid="queued-input-bar" />
  }
}))
vi.mock('@shared/assistant/components/composerControls', () => ({
  ChatComposerControlsProvider: ({
    value,
    children
  }: {
    value: ChatComposerControls
    children: React.ReactNode
  }) => {
    capture.composerControls = value
    return <>{children}</>
  }
}))
vi.mock('@shared/assistant/context/useAgentContextSnapshot', () => ({
  useAgentContextSnapshot: () => ({ snapshot: null })
}))
vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({}),
  useMatterChatApi: () => ({
    contextSnapshot: vi.fn(async () => {
      throw new Error('not needed')
    }),
    applyUndo: vi.fn(async () => ({}))
  }),
  useMattersEnabled: () => true
}))

const { AgentConversation } = await import('@shared/components/agents/AgentConversation')

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

function generalSession(id: number): ChatSession {
  const now = Date.now()
  return {
    id,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: now,
    updated_at: now
  } as ChatSession
}

function fakeChat(over: Partial<UseGeneralChatReturn> = {}): UseGeneralChatReturn {
  return {
    messages: [],
    error: null,
    activeSessionId: 10,
    messagesSessionId: 10,
    navEpoch: 0,
    sessions: [generalSession(10)],
    clearError: vi.fn(),
    newSession: vi.fn(),
    selectSession: vi.fn(async () => {}),
    adoptSession: vi.fn(),
    deleteSession: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    reloadActiveSession: vi.fn(async () => {}),
    ...over
  }
}

/** 一条带 `<queued_followups>` 信封 metadata 的已落库用户消息（rowIds = 已发出的队列行）。 */
function dispatchedEnvelopeRow(rowIds: number[]): ChatMessage {
  return {
    id: 1,
    session_id: 10,
    role: 'user',
    content: '（信封）',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: JSON.stringify({
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: '（信封）' }],
      metadata: { queuedInputDispatch: { rowIds } }
    }),
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000
  } as ChatMessage
}

function mount(chat: UseGeneralChatReturn = fakeChat()): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AgentConversation chat={chat} activeItem={generalSession(10) as ChatSessionListItem} />
    </QueryClientProvider>
  )
}

let queuedInputPosts: Array<{ sessionId: number; content: string }> = []
/** GET /api/ai/queued-input 的回包（用例按需塞 claimed 行）。 */
let queuedInputRows: QueuedInput[] = []
/** 有待决审批时 /api/ai/approval/pending 回 hit。 */
let approvalPending = false
let queuedInputEnabledConfig = true

beforeEach(() => {
  vi.clearAllMocks()
  capture.composerControls = null
  capture.queuedBarProps = null
  capture.onRunningChange = null
  capture.backgroundActive = false
  queuedInputPosts = []
  queuedInputRows = []
  approvalPending = false
  queuedInputEnabledConfig = true
  vi.stubEnv('VITE_BUILD_TARGET', 'web')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/chat/config')) {
        return {
          ok: true,
          json: async () => ({ data: { chatQueuedInputEnabled: queuedInputEnabledConfig } })
        }
      }
      if (url.includes('/api/ai/approval/pending')) {
        return approvalPending
          ? {
              ok: true,
              json: async () => ({
                pending: true,
                approvalId: 'ap-1',
                toolName: 'email_draft_reply'
              })
            }
          : { ok: false, status: 404, json: async () => ({}) }
      }
      if (url.includes('/api/ai/queued-input')) {
        if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
          return { ok: true, json: async () => ({ items: queuedInputRows }) }
        }
        queuedInputPosts.push(
          JSON.parse(String(init?.body ?? '{}')) as { sessionId: number; content: string }
        )
        return {
          ok: true,
          json: async () => ({
            item: { id: 9, session_id: 10, content: '排队的追问', status: 'queued' }
          })
        }
      }
      return { ok: true, json: async () => ({ status: 'ok' }) }
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function waitForControls(): Promise<ChatComposerControls> {
  await waitFor(() => expect(capture.composerControls).not.toBeNull())
  return capture.composerControls!
}

describe('AgentConversation —— 排队输入接进主场地', () => {
  test('前台流在跑 → composerControls 带排队三件套且 queueModeActive 为真', async () => {
    mount()
    await waitFor(() => expect(capture.composerControls?.queuedInputEnabled).toBe(true))
    // 🔴 修复前这三个字段在本组件根本不存在 —— composer 于是永远走不到排队分支。
    expect((await waitForControls()).queueModeActive).toBe(false)

    act(() => capture.onRunningChange!(true))
    await waitFor(() => expect(capture.composerControls?.queueModeActive).toBe(true))
    expect(typeof capture.composerControls?.onEnqueueQueuedInput).toBe('function')
  })

  test('待决审批（没有任何流在跑）同样进排队模式', async () => {
    approvalPending = true
    mount()
    await waitFor(() => expect(capture.composerControls?.queueModeActive).toBe(true))
    await waitFor(() => expect(capture.queuedBarProps?.approvalPendingExists).toBe(true))
  })

  test('总闸关着 → 流在跑也不进排队模式（现状不变）', async () => {
    queuedInputEnabledConfig = false
    mount()
    await waitForControls()
    act(() => capture.onRunningChange!(true))
    await act(async () => {})
    expect(capture.composerControls?.queuedInputEnabled).toBe(false)
    expect(capture.composerControls?.queueModeActive).toBe(false)
  })

  test('onEnqueueQueuedInput → POST /api/ai/queued-input（带 sessionId 与文本）', async () => {
    mount()
    const controls = await waitForControls()
    await act(async () => {
      controls.onEnqueueQueuedInput!('排队的追问')
    })
    await waitFor(() => expect(queuedInputPosts).toHaveLength(1))
    expect(queuedInputPosts[0]).toEqual({ sessionId: 10, content: '排队的追问' })
  })

  // 0903 dogfood —— 派发一轮排队追问期间面板整个「看起来死了」的那段盲窗。
  // `/run/active` 探针在 active:false 之后停轮询，而 dispatcher 的 run 要 2~8 秒后才 register，
  // 于是 backgroundActive 恒假：既不显示在场行，`queueModeActive` 也是假的 —— 这时按下的 Enter
  // 走直发、撞会话租约 409 被丢掉。判据改用 dispatcher claim 那一刻就广播出来的 `claimed` 行。
  test('有 claimed 行（派发 run 正在起）→ 进排队模式并显示后台在场行', async () => {
    queuedInputRows = [
      {
        id: 2,
        sessionId: 10,
        runId: null,
        mode: 'follow_up',
        content: '你能干什么',
        status: 'claimed',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_010_000
      }
    ]
    mount()

    await waitFor(() => expect(capture.composerControls?.queueModeActive).toBe(true))
    await waitFor(() => expect(screen.getByTestId('background-run-presence')).toBeTruthy())
  })

  test('排队气泡挂在消息流末尾，已被信封带走的行按 rowIds 隐去', async () => {
    mount(fakeChat({ messages: [dispatchedEnvelopeRow([5, 7])] as ChatMessage[] }))
    await waitFor(() => expect(screen.getByTestId('queued-input-bar')).toBeTruthy())
    await waitFor(() => expect(capture.queuedBarProps?.enabled).toBe(true))
    expect(capture.queuedBarProps?.sessionId).toBe(10)
    expect([...(capture.queuedBarProps?.dispatchedRowIds as Set<number>)]).toEqual([5, 7])
  })
})
