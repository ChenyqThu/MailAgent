// @vitest-environment happy-dom
//
// 进展 tab = curated lane（task 08-25）。这一屏的判据只有一条，但它是整个改动的立身之本：
// **显示的是 `matter_progress` 条目，不是 `matter_event` 的降级映射**。事件那一路只在
// 操作日志弹窗里（`MatterAuditLogModal.test.tsx`）。
//
// 其余覆盖：按天分组 · 空态与引导 · composer 提交的调用形状（含乐观锁基线）· 行内编辑 /
// 软删 · 弹窗入口。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { MatterEvent, MatterProgress } from '@shared/api/types/matter'

const { mattersApi, chatApi } = vi.hoisted(() => ({
  mattersApi: {
    createProgress: vi.fn(),
    patchProgress: vi.fn(),
    deleteProgress: vi.fn()
  },
  chatApi: { contextSnapshot: vi.fn(), applyUndo: vi.fn() }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => chatApi,
  useMattersEnabled: () => true
}))

const { MatterProgressLane } = await import('@shared/components/matters/MatterProgressLane')

const T0 = Date.UTC(2026, 7, 12, 17, 30, 0)

let sequence = 0
function entry(partial: Partial<MatterProgress> = {}): MatterProgress {
  sequence += 1
  return {
    id: sequence,
    matter_id: 1,
    kind: 'progress',
    title: `进展 ${sequence}`,
    body: null,
    happened_at: T0,
    actor_kind: 'user',
    actor_id: null,
    source: 'desktop_ui',
    refs: [],
    version: 1,
    deleted_at: null,
    created_at: T0,
    updated_at: T0,
    ...partial
  }
}

function event(partial: Partial<MatterEvent> & { kind: string }): MatterEvent {
  sequence += 1
  return {
    id: sequence,
    matter_id: 1,
    happened_at: T0,
    actor_kind: 'user',
    actor_id: null,
    source: 'desktop_ui',
    item_id: null,
    update_id: null,
    resource_id: null,
    reverses_event_id: null,
    dedupe_key: `dedupe-${sequence}`,
    payload: {},
    created_at: T0,
    ...partial
  }
}

function renderLane(entries: readonly MatterProgress[], events: readonly MatterEvent[] = []): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <MatterProgressLane
        matterId="MAT-0042"
        matterVersion={7}
        entries={entries}
        events={events}
        locale="zh-CN"
      />
    </QueryClientProvider>
  )
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('matter-progress-entry')
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.createProgress.mockResolvedValue({})
  mattersApi.patchProgress.mockResolvedValue({})
  mattersApi.deleteProgress.mockResolvedValue({})
})

afterEach(cleanup)

describe('MatterProgressLane', () => {
  it('渲染 curated 条目：主句 + 正文 + kind 标签', () => {
    renderLane([
      entry({
        kind: 'decision',
        title: 'Simon 回邮确认 Q4 预算',
        body: '预算按 120k 走，法务下周出合同。',
        actor_kind: 'agent'
      })
    ])
    expect(screen.getByText('Simon 回邮确认 Q4 预算')).toBeTruthy()
    expect(screen.getByTestId('matter-narrative-body').textContent).toContain(
      '预算按 120k 走，法务下周出合同。'
    )
    expect(screen.getByText('· 决议')).toBeTruthy()
    // agent 写的那条挂 ai pill（与事件时间线同一套 actor 词汇）。
    expect(within(rows()[0]).getByText('Agent')).toBeTruthy()
  })

  it('🔴 操作事件不进这一屏 —— 进展不再是事件的降级映射', () => {
    renderLane(
      [entry({ title: '把合同发给对方法务' })],
      [
        event({
          kind: 'matter_updated',
          payload: {
            fields: ['status'],
            changes: [{ field: 'status', from: 'active', to: 'waiting' }]
          }
        }),
        event({ kind: 'matter_created' })
      ]
    )
    expect(rows()).toHaveLength(1)
    expect(screen.queryByText('状态 进行中 → 等待中')).toBeNull()
    expect(screen.queryByText('创建了事项')).toBeNull()
    // 降级说明条随之退役（它说的那件事已经不成立了）。
    expect(screen.queryByText(/这条线由已有记录生成/)).toBeNull()
    // 事件仍然可达 —— 在操作日志里，一条不少。
    fireEvent.click(screen.getByRole('button', { name: '查看操作日志' }))
    expect(screen.getAllByTestId('matter-audit-entry')).toHaveLength(2)
  })

  it('按叙事时间分天（跨天的两条各有一个天头）', () => {
    renderLane([
      entry({ happened_at: T0 }),
      entry({ happened_at: T0 - 3 * 86_400_000, kind: 'goal' })
    ])
    expect(screen.getAllByTestId('matter-progress-day')).toHaveLength(2)
    expect(rows()).toHaveLength(2)
  })

  it('空态给引导语与「记一条」的入口，不回落到事件视图', () => {
    renderLane([], [event({ kind: 'matter_created' })])
    expect(screen.getByText('还没有进展记录。')).toBeTruthy()
    expect(screen.getByText(/Agent 会日常维护/)).toBeTruthy()
    expect(rows()).toHaveLength(0)
    // 脚注仍指向操作日志（事件不是没了，是搬了家）。
    expect(screen.getByText(/都在操作日志里（1 条）/)).toBeTruthy()
  })

  it('composer 提交：kind / 主句 / 正文 + 渲染那一刻的乐观锁基线', async () => {
    renderLane([])
    fireEvent.click(screen.getAllByRole('button', { name: /记进展/ })[0])
    fireEvent.click(screen.getByRole('button', { name: '信号' }))
    fireEvent.change(screen.getByLabelText('一句话说清发生了什么'), {
      target: { value: '  对方法务两周没回  ' }
    })
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: '已经催过两次。' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mattersApi.createProgress).toHaveBeenCalledTimes(1))
    expect(mattersApi.createProgress).toHaveBeenCalledWith(
      'MAT-0042',
      { kind: 'signal', title: '对方法务两周没回', body: '已经催过两次。' },
      { expectedVersion: 7 }
    )
  })

  it('主句为空时存不下去（一条没有主句的进展在时间轴上是个读不懂的点）', () => {
    renderLane([])
    fireEvent.click(screen.getAllByRole('button', { name: /记进展/ })[0])
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('一句话说清发生了什么'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
  })

  it('行内编辑改的是这一条（PATCH 带行 id）', async () => {
    renderLane([entry({ id: 9, title: '旧主句', kind: 'progress' })])
    fireEvent.click(screen.getByRole('button', { name: '编辑这条进展' }))
    fireEvent.change(screen.getByLabelText('一句话说清发生了什么'), {
      target: { value: '新主句' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mattersApi.patchProgress).toHaveBeenCalledTimes(1))
    expect(mattersApi.patchProgress).toHaveBeenCalledWith(
      'MAT-0042',
      9,
      { kind: 'progress', title: '新主句', body: null },
      { expectedVersion: 7 }
    )
  })

  it('删除走软删端点（服务端留 restore，toast 上才有撤销）', async () => {
    renderLane([entry({ id: 11 })])
    fireEvent.click(screen.getByRole('button', { name: '删除这条进展' }))
    await waitFor(() => expect(mattersApi.deleteProgress).toHaveBeenCalledTimes(1))
    expect(mattersApi.deleteProgress).toHaveBeenCalledWith('MAT-0042', 11, { expectedVersion: 7 })
  })

  it('证据链：url 可点，认不出的形态只渲染成标签', () => {
    renderLane([
      entry({
        refs: [
          { type: 'url', url: 'https://vendor.test/contract' },
          { type: 'email', message_id: '<a@b.test>' }
        ]
      })
    ])
    expect(screen.getByRole('button', { name: /vendor.test\/contract/ })).toBeTruthy()
    // email 引用没有可用的跳转链路 ⇒ 只出标签，不出一个点了报错的按钮。
    expect(screen.getByText('邮件')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '邮件' })).toBeNull()
  })
})
