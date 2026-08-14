// @vitest-environment happy-dom
//
// 0813 轮4批AG — owner dogfood：「在事项页面点击对话，竟然会把进事项前的那个邮件也默认以 chip 方式
// 带进来（事项本身会带进来没问题，但是多带了个邮件）。」
//
// 病根不是「谁忘了清谁」：`useActiveEmail.activeInternalId` 是 **persist 在 localStorage、切邮箱
// 有意不复位**的环境态（它的文件头写明了，且 EmailDetail 恢复 / J-K / EmailList reset 都靠它），
// 进事项页时它当然还在。于是事项种子与邮件种子各自都种了一枚 chip。
// 修法 = 把「当前上下文是什么」变成一条**单值**判据（src/shared/components/agents/
// conversationContextSource.ts），而不是去清那份全局状态。
//
// 本文件两层：
//   ① 纯函数层 —— 判定表逐档钉死（含「环境态不得盖过显式声明」这条原则本身）；
//   ② 组件层 —— 真的挂 AgentConversation，断言 chip 行里**只有**该有的那一枚。②是修复前必红的那层。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import {
  resolveConversationContextSource,
  seededEmailIdOf
} from '@shared/components/agents/conversationContextSource'

const MATTER = { id: 7, publicId: 'MAT-0007', title: 'Vendor launch' }
const OTHER_MATTER = { id: 9, publicId: 'MAT-0009', title: 'Renewal' }

// ── ① 纯函数：判定表 ─────────────────────────────────────────────────────────────────────────────
describe('resolveConversationContextSource — 单值判定', () => {
  test('🔴 事项种子在场 ⇒ 上下文是事项，环境态的活动邮件让位（owner 报的那条）', () => {
    const source = resolveConversationContextSource({
      sessionMatter: null,
      sessionMatterUnresolved: false,
      matterSeed: MATTER,
      activeEmailId: 4242
    })
    expect(source).toEqual({ kind: 'matter', target: MATTER })
    // 判据的下游只认这一个值：事项对话里本宿主不产邮件 chip。
    expect(seededEmailIdOf(source)).toBeNull()
  })

  test('没有任何事项 ⇒ 活动邮件才是「当前所在的东西」（邮件详情唤起对话，现状不变）', () => {
    const source = resolveConversationContextSource({
      sessionMatter: null,
      sessionMatterUnresolved: false,
      matterSeed: null,
      activeEmailId: 4242
    })
    expect(source).toEqual({ kind: 'email', emailId: 4242 })
    expect(seededEmailIdOf(source)).toBe(4242)
  })

  test('会话行自己的事项身份优先于 dock 带的种子（历史里选中的事项会话是更硬的真相）', () => {
    const source = resolveConversationContextSource({
      sessionMatter: MATTER,
      sessionMatterUnresolved: false,
      matterSeed: OTHER_MATTER,
      activeEmailId: 4242
    })
    expect(source).toEqual({ kind: 'matter', target: MATTER })
  })

  test('🔴 事项身份未就绪是**独立一档**，不是 none —— 既有红线「绝不降级成普通会话」', () => {
    const source = resolveConversationContextSource({
      sessionMatter: null,
      sessionMatterUnresolved: true,
      matterSeed: null,
      activeEmailId: 4242
    })
    expect(source).toEqual({ kind: 'matter-unresolved' })
    // 这一档同样不产邮件 chip：整场对话属于某件事，只是编号没拿到。
    expect(seededEmailIdOf(source)).toBeNull()
  })

  test('都没有 ⇒ none（/sessions 全屏、无上下文的浮窗）', () => {
    const source = resolveConversationContextSource({
      sessionMatter: null,
      sessionMatterUnresolved: false,
      matterSeed: null,
      activeEmailId: null
    })
    expect(source).toEqual({ kind: 'none' })
    expect(seededEmailIdOf(source)).toBeNull()
  })

  test('产出恒为单值：任何输入组合下 kind 只有一个、email 与 matter 不并存', () => {
    for (const sessionMatter of [null, MATTER]) {
      for (const sessionMatterUnresolved of [false, true]) {
        for (const matterSeed of [null, OTHER_MATTER]) {
          for (const activeEmailId of [null, 4242]) {
            const s = resolveConversationContextSource({
              sessionMatter,
              sessionMatterUnresolved,
              matterSeed,
              activeEmailId
            })
            const isMatterish = s.kind === 'matter' || s.kind === 'matter-unresolved'
            // 只要沾了事项，就绝不同时给出邮件。
            if (isMatterish) expect(seededEmailIdOf(s)).toBeNull()
            if (s.kind === 'email') expect(isMatterish).toBe(false)
          }
        }
      }
    }
  })
})

// ── ② 组件层：真的挂 AgentConversation，看 chip 行里到底有几枚 ────────────────────────────────────
// 这一组用与 AgentConversationGuards 相同的 mock 面（runtime / thread / 探针全替身），只把
// AgentConversation 自己的决策留在被测面内；AgentThread 的替身把 contextChip 摊平进 DOM。

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] })
}))
vi.mock('@shared/assistant/runtime/AiSdkRuntimeProvider', () => ({
  AiSdkRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('@shared/assistant/runtime/ThreadRunningBridge', () => ({ ThreadRunningBridge: () => null }))
vi.mock('@shared/assistant/runtime/useBackgroundChatRun', () => ({
  useBackgroundChatRun: () => ({ backgroundActive: false, backgroundStartedAt: null })
}))
vi.mock('@shared/assistant/components/ThreadRunStatusBar', () => ({ ThreadRunStatusBar: () => null }))
vi.mock('@shared/components/agents/AgentThread', () => ({
  AgentThread: ({ contextChip }: { contextChip?: React.ReactNode }) => (
    <div data-testid="thread">
      <div data-testid="context-chips">{contextChip}</div>
    </div>
  )
}))
vi.mock('@shared/assistant/components/ChatPromptDispatcher', () => ({
  ChatPromptDispatcher: () => null
}))
vi.mock('@shared/assistant/components/composerControls', () => ({
  ChatComposerControlsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('@shared/assistant/context/useAgentContextSnapshot', () => ({
  useAgentContextSnapshot: () => ({ snapshot: null })
}))
// 与 AgentConversationGuards 同一份替身（事项适配层要的三个 hook 都得在，少一个整组不挂）。
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

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouter: () => null }))

const EMAIL_SUBJECT = 'Thanks for your time yesterday'
const { stableMailApi } = vi.hoisted(() => ({
  stableMailApi: {
    settings: { secretsStatus: vi.fn(async () => ({ llmApiKey: true })) },
    chat: {
      newSession: vi.fn(),
      markSessionRead: vi.fn(async () => {}),
      onTurnPersisted: vi.fn(() => () => {}),
      onSessionUpdated: vi.fn(() => () => {}),
      listMessages: vi.fn(async () => []),
      updateSessionModel: vi.fn(async () => {})
    },
    email: {
      get: vi.fn(async (id: number) => ({
        internal_id: id,
        subject: 'Thanks for your time yesterday'
      })),
      body: vi.fn(async () => ({ content: '' }))
    },
    llm: { upstreamModels: vi.fn(async () => []), enabledModels: vi.fn(async () => []) }
  }
}))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))

const { AgentConversation } = await import('@shared/components/agents/AgentConversation')
const { useAIChatPanel } = await import('@shared/state/ai-chat-panel')

type ChatLike = Parameters<typeof AgentConversation>[0]['chat']

function fakeChat(): ChatLike {
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
    reloadActiveSession: vi.fn(async () => {})
  } as unknown as ChatLike
}

function mount(props: {
  initialMentionEmailId?: number
  initialMatterTarget?: { id: number; publicId: string; title: string }
}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AgentConversation chat={fakeChat()} activeItem={null} {...props} />
    </QueryClientProvider>
  )
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

beforeEach(() => {
  vi.clearAllMocks()
  useAIChatPanel.setState({ pendingPrompt: null, matterTarget: null, matterConversationEpoch: 0 })
  vi.stubEnv('VITE_BUILD_TARGET', 'web')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }))
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** chip 行里的邮件 chip —— 按标题文本找（seed effect 会异步补上标题）。 */
function emailChip(): HTMLElement | null {
  return screen.queryByText(EMAIL_SUBJECT)
}
function matterChip(): HTMLElement | null {
  return screen.queryByText(`${MATTER.publicId} · ${MATTER.title}`)
}

describe('🔴 进事项页点对话 —— chip 行里只有事项，没有上一封邮件', () => {
  test('事项 + 活动邮件同时在场 ⇒ 只出事项 chip', async () => {
    // dock 的真实接线：activeEmailId 还留着上一封（persist 的环境态），事项是刚点的。
    mount({ initialMentionEmailId: 4242, initialMatterTarget: MATTER })

    await waitFor(() => expect(matterChip()).toBeTruthy())
    // 🔴 修复前这里必红：邮件 chip 与事项 chip 会一起出现。
    expect(emailChip(), '事项对话里不该出现上一封邮件的 chip').toBeNull()

    // 陈述式复核：chip 行里只有一枚可移除的 context chip。
    const removeButtons = screen.queryAllByRole('button', {
      name: i18n.t('chat.modal.removeContext')
    })
    expect(removeButtons.length, '邮件 chip 的 × 不该在场').toBe(0)
  })

  test('对照 —— 邮件详情唤起对话（无事项）⇒ 邮件 chip 仍在（别改坏现状）', async () => {
    mount({ initialMentionEmailId: 4242 })

    await waitFor(() => expect(emailChip()).toBeTruthy())
    expect(matterChip()).toBeNull()
  })

  test('对照 —— /sessions 全屏（两个都不传）⇒ 一枚 chip 都没有', async () => {
    mount({})
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())
    expect(emailChip()).toBeNull()
    expect(matterChip()).toBeNull()
  })
})
