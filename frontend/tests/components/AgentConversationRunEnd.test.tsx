// @vitest-environment happy-dom
//
// 0813 dogfood 轮 4 —— 「立即跟进」两条 run 收尾 bug 的回归网（batch AF）：
//
//   🔴 bug 1 「运行完回到默认 ai chat 首页」：run 结束的 'chat:turn-persisted' 广播触发
//        useGeneralChat.refreshSessions()，而 listGeneralSessions 只回 anchor_type='general' ——
//        adoptSession 收进来的 **matter-anchored** 行在整表覆盖里就地蒸发 → AgentConversation 的
//        `knownKind`（activeItem ?? chat.sessions 兜底）读不到 → `metadataPending` 翻真 →
//        runtime provider（连同线程 UI 与 TurnCompleteWatcher）被卸载；随后 remount 以空
//        initialMessages 起步 = 对话画面清空。修复 = refreshSessions/初始加载对**活跃会话的行**
//        永不驱逐（useGeneralChat.mergeKeepingActive）。
//
//   🔴 bug 2 「自动触发的对话不生成标题」：标题生成唯一触发是 TurnCompleteWatcher 的
//        running→idle 边沿 —— 上面的卸载把它一并杀掉（自动发送的第一轮永远发不出
//        /api/ai/title）；且旧实现只在 fetch **网络层**拒绝时解闩 autoTitlePostedRef，HTTP 非
//        2xx（persist 竞态 404 / 上游 502）会把 sid 永久闩死 = 一次瞬时失败这条会话永远没有标题；
//        detached 收尾 / 服务端 resume 收尾（两条 settle 路）根本没有客户端边沿，此前从不进
//        标题路径。修复 = maybeAutoTitle 单入口（三个触发点共用）+ 只在拿到非空 title 时落闩。
//
// 活库证据（2026-08-13 dogfood）：session 164（立即跟进，17:17 自动发送、17:19 turn 落库）
// title=NULL；随后 165（同一事项）空行 —— 与上述机制逐点吻合。

import { useEffect } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import type { ChatSession, ChatSessionListItem } from '@shared/api/types'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import type { ChatPromptRequest } from '@shared/assistant/components/ChatPromptDispatcher'
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
      listMessages: vi.fn(async () => []),
      // 真 useGeneralChat 在环 —— 服务端 general-only 列表（matter 行结构性缺席）。
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
    promptRequest: null as ChatPromptRequest | null,
    turnComplete: null as (() => void) | null,
    backgroundOpts: null as { onSettled: () => void } | null
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] })
}))
vi.mock('@shared/assistant/runtime/AiSdkRuntimeProvider', () => ({
  AiSdkRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('@shared/assistant/runtime/ThreadRunningBridge', () => ({
  ThreadRunningBridge: () => null
}))
// useBackgroundChatRun 换成捕获壳：settle 路（detached 收尾）由测试手动触发 opts.onSettled。
vi.mock('@shared/assistant/runtime/useBackgroundChatRun', () => ({
  useBackgroundChatRun: (opts: { onSettled: () => void }) => {
    capture.backgroundOpts = opts
    return { backgroundActive: false, backgroundStartedAt: null }
  }
}))
vi.mock('@shared/assistant/components/ThreadRunStatusBar', () => ({
  ThreadRunStatusBar: () => null
}))
vi.mock('@shared/components/agents/AgentRecordView', () => ({
  AgentRecordConversation: () => <div data-testid="agent-record" />
}))
// AgentThread：线程在场的判据（data-testid）+ 捕获 onTurnComplete（running→idle 边沿的手动扳机）。
vi.mock('@shared/components/agents/AgentThread', () => ({
  AgentThread: ({ onTurnComplete }: { onTurnComplete?: () => void }) => {
    capture.turnComplete = onTurnComplete ?? null
    return <div data-testid="thread" />
  }
}))
// ChatPromptDispatcher：镜像真实派发（append 落地即 onDispatched 消费 nonce）—— 不消费的话，
// adoptSession 落地时 pendingPrompt 仍挂着会触发「非空会话先 newSession」守卫，测不到本 bug。
vi.mock('@shared/assistant/components/ChatPromptDispatcher', () => ({
  ChatPromptDispatcher: ({
    request,
    onDispatched
  }: {
    request: ChatPromptRequest | null
    onDispatched: (nonce: number, sent: boolean) => void
  }) => {
    capture.promptRequest = request
    useEffect(() => {
      if (request) onDispatched(request.nonce, true)
    }, [request, onDispatched])
    return null
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
  useMattersApi: () => ({
    discoverResourceSuggestions: vi.fn(async () => ({ items: [], suppressed: [] }))
  }),
  useMatterChatApi: () => ({
    contextSnapshot: vi.fn(async () => {
      throw new Error('not needed')
    }),
    applyUndo: vi.fn(async () => ({}))
  }),
  useMattersEnabled: () => true
}))

const { AgentConversation } = await import('@shared/components/agents/AgentConversation')
const { useGeneralChat } = await import('@shared/hooks/useGeneralChat')
const { useAIChatPanel, startMatterChatWithPrompt } = await import('@shared/state/ai-chat-panel')

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

const target = { id: 42, publicId: 'MAT-0042', title: 'Vendor launch' }

/** adoptSession 收进来的 matter-anchored 会话行（onEnsureSession 首次发送时创建的形状）。 */
function matterSession(id: number): ChatSession {
  const now = Date.now()
  return {
    id,
    email_id: null,
    anchor_type: 'matter',
    anchor_id: target.id,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: now,
    updated_at: now
  } as ChatSession
}

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

function generalItem(id: number): ChatSessionListItem {
  return generalSession(id) as unknown as ChatSessionListItem
}

function fakeChat(over: Partial<UseGeneralChatReturn> = {}): UseGeneralChatReturn {
  return {
    messages: [],
    error: null,
    activeSessionId: null,
    messagesSessionId: null,
    navEpoch: 0,
    sessions: [],
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

/** dock 的真实接线：真 useGeneralChat + store 里的 matterTarget（与 AssistantChatModal 同构）。 */
let hostChat: UseGeneralChatReturn | null = null
function DockHost(): React.JSX.Element {
  const chat = useGeneralChat()
  hostChat = chat
  const matterTarget = useAIChatPanel((s) => s.matterTarget)
  return (
    <AgentConversation chat={chat} activeItem={null} initialMatterTarget={matterTarget ?? undefined} />
  )
}

function mountHost(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DockHost />
    </QueryClientProvider>
  )
}

function mountFake(chat: UseGeneralChatReturn, activeItem: ChatSessionListItem | null): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AgentConversation chat={chat} activeItem={activeItem as ChatSession | null} />
    </QueryClientProvider>
  )
}

/** /api/ai/title 的调用记录 + 可编程响应队列（缺省成功）。其余 URL（/health 探针等）恒 ok。 */
let titleCalls: Array<{ sessionId: number; model: string }> = []
let titleResponses: Array<{ ok: boolean; title: string | null }> = []

beforeEach(() => {
  vi.clearAllMocks()
  hostChat = null
  capture.composerControls = null
  capture.promptRequest = null
  capture.turnComplete = null
  capture.backgroundOpts = null
  titleCalls = []
  titleResponses = []
  // 本环境没有内建 localStorage（readAutoTitleSettings 会 try/catch 回落 'off'）——
  // 用 Map 版 stub 顶上，llm 档才立得起来。vi.unstubAllGlobals 在 afterEach 统一还原。
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  })
  useAIChatPanel.setState({ pendingPrompt: null, matterTarget: null, matterConversationEpoch: 0 })
  stableMailApi.chat.listGeneralSessions.mockImplementation(async () => [])
  vi.stubEnv('VITE_BUILD_TARGET', 'web')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/ai/title')) {
        titleCalls.push(JSON.parse(String(init?.body ?? '{}')) as { sessionId: number; model: string })
        const next = titleResponses.shift() ?? { ok: true, title: '生成的标题' }
        return {
          ok: next.ok,
          status: next.ok ? 200 : 502,
          json: async () => ({ title: next.title })
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

describe('🔴 bug 1 —— run 收尾的 refreshSessions 不许把活跃 matter 会话打回默认首页', () => {
  test('adopt 的 matter 会话在 general-only 刷新后仍在场：线程不卸载、会话行不驱逐', async () => {
    stableMailApi.chat.listGeneralSessions.mockImplementation(async () => [generalSession(77)])
    mountHost()
    // 初始加载落地（sessions=[77]）。
    await waitFor(() => expect(hostChat!.sessions.map((s) => s.id)).toEqual([77]))

    // 「立即跟进」：唤出 + 自动发送（mock dispatcher 即刻消费 nonce，镜像真实派发）。
    act(() => startMatterChatWithPrompt(target, '帮我跟进这件事（MAT-0042 · Vendor launch）'))
    await waitFor(() => expect(useAIChatPanel.getState().pendingPrompt).toBeNull())
    // 首次发送：onEnsureSession 创建 matter 会话并 adopt（这里直接驱动 hook 面，等价时序）。
    act(() => hostChat!.adoptSession(matterSession(164)))
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())
    expect(hostChat!.activeSessionId).toBe(164)

    // run 结束：'chat:turn-persisted' 广播 → onSessionsTouched → refreshSessions（general-only）。
    await act(async () => {
      await hostChat!.refreshSessions()
    })

    // 🔴 修复前：整表覆盖驱逐 164 → knownKind 读不到 → metadataPending → 线程被换成占位符。
    expect(screen.getByTestId('thread')).toBeTruthy()
    expect(hostChat!.sessions.map((s) => s.id)).toEqual([164, 77])
    expect(hostChat!.activeSessionId).toBe(164)
  })

  test('自动发送的第一轮同样进入标题生成路径（边沿观察者活到 run 结束）', async () => {
    stableMailApi.chat.listGeneralSessions.mockImplementation(async () => [generalSession(77)])
    localStorage.setItem('mailagent.chat.autoTitle.mode', 'llm')
    mountHost()
    await waitFor(() => expect(hostChat!.sessions.map((s) => s.id)).toEqual([77]))

    act(() => startMatterChatWithPrompt(target, '帮我跟进这件事（MAT-0042 · Vendor launch）'))
    await waitFor(() => expect(useAIChatPanel.getState().pendingPrompt).toBeNull())
    act(() => hostChat!.adoptSession(matterSession(164)))
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())

    // run 结束广播先到（gateway 在 res.end 之前 persist+broadcast）→ refreshSessions 先跑。
    await act(async () => {
      await hostChat!.refreshSessions()
    })
    // 🔴 修复前：TurnCompleteWatcher 随 runtime 卸载，running→idle 边沿永远无人观察。
    expect(screen.getByTestId('thread')).toBeTruthy()

    // 边沿到来（客户端流收尾）→ 标题路径必须带着 adopt 的会话 id 发出。
    act(() => capture.turnComplete!())
    await waitFor(() => expect(titleCalls).toHaveLength(1))
    expect(titleCalls[0]).toMatchObject({ sessionId: 164 })
  })
})

describe('🔴 bug 2 —— 标题生成：瞬时失败不闩死 + settle 收尾也进标题路径', () => {
  const chatOn10 = (): UseGeneralChatReturn =>
    fakeChat({ activeSessionId: 10, messagesSessionId: 10, sessions: [generalSession(10)] })

  test('HTTP 非 2xx（502/404）不落闩：下一个 running→idle 边沿幂等重试', async () => {
    localStorage.setItem('mailagent.chat.autoTitle.mode', 'llm')
    titleResponses = [
      { ok: false, title: null },
      { ok: true, title: '重试拿到的标题' }
    ]
    mountFake(chatOn10(), generalItem(10))
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())

    act(() => capture.turnComplete!())
    await waitFor(() => expect(titleCalls).toHaveLength(1))

    // 🔴 修复前：sid 已被永久闩死（只有 fetch 网络层拒绝才解闩），第二个边沿一个字节都不发。
    act(() => capture.turnComplete!())
    await waitFor(() => expect(titleCalls).toHaveLength(2))
    expect(titleCalls[1]).toMatchObject({ sessionId: 10 })
  })

  test('detached / 服务端 resume 收尾（settle 路）没有客户端边沿，也要进标题路径', async () => {
    localStorage.setItem('mailagent.chat.autoTitle.mode', 'llm')
    mountFake(chatOn10(), generalItem(10))
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())

    // 🔴 修复前：onSettled 只 reload+remount，从不触发标题。
    act(() => capture.backgroundOpts!.onSettled())
    await waitFor(() => expect(titleCalls).toHaveLength(1))
    expect(titleCalls[0]).toMatchObject({ sessionId: 10 })
  })

  test('对照：headless agent 记录（origin=agent）的 settle 不生成标题（按现状不动）', async () => {
    localStorage.setItem('mailagent.chat.autoTitle.mode', 'llm')
    const item = { ...generalItem(10), origin: 'agent' } as ChatSessionListItem
    mountFake(chatOn10(), item)
    await waitFor(() => expect(screen.getByTestId('agent-record')).toBeTruthy())

    act(() => capture.backgroundOpts!.onSettled())
    // settle 后给一拍：断言零标题调用（而非等待某事发生）。
    await act(async () => {})
    expect(titleCalls).toHaveLength(0)
  })

  test('对照：autoTitle=off（默认）时任何触发点都不发标题请求', async () => {
    mountFake(chatOn10(), generalItem(10))
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())

    act(() => capture.turnComplete!())
    act(() => capture.backgroundOpts!.onSettled())
    await act(async () => {})
    expect(titleCalls).toHaveLength(0)
  })
})
