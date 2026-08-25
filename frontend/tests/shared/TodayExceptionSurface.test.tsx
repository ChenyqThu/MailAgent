// @vitest-environment happy-dom
//
// 例外面的渲染闸（L4 批次 2）。分组算法本身在 `todayGroups.test.ts` 单测，这里钉的是**页面
// 真的接得起来**：三条源 → 分组 → 行；以及那条最容易做假的行为 ——
//
//   🔴 `paused_pending` 行的可操作性由 live 查 `/approval/pending` 决定，miss（gateway 重启 /
//      TTL 过期）必须**诚实降级**成「已失效」，不能画一个按了没反应的批准入口。
//
// 三条读端点全 mock 在 hook 边界（与 sidebar-contract 同款做法）：真实网络在 happy-dom 下
// 只会变成一屏 CORS 噪声，测不出任何东西。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import type { AgentRunHistoryItem } from '../../src/shared/api/types'
import type {
  MatterAttentionSignal,
  MatterPendingUpdatesEntry
} from '../../src/shared/api/types/matter'

const { state, attentionMutate } = vi.hoisted(() => ({
  state: {
    runs: [] as AgentRunHistoryItem[],
    proposals: [] as MatterPendingUpdatesEntry[],
    signals: [] as MatterAttentionSignal[],
    /** `fetchPendingApproval` 的返回：null = stash miss（gateway 重启 / 已被别处消费）。 */
    pending: null as { approvalId: string; toolName: string; inputPreview: string } | null
  },
  // 单独 hoist：`useAttentionAction` 的 mock 每次都要返回**同一个**间谍，测试才断言得到调用。
  attentionMutate: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      listRuns: vi.fn(async () => ({ items: state.runs, total: state.runs.length })),
      getConfig: vi.fn(async () => [
        { id: 'weekly-digest', type: 'custom', enabled: true, title: '周报 Agent' }
      ])
    }
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
  useAttentionAction: () => ({ mutate: attentionMutate })
}))

vi.mock('@shared/assistant/approvalRecordClient', () => ({
  fetchPendingApproval: vi.fn(async () => state.pending),
  postApprovalDecide: vi.fn(),
  postRememberWebPolicy: vi.fn()
}))

// Importing after the mocks are registered.
import { TodayExceptionSurface } from '../../src/shared/components/today/TodayExceptionSurface'

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
        <TodayExceptionSurface />
        <Outlet />
      </I18nextProvider>
    )
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/today', '/matters', '/sessions'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
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

beforeEach(async () => {
  state.runs = []
  state.proposals = []
  state.signals = []
  state.pending = null
  attentionMutate.mockClear()
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => cleanup())

describe('例外面渲染', () => {
  test('三源全空 → 引导空态，不渲染任何分组', async () => {
    await renderSurface()
    await waitFor(() => {
      expect(screen.getByText(i18n.t('today.empty.title'))).toBeTruthy()
    })
    expect(screen.queryAllByTestId('today-group')).toHaveLength(0)
  })

  test('分组按固定组序渲染，「等我处理」恒在最上', async () => {
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
    expect(screen.getAllByTestId('today-group').map((el) => el.getAttribute('data-group'))).toEqual(
      ['waiting', 'attention']
    )
    // 信号的 `why` 直通成 triage 说明（一等字段，行上直读）。
    expect(screen.getByText('等待「供应商报价」已 5 天')).toBeTruthy()
    // agent 名（而不是 agentId）当标题。
    expect(screen.getAllByText('周报 Agent').length).toBe(2)
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
    await waitFor(() => expect(screen.getByText('供应商比价')).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText('供应商比价')).toBeTruthy())
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
