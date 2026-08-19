// @vitest-environment happy-dom
//
// 0812 codex 复审 —— AgentConversation 上两条「不许静默降级」的闸：
//
//   🔴 #2 事项身份**未就绪** ≠ 普通会话。单条 `GET /chat/sessions/{id}` 曾不带 matter join 投影，
//        于是远程入口 / fullscreen 跳转 / `/sessions/all` 暂时不含该行时，一条 `anchor_type='matter'`
//        的会话只剩内部 anchor_id → 旧代码把它当普通对话渲染：没有事项 chip、没有写入回执、请求
//        不带 matter 快照 ⇒ 模型手里没有这件事的任何上下文。用户在一个看起来仍是原历史对话
//        的页面里说「更新这件事」，模型实际在全局范围跑，可能操作**错误的事项**。
//        修复后：如实说「上下文未就绪」+ 禁发 + 不产 general 快照。
//
//   🔴 #3 待发指令不许悬着。用户先 × 掉当前邮件的 chip，再点工具栏「创建事项」——旧代码里 chip
//        永远不会重建（seed 记着那次移除），指令于是永远等不到引用就位、一直留在 store 里，直到
//        之后某次重挂时突然自动发出去（还可能触发事项写操作）。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    /** S4 —— 送出时真正拼给 gateway 的那段前缀（runtime provider 收到的那个函数本尊）。 */
    buildInjectedContext: null as (() => Promise<string>) | null,
    promptRequest: null as ChatPromptRequest | null,
    snapshotEnabled: null as boolean | null,
    /** 每一次渲染的「这一帧派发了什么 / 这一帧 chip 在不在」配对样本（0813 #6 的判据）。
     *  AgentThread 的 mock 在 ChatPromptDispatcher 之后渲染（同一次 pass、JSX 顺序在后），
     *  所以它记下的 request 就是**同一帧**那一份。 */
    samples: [] as Array<{ request: ChatPromptRequest | null; chip: boolean }>
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] })
}))
// 只保留「AgentConversation 自己的决策」在被测面内：runtime / thread / 后台探针都换成占位，
// thread 只把它拿到的槽位摊平渲染出来（context chip 就是这样进入 DOM 的）。
vi.mock('@shared/assistant/runtime/AiSdkRuntimeProvider', () => ({
  AiSdkRuntimeProvider: ({
    children,
    buildInjectedContext
  }: {
    children: React.ReactNode
    buildInjectedContext?: () => Promise<string>
  }) => {
    capture.buildInjectedContext = buildInjectedContext ?? null
    return <div>{children}</div>
  }
}))
vi.mock('@shared/assistant/runtime/ThreadRunningBridge', () => ({
  ThreadRunningBridge: () => null
}))
vi.mock('@shared/assistant/runtime/useBackgroundChatRun', () => ({
  useBackgroundChatRun: () => ({ backgroundActive: false, backgroundStartedAt: null })
}))
vi.mock('@shared/components/agents/AgentThread', () => ({
  AgentThread: ({
    contextChip,
    runStatusSlot
  }: {
    contextChip?: React.ReactNode
    runStatusSlot?: React.ReactNode
  }) => {
    capture.samples.push({ request: capture.promptRequest, chip: contextChip != null })
    return (
      <div data-testid="thread">
        <div data-testid="context-chips">{contextChip}</div>
        <div data-testid="run-status">{runStatusSlot}</div>
      </div>
    )
  }
}))
vi.mock('@shared/assistant/components/ChatPromptDispatcher', () => ({
  ChatPromptDispatcher: ({ request }: { request: ChatPromptRequest | null }) => {
    capture.promptRequest = request
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
  useAgentContextSnapshot: ({ enabled }: { enabled: boolean }) => {
    capture.snapshotEnabled = enabled
    return { snapshot: null }
  }
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
const { useAIChatPanel, startChatWithPrompt, startMatterChatWithPrompt } = await import(
  '@shared/state/ai-chat-panel'
)

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

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

function matterItem(over: Partial<ChatSessionListItem>): ChatSession {
  const now = Date.now()
  return {
    id: 10,
    email_id: null,
    anchor_type: 'matter',
    anchor_id: 4242,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: now,
    updated_at: now,
    ...over
  } as ChatSession
}

function mount(
  chat: UseGeneralChatReturn,
  activeItem: ChatSession | null,
  props: {
    initialMentionEmailId?: number
    initialMatterTarget?: { id: number; publicId: string; title: string }
  } = {}
): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentConversation chat={chat} activeItem={activeItem} {...props} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  capture.composerControls = null
  capture.buildInjectedContext = null
  capture.promptRequest = null
  capture.snapshotEnabled = null
  capture.samples.length = 0
  useAIChatPanel.setState({ pendingPrompt: null, matterTarget: null, matterConversationEpoch: 0 })
  // web 构建目标 → gatewayBaseUrl='' → /health 探针启用；让它健康，runtime 分支才走得到。
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

describe('🔴 #2 事项身份未就绪 —— 绝不降级成普通会话', () => {
  const chat = (): UseGeneralChatReturn =>
    fakeChat({ activeSessionId: 10, messagesSessionId: 10, messages: [] })

  test('缺 matter_public_id → 说「上下文未就绪」+ 禁发 + 不产 general 快照', async () => {
    mount(chat(), matterItem({ matter_public_id: null, matter_title: null }))
    await waitFor(() =>
      expect(document.querySelector('[data-matter-context-unresolved]')).toBeTruthy()
    )
    // 🔴 禁发：放行 = 用户以为在这件事里说话、模型却在全局范围跑。
    expect(capture.composerControls?.sendDisabled).toBe(true)
    // 🔴 不产 general 快照：顶一份 anchorType='general' 上去正是"当成普通会话"的那条路。
    expect(capture.snapshotEnabled).toBe(false)
    // 半个事项 UI 比没有更危险 —— chip / 检索范围一个都不许出。
    expect(screen.queryByTestId('matter-chat-controls')).toBeNull()
  })

  test('对照：拿得到编号 → 无告警、可发送、事项 chip 在场', async () => {
    mount(chat(), matterItem({ matter_public_id: 'MAT-0042', matter_title: 'Vendor launch' }))
    // D15（0813 dogfood）：chip 文案是「编号 · 标题」，且**只有这一颗**（置顶资料不再各挂一颗）。
    await waitFor(() => expect(screen.getByText('MAT-0042 · Vendor launch')).toBeTruthy())
    expect(document.querySelector('[data-matter-context-unresolved]')).toBeNull()
    expect(capture.composerControls?.sendDisabled).toBe(false)
    // 事项会话用事项那份快照，general 快照恒关（这条在修复前后都成立，防误读为本闸的功劳）。
    expect(capture.snapshotEnabled).toBe(false)
  })

  test('对照：普通会话照旧（不被这条闸误伤）', async () => {
    mount(
      chat(),
      matterItem({ anchor_type: 'general', anchor_id: null } as Partial<ChatSessionListItem>)
    )
    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy())
    expect(document.querySelector('[data-matter-context-unresolved]')).toBeNull()
    expect(capture.composerControls?.sendDisabled).toBe(false)
    expect(capture.snapshotEnabled).toBe(true)
  })
})

describe('🔴 #3 待发指令不许悬着', () => {
  test('× 掉这封邮件的 chip 之后再点「创建事项」→ chip 重建、指令真的派发出去', async () => {
    mount(fakeChat(), null, { initialMentionEmailId: 4242 })
    // chip 先就位（同步立起、标题随后补）。
    await waitFor(() => expect(screen.getByText('邮件 4242')).toBeTruthy())
    // 用户手动移除它。
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.modal.removeContext') }))
    await waitFor(() => expect(screen.queryByText('邮件 4242')).toBeNull())
    expect(capture.promptRequest).toBeNull()

    // 工具栏「创建事项」—— 这是一次**新的**用户动作，必须覆盖刚才那次手动移除。
    startChatWithPrompt('创建事项', 4242)

    await waitFor(() => expect(capture.promptRequest).not.toBeNull())
    expect(capture.promptRequest).toMatchObject({ text: '创建事项', prefillOnly: false })
    // chip 回来了 → 指令不是"指着空气"发的。
    expect(screen.getByText('邮件 4242')).toBeTruthy()
  })

  test('本宿主给不出那封邮件的引用 → 当场消费成「只预填」，不留幽灵指令', async () => {
    mount(fakeChat(), null, { initialMentionEmailId: 4242 })
    await waitFor(() => expect(screen.getByText('邮件 4242')).toBeTruthy())

    // 指令声明的是**另一封**邮件：这个宿主永远给不出它的 chip。
    startChatWithPrompt('创建事项', 999)

    await waitFor(() => expect(capture.promptRequest).not.toBeNull())
    // 关键：不是 null（挂着等一枚永不出现的 chip），而是被判定成只预填、交给用户。
    expect(capture.promptRequest).toMatchObject({ text: '创建事项', prefillOnly: true })
  })
})

// 0813 dogfood 轮 3 #6 —— 「立即跟进」= 唤出即自动发送，且那场对话真的挂在这件事上。
//
// 病根在轮 2 之前是 dock 的异步「找这件事最近一次会话」把刚发出的一轮冲掉（见
// matterChatNewSession.test.tsx）。这里钉的是剩下那一半：**锚点的时序**。懒建会话
// （onEnsureSession）读的是事项锚点，而锚点来自 chip，chip 又是父组件 effect 下一帧才 seed 的；
// 不等就自动发，第一轮会把会话建成 `anchor_type='general'` —— owner 要的「也好有个记录」那份
// 记录就不在这件事名下。
describe('🔴 #6 「立即跟进」的自动发送与锚点时序', () => {
  const target = { id: 4242, publicId: 'MAT-0042', title: 'Vendor launch' }

  /** 🔴 必须照 dock 的真实接线来：`initialMatterTarget` 是**从 store 读的**，于是它与
   *  `pendingPrompt` 在同一次 store 更新里一起出现 —— 这正是时序 bug 的现场（那一帧 chip 还没
   *  seed）。测试里若把 target 当静态 prop 先挂上去，chip 早就在了，闸位就永远测不到。 */
  function MatterDockHost(): React.JSX.Element {
    const matterTarget = useAIChatPanel((s) => s.matterTarget)
    return (
      <AgentConversation
        chat={fakeChat()}
        activeItem={null}
        initialMatterTarget={matterTarget ?? undefined}
      />
    )
  }

  function mountDock(): void {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MatterDockHost />
      </QueryClientProvider>
    )
  }

  test('自动发送（prefillOnly=false），且**从没有**在锚点缺席的那一帧派发出去', async () => {
    mountDock()
    startMatterChatWithPrompt(target, '帮我跟进这件事（MAT-0042 · Vendor launch）')

    await waitFor(() => expect(capture.promptRequest).not.toBeNull())
    // ① 自动发送：不是「只预填等用户回车」。
    expect(capture.promptRequest).toMatchObject({ prefillOnly: false })
    // ② 🔴 每一帧的配对样本：只要这一帧有待派发的指令，事项 chip（= 锚点）就必须已经在场。
    const dispatched = capture.samples.filter((s) => s.request !== null)
    expect(dispatched.length).toBeGreaterThan(0)
    expect(dispatched.every((s) => s.chip)).toBe(true)
    expect(screen.getByText('MAT-0042 · Vendor launch')).toBeTruthy()
  })

  test('× 掉这件事的 chip 之后再点「立即跟进」→ chip 重建、指令照样派发（不悬着）', async () => {
    mountDock()
    // 先用一次普通「事项对话」把 chip 立起来（不带指令）。
    useAIChatPanel.getState().openMatterChat(target)
    await waitFor(() => expect(screen.getByText('MAT-0042 · Vendor launch')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: i18n.t('matters.chat.removeContext') }))
    await waitFor(() => expect(screen.queryByText('MAT-0042 · Vendor launch')).toBeNull())

    // 又点了一次 = 一次新的用户动作（epoch 自增），显式覆盖刚才那次手动移除。
    startMatterChatWithPrompt(target, '帮我跟进这件事（MAT-0042 · Vendor launch）')

    await waitFor(() => expect(capture.promptRequest).not.toBeNull())
    expect(capture.promptRequest).toMatchObject({ prefillOnly: false })
    expect(screen.getByText('MAT-0042 · Vendor launch')).toBeTruthy()
  })
})

// S4 (task 08-18) —— 🔴 #S4「@ 事项」只在普通对话里给。
//
// 事项对话里的「当前事项」是固定的：chip / 上下文快照 / 写入回执 surface 全锚在它上面。再 @ 另
// 一件事，用户与模型对「这件事」的所指就分裂了 —— 用户以为在说锚定的那件，模型手里却有两件。
// 判据取 contextSource（同一处单值判定），所以三档 matter 语义都得关：会话行自带的 anchor、
// dock 带的种子、以及**编号未就绪**那一档（那一档整个禁发，更不该开新入口）。
describe('🔴 #S4 事项对话不给「@ 事项」这一组', () => {
  const chat = (): UseGeneralChatReturn =>
    fakeChat({ activeSessionId: 10, messagesSessionId: 10, messages: [] })

  test('普通会话 → 供给整套（入口在）', async () => {
    mount(
      chat(),
      matterItem({ anchor_type: 'general', anchor_id: null } as Partial<ChatSessionListItem>)
    )
    await waitFor(() => expect(capture.composerControls).not.toBeNull())
    expect(capture.composerControls?.onAddMatterMention).toBeTypeOf('function')
    expect(capture.composerControls?.matterMentions).toEqual([])
  })

  test('事项会话（编号已解析）→ 不供给 onAddMatterMention', async () => {
    mount(chat(), matterItem({ matter_public_id: 'MAT-0042', matter_title: 'Vendor launch' }))
    await waitFor(() => expect(screen.getByText('MAT-0042 · Vendor launch')).toBeTruthy())
    expect(capture.composerControls?.onAddMatterMention).toBeUndefined()
  })

  test('事项会话（编号未就绪）→ 同样不供给', async () => {
    mount(chat(), matterItem({ matter_public_id: null, matter_title: null }))
    await waitFor(() =>
      expect(document.querySelector('[data-matter-context-unresolved]')).toBeTruthy()
    )
    expect(capture.composerControls?.onAddMatterMention).toBeUndefined()
  })

  test('dock 以「事项对话」唤出（种子）→ 不供给', async () => {
    mount(fakeChat(), null, {
      initialMatterTarget: { id: 4242, publicId: 'MAT-0042', title: 'Vendor launch' }
    })
    await waitFor(() => expect(screen.getByText('MAT-0042 · Vendor launch')).toBeTruthy())
    expect(capture.composerControls?.onAddMatterMention).toBeUndefined()
  })
})

// S4 —— 入口关掉只是一半：真正发出去的是 buildInjectedContext。这一组盯的是**注入面**。
describe('🔴 #S4 @ 事项的注入形状与失效', () => {
  const target = { id: 4242, publicId: 'MAT-0042', title: 'Vendor launch' }
  const mentioned = { public_id: 'MAT-0012', title: 'Vendor launch', status: 'active' }

  /** 照 dock 的真实接线：`initialMatterTarget` 从 store 读 —— 这样「对话进行中切成事项对话」
   *  才是真实可达的时序（也正是本闸要覆盖的那一幕）。 */
  function DockHost(): React.JSX.Element {
    const matterTarget = useAIChatPanel((s) => s.matterTarget)
    return (
      <AgentConversation
        chat={fakeChat()}
        activeItem={null}
        initialMatterTarget={matterTarget ?? undefined}
      />
    )
  }

  function mountDock(): void {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <DockHost />
      </QueryClientProvider>
    )
  }

  test('@ 一件事 → 注入 <mentioned_matters> 标识 + 取详情的指示，正文一个字都不带', async () => {
    mountDock()
    await waitFor(() => expect(capture.composerControls?.onAddMatterMention).toBeTypeOf('function'))
    act(() => capture.composerControls!.onAddMatterMention!(mentioned))
    await waitFor(() => expect(capture.composerControls?.matterMentions).toHaveLength(1))

    const injected = await capture.buildInjectedContext!()
    expect(injected).toContain('<mentioned_matters>')
    expect(injected).toContain('<matter id="MAT-0012" title="Vendor launch" status="active" />')
    expect(injected).toContain('Call matter_get with the EXACT')
    // 只发标识：注入面里没有任何一段事项正文（它是邮件正文的衍生物，见 prd R2）。
    expect(injected).not.toContain('current_summary')
    expect(injected).not.toContain('description=')
  })

  test('🔴 对话中途切成事项对话 → 先前 @ 的那件事**不再**随注入发出去', async () => {
    mountDock()
    await waitFor(() => expect(capture.composerControls?.onAddMatterMention).toBeTypeOf('function'))
    act(() => capture.composerControls!.onAddMatterMention!(mentioned))
    await waitFor(() => expect(capture.composerControls?.matterMentions).toHaveLength(1))
    expect(await capture.buildInjectedContext!()).toContain('MAT-0012')

    // 用户从事项页点「对话」——这场对话自此锚在 MAT-0042 上。
    act(() => {
      useAIChatPanel.getState().openMatterChat(target)
    })
    await waitFor(() => expect(capture.composerControls?.onAddMatterMention).toBeUndefined())

    // 🔴 只关入口而注入照旧，就会让「切进来之前 @ 过的那件事」跟着后面每一轮一起发出去。
    const injected = await capture.buildInjectedContext!()
    expect(injected).not.toContain('<mentioned_matters>')
    expect(injected).not.toContain('MAT-0012')
  })
})
