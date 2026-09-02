// @vitest-environment happy-dom
//
// 今日页主区的渲染闸（L4 批次 2 起；P4c 起主区是**五节**，例外面装在 decide/due/out 里）。
// 分组算法本身在 `todayGroups.test.ts` / `todaySections.test.ts` 单测，这里钉的是**页面真的
// 接得起来**，以及几条最容易做假的行为 ——
//
//   🔴 `paused_pending` 行的可操作性由 live 查 `/approval/pending` 决定，miss（gateway 重启 /
//      TTL 过期）必须**诚实降级**成「已失效」，不能画一个按了没反应的批准入口。
//   🔴 派发的「等你回答」与「失败」必须长得不一样（不同组 + 不同徽标）。
//   🔴 二级栏计数与主区行数**同源**（P4c）：两处各数一遍必然漂开。
//   🔴 组装不出「为什么是今天」的行**不渲染那一行**，不兜底成一句套话。
//
// 读端点全 mock 在 hook 边界（与 sidebar-contract 同款做法）：真实网络在 happy-dom 下
// 只会变成一屏 CORS 噪声，测不出任何东西。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'

import i18n from '../../src/shared/i18n'
import type {
  AgendaEntry,
  AgentRunHistoryItem,
  ReportListItem,
  TodayData,
  TodayReplyItem
} from '../../src/shared/api/types'
import type {
  MatterAttentionSignal,
  MatterItemDispatch,
  MatterPendingUpdatesEntry
} from '../../src/shared/api/types/matter'

const { state, attentionMutate, dispatchMutate } = vi.hoisted(() => ({
  state: {
    runs: [] as AgentRunHistoryItem[],
    proposals: [] as MatterPendingUpdatesEntry[],
    signals: [] as MatterAttentionSignal[],
    dispatches: [] as MatterItemDispatch[],
    /** P4c 三条新源：日历当天窗口 / `GET /api/today` / 当天报告。 */
    agenda: [] as AgendaEntry[],
    today: { reply: [], nextHardPoint: null } as TodayData,
    reports: [] as ReportListItem[],
    /** `fetchPendingApproval` 的返回：null = stash miss（gateway 重启 / 已被别处消费）。 */
    pending: null as { approvalId: string; toolName: string; inputPreview: string } | null
  },
  // 单独 hoist：`useAttentionAction` 的 mock 每次都要返回**同一个**间谍，测试才断言得到调用。
  attentionMutate: vi.fn(),
  dispatchMutate: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      listRuns: vi.fn(async () => ({ items: state.runs, total: state.runs.length })),
      list: vi.fn(async () => ({ items: state.reports, total: state.reports.length })),
      getConfig: vi.fn(async () => [
        { id: 'weekly-digest', type: 'custom', enabled: true, title: '周报 Agent' }
      ])
    },
    today: { get: vi.fn(async () => state.today) }
  })
}))

// 日历 agenda hook 走 mock：真实的那个会打 IPC/HTTP。`localOlsonTz` 也从这个模块出，
// 一并给个确定值（换机器时区不该让断言飘）。
vi.mock('@shared/components/calendar/hooks/useCalendarAgenda', () => ({
  localOlsonTz: () => 'Asia/Shanghai',
  useCalendarAgenda: () => ({
    data: state.agenda,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn()
  })
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersEnabled: () => true,
  usePendingMatterUpdates: () => ({
    data: { items: state.proposals },
    isPending: false,
    isError: false
  }),
  useGlobalAttention: () => ({ data: { items: state.signals }, isPending: false, isError: false }),
  useAttentionAction: () => ({ mutate: attentionMutate }),
  // L4 批次3 第四源。
  useLiveItemDispatches: () => ({
    data: { items: state.dispatches },
    isPending: false,
    isError: false
  }),
  useItemDispatchAction: () => ({ mutate: dispatchMutate, isPending: false })
}))

vi.mock('@shared/assistant/approvalRecordClient', () => ({
  fetchPendingApproval: vi.fn(async () => state.pending),
  postApprovalDecide: vi.fn(),
  postRememberWebPolicy: vi.fn()
}))

// Importing after the mocks are registered.
import { TodaySurface } from '../../src/shared/components/today/TodaySurface'
import { TodayNavPanel } from '../../src/shared/components/today/TodayNavPanel'

function run(over: Partial<AgentRunHistoryItem> & { state: AgentRunHistoryItem['state'] }) {
  return {
    jobId: 1,
    agentId: 'weekly-digest',
    createdAt: Date.now() / 1000 - 300,
    ...over
  } satisfies AgentRunHistoryItem
}

function signal(over: Partial<MatterAttentionSignal> = {}): MatterAttentionSignal {
  return {
    id: 11,
    kind: 'wait_overdue',
    state: 'open',
    severity: 'warn',
    why: '等待「供应商报价」已 5 天',
    first_opened_at: Date.now() - 120_000,
    matter: {
      public_id: 'm-abc',
      title: '供应商比价',
      status: 'active',
      health: 'on_track',
      priority: 'p1'
    },
    ...over
  } satisfies MatterAttentionSignal
}

async function renderSurface(): Promise<void> {
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <TodayNavPanel />
        <TodaySurface />
        <Outlet />
      </I18nextProvider>
    )
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/today', '/matters', '/sessions', '/', '/admin/calendar', '/reports/$reportId'].map(
        (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
      )
    ),
    history: createMemoryHistory({ initialEntries: ['/today'] })
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>
  )
  await waitFor(() => {
    expect(screen.getByText(i18n.t('today.title'))).toBeTruthy()
  })
}

/**
 * 主区（左列）作用域。
 *
 * 🔴 P5 起右侧多了「今天的时间线」列，它按契约把**同一批条目换一根轴再渲染一遍**（标题 +
 * 副行），于是「标题」「why / triageLogic」这些串在页面上天然各有两份。全局 `getByText`
 * 会撞 multiple-elements —— 正解是说清问的是哪一列，**不是**换成 `getAllByText()[0]`
 * （那会把「主区真的渲染了两遍」这类回归一起放过去）。
 *
 * 时间线自己那一列的断言走 `getByTestId('today-timeline')`（见本文件末尾两条）。
 */
function main(): ReturnType<typeof within> {
  return within(screen.getByTestId('today-main'))
}

function dispatch(over: Partial<MatterItemDispatch> = {}): MatterItemDispatch {
  return {
    id: 31,
    matter_id: 12,
    item_id: 44,
    state: 'awaiting_input',
    executor_kind: 'agent',
    executor_id: 'matter_followup',
    exec_profile: 'propose_only',
    question: { question: '要按哪一版报价发？', options: ['第 2 版', '第 3 版'] },
    answers: [],
    update_id: null,
    async_job_id: 900,
    attempt_count: 1,
    error: null,
    created_by_kind: 'user',
    created_by_id: null,
    dispatched_at: Date.now() - 300_000,
    awaiting_since: Date.now() - 90_000,
    delivered_at: null,
    ended_at: null,
    created_at: Date.now() - 300_000,
    updated_at: Date.now() - 90_000,
    matter_public_id: 'm-abc',
    matter_title: '供应商比价',
    item_title: '把报价单发给财务',
    item_kind: 'action',
    ...over
  } satisfies MatterItemDispatch
}

beforeEach(async () => {
  state.runs = []
  state.proposals = []
  state.signals = []
  state.dispatches = []
  state.agenda = []
  state.today = { reply: [], nextHardPoint: null }
  state.reports = []
  state.pending = null
  attentionMutate.mockClear()
  dispatchMutate.mockClear()
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => cleanup())

describe('五节主区渲染', () => {
  test('全部源为空 → 引导空态，不渲染任何节', async () => {
    await renderSurface()
    await waitFor(() => {
      expect(screen.getByText(i18n.t('today.empty.title'))).toBeTruthy()
    })
    expect(screen.queryAllByTestId('today-group')).toHaveLength(0)
    expect(screen.queryAllByTestId('today-section')).toHaveLength(0)
  })

  test('五节按固定节序渲染；临期信号落 due 节、失败 run 落 out 节', async () => {
    state.runs = [
      run({ jobId: 2, state: 'failed', finishedAt: Date.now() / 1000 - 60 }),
      run({ jobId: 3, state: 'paused_pending', finishedAt: Date.now() / 1000 - 30, sessionId: 9 })
    ]
    state.signals = [
      {
        id: 11,
        kind: 'wait_overdue',
        state: 'open',
        severity: 'warn',
        why: '等待「供应商报价」已 5 天',
        first_opened_at: Date.now() - 120_000,
        matter: {
          public_id: 'm-abc',
          title: '供应商比价',
          status: 'active',
          health: 'on_track',
          priority: 'p1'
        }
      }
    ]
    await renderSurface()
    await waitFor(() => {
      expect(screen.getAllByTestId('today-group').length).toBeGreaterThan(0)
    })
    // 🔴 三条源分别落三节：paused_pending run → decide、`wait_overdue` 信号 → due
    // （它是「临期」kind，不再混在等你拍板里）、failed run → out。
    expect(
      screen.getAllByTestId('today-section').map((el) => el.getAttribute('data-section'))
    ).toEqual(['decide', 'due', 'out'])
    expect(
      screen
        .getAllByTestId('today-group')
        .map((el) => `${el.getAttribute('data-in-section')}/${el.getAttribute('data-group')}`)
    ).toEqual(['decide/waiting', 'due/waiting', 'out/attention'])
    // 信号的 `why` 直通成 triage 说明（一等字段，行上直读）。
    expect(main().getByText('等待「供应商报价」已 5 天')).toBeTruthy()
    // agent 名（而不是 agentId）当标题。两条 run → 主区恰好两行（时间线那份另计）。
    expect(main().getAllByText('周报 Agent').length).toBe(2)
  })

  test('🔴 stash 命中 → 行上出服务端审批 preview（不是模型自述）', async () => {
    state.runs = [
      run({ jobId: 4, state: 'paused_pending', finishedAt: Date.now() / 1000 - 30, sessionId: 9 })
    ]
    state.pending = {
      approvalId: 'ap-1',
      toolName: 'email_send',
      inputPreview: '发送给 alice@example.test · 主题「本周进展」'
    }
    await renderSurface()
    await waitFor(() => {
      expect(screen.getByText('发送给 alice@example.test · 主题「本周进展」')).toBeTruthy()
    })
    expect(screen.queryByTestId('today-stash-miss')).toBeNull()
  })

  test('🔴 stash miss → 诚实降级成「已失效」，不给批准入口', async () => {
    state.runs = [
      run({ jobId: 5, state: 'paused_pending', finishedAt: Date.now() / 1000 - 30, sessionId: 9 })
    ]
    state.pending = null
    await renderSurface()
    await waitFor(() => {
      expect(screen.getByTestId('today-stash-miss')).toBeTruthy()
    })
    expect(screen.getByTestId('today-stash-miss').textContent).toBe(i18n.t('today.run.stashMiss'))
    // 分组仍由后端读态决定 —— 探测失败不把这条挪去「已失效」组（那是前端自行推导 state）。
    expect(screen.getAllByTestId('today-group').map((el) => el.getAttribute('data-group'))).toEqual(
      ['waiting']
    )
  })
})

// ───────────── L4 批次2 · 信号 dismiss 带理由（prd 验收标准 4） ─────────────
//
// 两步式：点「忽略本次」第一下只展开理由框，第二下（确认）才真正决策 —— 同 `_cardShell.tsx`
// 拒绝理由框的交互样式。resolve/snooze 维持一键，本节不覆盖它们（cardShell/hooks 两处已各自
// 单测过一键路径不受影响）。

describe('信号 dismiss（可选理由）', () => {
  async function openSignalMenuAndDismiss(): Promise<void> {
    state.signals = [signal()]
    await renderSurface()
    await waitFor(() => expect(main().getByText('供应商比价')).toBeTruthy())
    fireEvent.click(screen.getByLabelText(i18n.t('today.menu.trigger')))
    await waitFor(() => expect(screen.getByText('忽略本次')).toBeTruthy())
    fireEvent.click(screen.getByText('忽略本次'))
  }

  test('点「忽略本次」先展开理由框，不立即决策', async () => {
    await openSignalMenuAndDismiss()
    await waitFor(() => expect(screen.getByLabelText('忽略理由（可选）')).toBeTruthy())
    expect(attentionMutate).not.toHaveBeenCalled()
  })

  test('填了理由再确认 → dismissAttention 收到 reason', async () => {
    await openSignalMenuAndDismiss()
    fireEvent.change(await screen.findByLabelText('忽略理由（可选）'), {
      target: { value: '下周对方才有报价，先不用管' }
    })
    fireEvent.click(screen.getByText('确认忽略'))
    expect(attentionMutate).toHaveBeenCalledWith({
      matterId: 'm-abc',
      signalId: 11,
      action: 'dismissed',
      reason: '下周对方才有报价，先不用管'
    })
  })

  test('留空直接确认 → reason 是 undefined（不是空字符串上线）', async () => {
    await openSignalMenuAndDismiss()
    await waitFor(() => expect(screen.getByText('确认忽略')).toBeTruthy())
    fireEvent.click(screen.getByText('确认忽略'))
    expect(attentionMutate).toHaveBeenCalledWith({
      matterId: 'm-abc',
      signalId: 11,
      action: 'dismissed',
      reason: undefined
    })
  })

  test('返回 关掉理由框且不留存草稿（同 _cardShell 的拒绝理由框不变量）', async () => {
    await openSignalMenuAndDismiss()
    fireEvent.change(await screen.findByLabelText('忽略理由（可选）'), {
      target: { value: '先草稿' }
    })
    fireEvent.click(screen.getByText('返回'))
    await waitFor(() => expect(screen.getByText('忽略本次')).toBeTruthy())
    fireEvent.click(screen.getByText('忽略本次'))
    expect(((await screen.findByLabelText('忽略理由（可选）')) as HTMLTextAreaElement).value).toBe(
      ''
    )
    expect(attentionMutate).not.toHaveBeenCalled()
  })

  test('resolve 仍是一键（不经理由框）', async () => {
    state.signals = [signal()]
    await renderSurface()
    await waitFor(() => expect(main().getByText('供应商比价')).toBeTruthy())
    fireEvent.click(screen.getByLabelText(i18n.t('today.menu.trigger')))
    await waitFor(() => expect(screen.getByText('解决')).toBeTruthy())
    fireEvent.click(screen.getByText('解决'))
    expect(attentionMutate).toHaveBeenCalledWith({
      matterId: 'm-abc',
      signalId: 11,
      action: 'resolved'
    })
    expect(screen.queryByLabelText('忽略理由（可选）')).toBeNull()
  })
})

// ───────────── L4 批次3 · 第四源：行动项派发（prd 验收标准 3 / 5） ─────────────
//
// 钉三件事：
//   ① 「等你回答」进「等我处理」组、「失败」进「需要留意」组 —— 两者在屏幕上必须
//      长得不一样（这一整批的卖点）；
//   ② 回答是两步式：点行先展开回答框，填了才提交；
//   ③ 取消派发只在还能取消的态上给入口（`failed` 是终态，服务端会 CAS 拒）。

describe('行动项派发（例外面第四源）', () => {
  test('awaiting_input → 「等我处理」；failed → 「需要留意」，两组分开', async () => {
    state.dispatches = [
      dispatch({ id: 31, item_id: 44, state: 'awaiting_input' }),
      dispatch({
        id: 32,
        item_id: 45,
        state: 'failed',
        question: null,
        item_title: '整理会议纪要',
        error: { code: 'no_report', message: '这一轮没有交付任何东西' },
        awaiting_since: null,
        ended_at: Date.now() - 60_000
      })
    ]
    await renderSurface()
    await waitFor(() => expect(screen.getAllByTestId('today-item').length).toBe(2))
    expect(screen.getAllByTestId('today-group').map((el) => el.getAttribute('data-group'))).toEqual(
      ['waiting', 'attention']
    )
    // 标题是**行动项**，事项名另占一行。
    expect(main().getByText('把报价单发给财务')).toBeTruthy()
    expect(main().getAllByText('供应商比价').length).toBeGreaterThan(0)
    // triage 说明：等你回答 → 反问原文；挂了 → 服务端写的 message。
    expect(main().getByText('要按哪一版报价发？')).toBeTruthy()
    expect(main().getByText('这一轮没有交付任何东西')).toBeTruthy()
    // 🔴 两个态的徽标不同 —— 「在等人」与「死了」分得开。
    expect(
      screen.getAllByTestId('dispatch-state-badge').map((el) => el.getAttribute('data-state'))
    ).toEqual(['awaiting_input', 'failed'])
  })

  test('还在跑 / 已交提案 / 已完成的派发不进面（proposed 由提案源覆盖）', async () => {
    state.dispatches = [
      dispatch({ id: 33, item_id: 46, state: 'running' }),
      dispatch({ id: 34, item_id: 47, state: 'proposed', update_id: 77 }),
      dispatch({ id: 35, item_id: 48, state: 'done', ended_at: Date.now() })
    ]
    await renderSurface()
    await waitFor(() => expect(screen.getByText(i18n.t('today.empty.title'))).toBeTruthy())
    expect(screen.queryAllByTestId('today-item')).toHaveLength(0)
  })

  test('点行先展开回答框，不立即提交；填了才调 answer', async () => {
    state.dispatches = [dispatch()]
    await renderSurface()
    await waitFor(() => expect(main().getByText('把报价单发给财务')).toBeTruthy())
    // 🔴 必须点**主区**那一行：时间线那一列按契约没有点击语义（它是一览，不是第二个入口）。
    fireEvent.click(main().getByText('把报价单发给财务'))
    await waitFor(() => expect(screen.getByTestId('today-dispatch-answer')).toBeTruthy())
    expect(dispatchMutate).not.toHaveBeenCalled()

    // 备选项只**填充**输入框（人可以改），不直接提交。
    fireEvent.click(screen.getByText('第 3 版'))
    expect(dispatchMutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(i18n.t('today.dispatch.answerConfirm')))
    expect(dispatchMutate).toHaveBeenCalledWith({
      matterId: 'm-abc',
      dispatchId: 31,
      action: 'answer',
      text: '第 3 版'
    })
  })

  test('取消派发：awaiting_input 有菜单入口，failed（终态）没有', async () => {
    state.dispatches = [dispatch()]
    await renderSurface()
    await waitFor(() => expect(main().getByText('把报价单发给财务')).toBeTruthy())
    fireEvent.click(screen.getByLabelText(i18n.t('today.menu.trigger')))
    await waitFor(() => expect(screen.getByText(i18n.t('today.dispatch.cancel'))).toBeTruthy())
    fireEvent.click(screen.getByText(i18n.t('today.dispatch.cancel')))
    expect(dispatchMutate).toHaveBeenCalledWith({
      matterId: 'm-abc',
      dispatchId: 31,
      action: 'cancel'
    })

    cleanup()
    state.dispatches = [
      dispatch({ id: 32, state: 'failed', question: null, ended_at: Date.now() - 1000 })
    ]
    await renderSurface()
    await waitFor(() => expect(main().getByText('把报价单发给财务')).toBeTruthy())
    expect(screen.queryByLabelText(i18n.t('today.menu.trigger'))).toBeNull()
  })
})

// ───────────── L4 P4c · 五节 + 硬时间点 ─────────────
//
// 钉四件事：
//   ① 二级栏计数与主区行数**同源** —— 两处各数一遍必然漂开（一处算了过滤、一处没算）。
//   ② 组装不出「为什么是今天」的行**不渲染那一行**，不兜底成一句套话。
//   ③ 「下一个硬时间点」没有时整条不出现（空占一条会把这一行的「现在就看」磨没）。
//   ④ 待回邮件是**要动手**那一档（accent 描边 + 动作钮），会与报告是知会档。

function reply(over: Partial<TodayReplyItem> = {}): TodayReplyItem {
  return {
    id: 'mail:5001',
    source: 'mail',
    title: '关于 6.5 版本兼容表',
    why: '需要回复 · 等了 26 小时',
    meta: '张三',
    atIso: new Date(Date.now() - 26 * 3600_000).toISOString(),
    waitedMs: 26 * 3600_000,
    actionable: true,
    link: { kind: 'mail', internalId: 5001 },
    ...over
  }
}

function endOfToday(): number {
  const d = new Date()
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

function agendaEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  return {
    id: 'mail:uid-1::2026-08-31T06:00:00+00:00',
    source: 'mail',
    hot: false,
    title: 'AW Catch Up · SaaS 2026 Plan',
    startIso: new Date(Date.now() + 90 * 60_000).toISOString(),
    endIso: null,
    allDay: false,
    multiDay: false,
    ...over
  }
}

/** 二级栏那一行的计数徽标（`data-today-nav-count`）。没有 = 那一节是 0 条。 */
function navCount(section: string): number | null {
  const el = document.querySelector(`[data-today-nav-count="${section}"]`)
  return el === null ? null : Number(el.textContent)
}

describe('P4c 五节', () => {
  test('🔴 二级栏计数 = 主区那一节的行数（同源，不是各数一遍）', async () => {
    state.today = {
      reply: [reply(), reply({ id: 'mail:5002', link: { kind: 'mail', internalId: 5002 } })],
      nextHardPoint: null
    }
    state.agenda = [agendaEntry(), agendaEntry({ id: 'mail:uid-2::x', title: '周会' })]
    state.runs = [
      run({ jobId: 3, state: 'paused_pending', finishedAt: Date.now() / 1000 - 30, sessionId: 9 })
    ]
    await renderSurface()
    await waitFor(() => expect(screen.getAllByTestId('today-section').length).toBe(3))

    for (const id of ['decide', 'meet', 'reply'] as const) {
      const section = document.querySelector(`[data-section="${id}"]`)
      expect(section, `缺 ${id} 节`).toBeTruthy()
      const rows =
        (section?.querySelectorAll('[data-testid="today-item"]').length ?? 0) +
        (section?.querySelectorAll('[data-testid="today-section-item"]').length ?? 0)
      expect(navCount(id), `${id}：二级栏计数与主区行数不一致`).toBe(rows)
    }
  })

  test('🔴 组装不出「为什么是今天」→ 那一行不渲染 why，不兜底成套话', async () => {
    state.today = {
      reply: [reply({ why: '', title: '没有理由的那一封' })],
      nextHardPoint: null
    }
    await renderSurface()
    await waitFor(() => expect(screen.getByText('没有理由的那一封')).toBeTruthy())
    const row = screen.getByTestId('today-section-item')
    // 行里只剩标题与 meta 两段文本；why 那一段整个缺席。
    expect(row.textContent).toContain('没有理由的那一封')
    expect(row.textContent).toContain('张三')
    expect(row.textContent).not.toContain('需要回复')
  })

  test('待回邮件是「要动手」档（有动作钮）；报告是知会档（没有）', async () => {
    state.today = { reply: [reply()], nextHardPoint: null }
    state.reports = [
      {
        id: 'rp-1',
        agent_id: 'daily',
        cadence: 'daily',
        report_date: '2026-08-31',
        window_start: '',
        window_end: '',
        status: 'ready',
        counts: { total: 0, attention: 0, handled: 0, fyi: 0 },
        headline: '今天的日报',
        model: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        error: null,
        created_at: Date.now() / 1000,
        generated_at: Date.now() / 1000
      } as ReportListItem
    ]
    await renderSurface()
    await waitFor(() => expect(screen.getAllByTestId('today-section-item').length).toBe(2))
    const rows = screen.getAllByTestId('today-section-item')
    const byActionable = rows.map((el) => el.getAttribute('data-actionable'))
    expect(byActionable).toContain('true')
    expect(byActionable).toContain('false')
    expect(screen.getByText(i18n.t('today.action.openMail'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('today.action.openReport'))).toBeNull()
  })

  test('「下一个硬时间点」：有就出条、没有整条不渲染', async () => {
    state.today = { reply: [reply()], nextHardPoint: null }
    await renderSurface()
    await waitFor(() => expect(screen.getAllByTestId('today-section-item').length).toBe(1))
    expect(screen.queryByTestId('today-next-hard-point')).toBeNull()

    cleanup()
    state.today = {
      reply: [reply()],
      nextHardPoint: agendaEntry({ title: 'AW Catch Up · SaaS 2026 Plan' })
    }
    await renderSurface()
    await waitFor(() => expect(screen.getByTestId('today-next-hard-point')).toBeTruthy())
    const bar = screen.getByTestId('today-next-hard-point')
    expect(bar.textContent).toContain('AW Catch Up · SaaS 2026 Plan')
    // 「还剩多久」是现算的。不断言到分钟：`nowMs` 是 react-query 的落地时刻，比
    // fixture 造出来的 startIso 晚几十毫秒，写死 30 分会变成 flaky（29 分）。
    // 分钟档的逐档取值由 `remainingLabel` 的纯单测钉（todaySections.test.ts）。
    expect(bar.textContent).toMatch(/1 小时/)
    expect(bar.textContent).not.toContain(i18n.t('today.next.started'))
  })

  // ── P5 右侧时间线列 ──
  //
  // 算法在 `todayTimelineRows.test.ts` 单测；这里只钉「它真的接上了这一页」：列在场 · 条目
  // 用的是五节那份数据（不是第二个源）· 一条都没有时说清为什么空。

  test('时间线列在场，且吃的是五节那份数据（不另开源）', async () => {
    // 时间线只收「今天」的条目：默认 fixture 的 +90 分钟在本地 22:30 之后会跨到明天而闪断
    //（2026-09-02 全量闸复现），这里钳在今天 23:59 之内。别的用例要的是「还有 1 小时」的相对时长，
    // 默认值不动。
    state.agenda = [
      agendaEntry({
        title: 'AW Catch Up · SaaS 2026 Plan',
        startIso: new Date(Math.min(Date.now() + 90 * 60_000, endOfToday())).toISOString()
      })
    ]
    await renderSurface()
    await waitFor(() => expect(screen.getByTestId('today-timeline')).toBeTruthy())
    const column = screen.getByTestId('today-timeline')
    expect(column.textContent).toContain(i18n.t('today.timeline.title'))
    expect(column.textContent).toContain('AW Catch Up · SaaS 2026 Plan')
    // 「现在」那条线恒在场（下一条还没到 → 插在它前面）。
    expect(screen.getByTestId('today-timeline-now')).toBeTruthy()
  })

  test('今天没有带时刻的条目 → 空态说清为什么，不是「暂无」', async () => {
    // 待回邮件的 atMs 是它**到达**的时刻：26 小时前那封落在昨天，进不了今天的时间线。
    state.today = { reply: [reply()], nextHardPoint: null }
    await renderSurface()
    await waitFor(() => expect(screen.getByTestId('today-timeline')).toBeTruthy())
    expect(screen.getByTestId('today-timeline').textContent).toContain(
      i18n.t('today.timeline.empty')
    )
    expect(screen.queryAllByTestId('today-timeline-row')).toHaveLength(0)
  })

  test('会议行的 why 说的是几点开始（不是空话）', async () => {
    state.agenda = [agendaEntry()]
    await renderSurface()
    await waitFor(() => expect(screen.getByTestId('today-section-item')).toBeTruthy())
    const time = new Date(Date.parse(state.agenda[0].startIso)).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    })
    expect(main().getByText(i18n.t('today.why.meetUpcoming', { time }))).toBeTruthy()
  })
})
