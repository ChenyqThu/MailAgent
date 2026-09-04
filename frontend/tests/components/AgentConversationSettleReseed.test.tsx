// @vitest-environment happy-dom
//
// 0903 dogfood 现象 B 的最后一步：派发那一轮跑完之后，assistant 回复到底会不会自己出现在面板上。
//
// 链路只有一条，本文件把它整条钉住：派发轮 persist → `chat:turn-persisted` 广播 →
// useBackgroundChatRun 的 settle 门（runId 不是自己的 → fire）→ AgentConversation 的 onSettled →
// `reloadActiveSession()` 重取消息 → `refreshNonce` 自增 → runtime key 变（`:rN`）→ provider 重挂载、
// 用重取到的消息重新 seed。缺任何一环，回复就要等到用户手动切走再切回才看得见。

import { useEffect, useRef } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'

import type { ChatMessage, ChatSession, ChatSessionListItem } from '@shared/api/types'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
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
    /** AgentConversation 传给 runtime provider 的 seed（每次渲染覆盖）。 */
    seededTexts: [] as string[],
    /** provider 的 remount key —— `:rN` 后缀是「settle 后重新 seed」的判据。 */
    runtimeKey: null as string | null,
    /** useBackgroundChatRun 拿到的 onSettled（用例据此模拟广播驱动的 settle）。 */
    onSettled: null as (() => void) | null
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] }),
  resolveApiBaseUrl: () => ''
}))
// runtime provider：只记 seed 与 key（真组件要 ai-sdk 运行时）。key 读不到 props，用一个包一层的
// 探针组件把它带出来 —— React 的 key 不进 props，所以由 provider 自己在 mount 时上报。
vi.mock('@shared/assistant/runtime/AiSdkRuntimeProvider', () => ({
  AiSdkRuntimeProvider: ({
    children,
    initialMessages
  }: {
    children: React.ReactNode
    initialMessages?: Array<{ parts?: Array<{ type: string; text?: string }> }>
  }) => {
    // 🔴 只在 MOUNT 时记录 —— 真 provider 也是 mount 时一次性把 initialMessages 灌进 ai-sdk
    // 运行时的。这样「settle 后 runtime key 没变 ⇒ 不重挂载 ⇒ 重取到的消息进不了线程」会被
    // 断言抓到；每次渲染都记就变成了对 rerender 恒绿，测不到重挂载那一环。
    const seeds = (initialMessages ?? []).map(
      (message) => message.parts?.find((part) => part.type === 'text')?.text ?? ''
    )
    const seedsRef = useRef(seeds)
    seedsRef.current = seeds
    useEffect(() => {
      capture.seededTexts = seedsRef.current
    }, [])
    return <div>{children}</div>
  }
}))
vi.mock('@shared/assistant/runtime/ThreadRunningBridge', () => ({
  ThreadRunningBridge: () => null
}))
vi.mock('@shared/assistant/runtime/useBackgroundChatRun', () => ({
  useBackgroundChatRun: (opts: { onSettled: () => void }) => {
    capture.onSettled = opts.onSettled
    return { backgroundActive: false, backgroundStartedAt: null }
  }
}))
vi.mock('@shared/components/agents/AgentRecordView', () => ({
  AgentRecordConversation: () => <div data-testid="agent-record" />
}))
vi.mock('@shared/assistant/components/ChatPromptDispatcher', () => ({
  ChatPromptDispatcher: () => null
}))
vi.mock('@shared/components/agents/AgentThread', () => ({
  AgentThread: () => <div data-testid="thread" />
}))
vi.mock('@shared/assistant/components/QueuedInputBar', () => ({
  QueuedInputBar: () => null
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

function message(id: number, role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id,
    session_id: 10,
    role,
    content: text,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: JSON.stringify({
      id: `m${id}`,
      role,
      parts: [{ type: 'text', text }]
    }),
    created_at: 1_700_000_000_000 + id,
    updated_at: 1_700_000_000_000 + id
  } as ChatMessage
}

/** 派发轮 turn start 之后、persist 之前的库态：信封用户行已 eager 落库，assistant 行还没有。 */
const BEFORE_PERSIST = [message(915, 'user', '（信封）你能干什么')]
/** persist 之后的库态：assistant 回复也进来了。 */
const AFTER_PERSIST = [...BEFORE_PERSIST, message(916, 'assistant', '好问题，给你一张能力地图')]

beforeEach(() => {
  vi.clearAllMocks()
  capture.seededTexts = []
  capture.runtimeKey = null
  capture.onSettled = null
  vi.stubEnv('VITE_BUILD_TARGET', 'web')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/chat/config')) {
        return { ok: true, json: async () => ({ data: { chatQueuedInputEnabled: true } }) }
      }
      if (url.includes('/api/ai/approval/pending')) {
        return { ok: false, status: 404, json: async () => ({}) }
      }
      if (url.includes('/api/ai/queued-input')) {
        return { ok: true, json: async () => ({ items: [] }) }
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

describe('AgentConversation —— 派发轮 settle 之后回复自己补上', () => {
  test('settle → reloadActiveSession → 线程用重取到的消息重新 seed（assistant 行进来了）', async () => {
    // 库态由 reloadActiveSession 推进：settle 触发的那次重取拿到 assistant 行。
    let rows = BEFORE_PERSIST
    const reloadActiveSession = vi.fn(async () => {
      rows = AFTER_PERSIST
      rerenderWithRows()
    })
    const chatOf = (): UseGeneralChatReturn =>
      ({
        messages: rows,
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
        reloadActiveSession
      }) as UseGeneralChatReturn

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <AgentConversation chat={chatOf()} activeItem={generalSession(10) as ChatSessionListItem} />
      </QueryClientProvider>
    )
    function rerenderWithRows(): void {
      view.rerender(
        <QueryClientProvider client={client}>
          <AgentConversation
            chat={chatOf()}
            activeItem={generalSession(10) as ChatSessionListItem}
          />
        </QueryClientProvider>
      )
    }

    // 派发轮还没 persist：面板上只有信封那条用户气泡，没有 assistant —— 正是 owner 看到的那一幕。
    await waitFor(() => expect(capture.seededTexts).toEqual(['（信封）你能干什么']))
    expect(capture.onSettled).not.toBeNull()

    // 派发轮 persist 的广播把 settle 门打开（真门的行为由 use_background_chat_run 那条重放钉住）。
    await act(async () => {
      capture.onSettled!()
    })

    expect(reloadActiveSession).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(capture.seededTexts).toEqual(['（信封）你能干什么', '好问题，给你一张能力地图'])
    )
  })
})
