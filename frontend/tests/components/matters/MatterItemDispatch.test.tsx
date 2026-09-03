// @vitest-environment happy-dom
//
// L4 批次3 —— 行动项执行契约在**详情页**的那一面（design §0 K5 / §6）。
//
// 钉六件事：
//   ① 派发入口只给行动项（其余五种 kind 结构上没有执行契约），且只在 matterAgentEnabled 时给；
//   ② 派发**不传** profile —— 服务端从 item 的 `exec_profile` 冻结；改档走既有 item PATCH 面；
//   ③ 活跃派发在场时不给第二个派发入口（服务端 partial unique 是最终防线，UI 不画必然 409 的钮）；
//   ④ 🔴「等你回答」与「失败」的徽标不同 —— 这一整批的卖点就是这两个态分得开；
//   ⑤ `edit_with_approval` 在词表里但**不渲染**成选项（假选项比缺选项毒）；
//   ⑥ 执行历史每一轮能点进**那一轮的会话**（按 job 配对），配不到就不画钮（诚实降级）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { ChatSessionListItem } from '@shared/api/types/chat'
import type { Matter, MatterItem, MatterItemDispatch } from '@shared/api/types/matter'
import i18n from '@shared/i18n'

const {
  mattersApi,
  dispatchMutate,
  flags,
  dispatchState,
  mailApi,
  sessionState,
  openAgentSession
} = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    patch: vi.fn(),
    patchItem: vi.fn(),
    deleteItem: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    getUpdate: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [])
  },
  dispatchMutate: vi.fn(),
  flags: { matterAgentEnabled: true },
  dispatchState: { items: [] as MatterItemDispatch[] },
  sessionState: { rows: [] as ChatSessionListItem[] },
  mailApi: { chat: { listAllSessions: vi.fn() } },
  openAgentSession: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', async (importOriginal) => {
  // 🔴 `useItemDispatchAction` 只 mock 掉写口 —— `MatterItemDispatchBlock` 内部直接用它，
  //    整模块替换会顺手把 `matterDispatchVocab` 之外的真实导出也吃掉。
  const actual = await importOriginal<typeof import('@shared/components/matters/hooks')>()
  return {
    ...actual,
    useMatterChatApi: () => ({ contextSnapshot: vi.fn(), applyUndo: vi.fn() }),
    useMattersApi: () => mattersApi,
    useMatterFlags: () => ({
      mattersEnabled: true,
      matterAgentEnabled: flags.matterAgentEnabled
    }),
    useMatterRuns: () => ({ data: undefined, isLoading: false }),
    useMatterPendingUpdates: () => ({ data: undefined, isLoading: false }),
    useStartMatterRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useMatterAgentProfiles: () => ({
      data: [{ id: 'vendor-agent', type: 'custom', enabled: true, title: '供应链 Agent' }],
      isLoading: false
    }),
    useMatterItemDispatches: () => ({ data: dispatchState.items, isLoading: false }),
    useMatterAttention: () => ({ data: undefined, isLoading: false }),
    useItemDispatchAction: () => ({ mutate: dispatchMutate, isPending: false })
  }
})
vi.mock('@shared/state/toast', () => ({
  useToastStore: { getState: () => ({ push: vi.fn(), dismiss: vi.fn() }) },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/state/ai-chat-panel', async (importOriginal) => {
  // 只换掉「打开这场会话」这一个动作 —— `useAIChatPanel` 是 MatterDetail 自己在用的真 store。
  const actual = await importOriginal<typeof import('@shared/state/ai-chat-panel')>()
  return { ...actual, requestOpenAgentSession: openAgentSession }
})
// `useRouter` 是 P2-L10 起 ResourceDrawer 走资料库深链要的（`router.history.push`）。
// 本用例不点深链，但整模块替换缺一个导出就是 import 期报错，MatterDetail 整棵树渲不出来。
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { push: vi.fn() } })
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  flags.matterAgentEnabled = true
  dispatchState.items = []
  sessionState.rows = []
  mailApi.chat.listAllSessions.mockImplementation(async () => sessionState.rows)
  mattersApi.patch.mockResolvedValue({ matter: matter() })
  mattersApi.patchItem.mockResolvedValue({ matter: matter() })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
})

afterEach(cleanup)

describe('行动项派发入口', () => {
  test('只有行动项有派发入口；备注类条目没有', async () => {
    renderDetail({ items: [item({ id: 7 }), item({ id: 8, kind: 'note', title: '一条备注' })] })
    await screen.findByText('推进联调')
    expect(screen.getAllByTestId('item-dispatch-block')).toHaveLength(1)
    expect(screen.getByTestId('item-dispatch-block').getAttribute('data-item')).toBe('7')
  })

  test('matterAgentEnabled 关着且没派发过 → 整块不渲染', async () => {
    flags.matterAgentEnabled = false
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')
    expect(screen.queryByTestId('item-dispatch-block')).toBeNull()
  })

  test('派发不传 profile（服务端从 item 冻结），内建执行器传 null', async () => {
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getByTestId('item-dispatch-start'))
    await waitFor(() => expect(screen.getByTestId('item-dispatch-launcher')).toBeTruthy())
    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.confirm')))

    expect(dispatchMutate).toHaveBeenCalledWith({
      matterId: 'MAT-0042',
      itemId: 7,
      action: 'dispatch',
      executorId: null
    })
    // 🔴 profile 不在入参里 —— 传一份就是把同一个真值写两遍。
    expect(Object.keys(dispatchMutate.mock.calls[0]![0] as object)).not.toContain('profile')
  })

  test('🔴 执行档只渲染两档：edit_with_approval 在词表里但不上 UI', async () => {
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')
    fireEvent.click(screen.getByTestId('item-dispatch-start'))
    await waitFor(() => expect(screen.getByTestId('item-dispatch-launcher')).toBeTruthy())

    // 折叠态的 SelectTrigger 显示的是当前档（未设过 ⇒ 出厂档 propose_only）。
    expect(screen.getByLabelText(i18n.t('matters.dispatch.profile')).textContent).toContain(
      i18n.t('matters.dispatch.profiles.propose_only')
    )
    expect(screen.queryByText(i18n.t('matters.dispatch.profiles.edit_with_approval'))).toBeNull()
  })
})

describe('活跃派发的状态与动作', () => {
  test('🔴「等你回答」与「失败」的徽标不同（两个态必须分得开）', async () => {
    dispatchState.items = [dispatchRow({ id: 31, item_id: 7, state: 'awaiting_input' })]
    const view = renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')
    expect(screen.getByTestId('dispatch-state-badge').getAttribute('data-state')).toBe(
      'awaiting_input'
    )
    // 活跃派发在场 ⇒ 不给第二个派发入口。
    expect(screen.queryByTestId('item-dispatch-start')).toBeNull()
    view.unmount()

    dispatchState.items = [
      dispatchRow({ id: 32, item_id: 7, state: 'failed', question: null, ended_at: 9 })
    ]
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')
    expect(screen.getByTestId('dispatch-state-badge').getAttribute('data-state')).toBe('failed')
    // 终态 ⇒ 可以再派一次（派发史逐行留下是有意的）。
    expect(screen.getByTestId('item-dispatch-start')).toBeTruthy()
  })

  test('回答是两步式：点「回答」先展开框，填了才提交', async () => {
    dispatchState.items = [dispatchRow({ id: 31, item_id: 7, state: 'awaiting_input' })]
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.answer')))
    await waitFor(() => expect(screen.getByTestId('item-dispatch-answer')).toBeTruthy())
    expect(screen.getByText('要按哪一版报价发？')).toBeTruthy()
    expect(dispatchMutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(i18n.t('matters.dispatch.answerLabel')), {
      target: { value: '按第 3 版' }
    })
    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.answerConfirm')))
    expect(dispatchMutate).toHaveBeenCalledWith({
      matterId: 'MAT-0042',
      dispatchId: 31,
      action: 'answer',
      text: '按第 3 版'
    })
  })

  test('取消派发调 cancel；执行历史按派发史逐行列出', async () => {
    dispatchState.items = [
      dispatchRow({ id: 33, item_id: 7, state: 'running', question: null, attempt_count: 2 }),
      dispatchRow({
        id: 32,
        item_id: 7,
        state: 'failed',
        question: null,
        ended_at: 9,
        error: { code: 'no_report' }
      })
    ]
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.cancel')))
    expect(dispatchMutate).toHaveBeenCalledWith({
      matterId: 'MAT-0042',
      dispatchId: 33,
      action: 'cancel'
    })

    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.history', { count: 2 })))
    await waitFor(() => expect(screen.getByTestId('item-dispatch-history')).toBeTruthy())
    // 失败原因写在行上 —— 「挂了但不说为什么」正是这一批要修的东西。
    expect(screen.getByText('no_report')).toBeTruthy()
  })
})

describe('执行历史 → 会话跳转', () => {
  test('配得到会话的轮次给跳转钮，点了打开的是**那一轮**的会话', async () => {
    dispatchState.items = [
      dispatchRow({ id: 33, item_id: 7, state: 'done', question: null, async_job_id: 901 }),
      dispatchRow({ id: 32, item_id: 7, state: 'failed', question: null, async_job_id: 900 })
    ]
    // 🔴 会话行的 agent_job_id 是 TEXT，派发行的 async_job_id 是 number —— 配对必须跨类型成立。
    sessionState.rows = [
      sessionRow({ id: 5001, agent_job_id: '900' }),
      sessionRow({ id: 5002, agent_job_id: '901' })
    ]
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.history', { count: 2 })))
    await waitFor(() => expect(screen.getAllByTestId('item-dispatch-session')).toHaveLength(2))
    expect(mailApi.chat.listAllSessions).toHaveBeenCalledWith({ itemId: 7 })

    const buttons = screen.getAllByTestId('item-dispatch-session')
    // 历史是 newest-first：第一行 = job 901。
    expect(buttons[0]!.getAttribute('data-session')).toBe('5002')
    fireEvent.click(buttons[1]!)
    expect(openAgentSession).toHaveBeenCalledWith(5001)
  })

  test('配不到会话的轮次不画钮（点了什么都不发生的入口比没有更糟）', async () => {
    dispatchState.items = [
      dispatchRow({ id: 33, item_id: 7, state: 'done', question: null, async_job_id: 901 }),
      // 还没起 run（queued，没有 job）—— 恒配不到。
      dispatchRow({ id: 34, item_id: 7, state: 'queued', question: null, async_job_id: null })
    ]
    sessionState.rows = [sessionRow({ id: 5001, agent_job_id: '777' })]
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getByText(i18n.t('matters.dispatch.history', { count: 2 })))
    await waitFor(() => expect(screen.getByTestId('item-dispatch-history')).toBeTruthy())
    await waitFor(() => expect(mailApi.chat.listAllSessions).toHaveBeenCalled())
    expect(screen.queryAllByTestId('item-dispatch-session')).toHaveLength(0)
  })

  test('没展开历史就不查会话（一屏十几条行动项，挂载即查 = 十几个请求）', async () => {
    dispatchState.items = [dispatchRow({ id: 33, item_id: 7, state: 'done', question: null })]
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')
    expect(mailApi.chat.listAllSessions).not.toHaveBeenCalled()
  })
})

function sessionRow(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 5001,
    email_id: null,
    anchor_type: 'matter',
    anchor_id: 42,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: 1,
    updated_at: 2,
    origin: 'agent',
    agent_job_id: '900',
    item_id: 7,
    first_user_message: null,
    message_count: 2,
    email_subject: null,
    email_sender: null,
    ...over
  }
}

function renderDetail({
  items = [],
  matterOverrides = {}
}: {
  items?: MatterItem[]
  matterOverrides?: Partial<Matter>
}): ReturnType<typeof render> {
  mattersApi.get.mockResolvedValue({ matter: matter(matterOverrides), items, timeline: [] })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterDetail matterId="MAT-0042" onBack={vi.fn()} onRemoved={vi.fn()} />
    </QueryClientProvider>
  )
}

function dispatchRow(over: Partial<MatterItemDispatch> = {}): MatterItemDispatch {
  return {
    id: 31,
    matter_id: 42,
    item_id: 7,
    state: 'awaiting_input',
    executor_kind: 'agent',
    executor_id: 'matter_followup',
    exec_profile: 'propose_only',
    question: { question: '要按哪一版报价发？' },
    answers: [],
    update_id: null,
    async_job_id: 900,
    attempt_count: 1,
    error: null,
    created_by_kind: 'user',
    created_by_id: null,
    dispatched_at: 1,
    awaiting_since: 2,
    delivered_at: null,
    ended_at: null,
    created_at: 1,
    updated_at: 2,
    ...over
  }
}

function item(overrides: Partial<MatterItem> = {}): MatterItem {
  return {
    id: 7,
    matter_id: 42,
    kind: 'action',
    title: '推进联调',
    description: null,
    position: 0,
    status: 'open',
    priority: null,
    owner_kind: null,
    owner_id: null,
    waiting_on_stakeholder_id: null,
    due_at: null,
    completed_at: null,
    checklist: [],
    source_resource_id: null,
    source_locator: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides
  }
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 42,
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    background: '',
    goal: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'on_track',
    priority: 'p1',
    owner_id: null,
    source: 'desktop_ui',
    due_at: null,
    waiting_context: null,
    next_attention_at: null,
    attention_reason: null,
    last_activity_at: null,
    latest_accepted_update_id: null,
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version: 3,
    archived_at: null,
    archived_by_kind: null,
    archived_by_id: null,
    deleted_at: null,
    deleted_by_kind: null,
    deleted_by_id: null,
    purge_after: null,
    created_at: 1,
    updated_at: 1,
    ...overrides
  }
}
