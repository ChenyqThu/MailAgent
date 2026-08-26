// @vitest-environment happy-dom
//
// 轮 3 #2 —— 详情头四个选择控件按设计复刻后的行为契约：
//   • 状态：chip 打开的是设计 create.jsx:108-131 的**模态**（「更改业务状态」+ 八档行），
//     不再是 shadcn Select 下拉；选一档 → patch({ status })（乐观锁）。
//   • 标签：创建流带 StylePicker —— 默认样式只写 matter.tags（与旧隐式建标签路径同）；
//     选了非默认样式才额外 upsert 定义行（api.setTagStyle）。
// 优先级（Popmenu 面板）走 MatterChatSurfaces.test 的既有交互链，不在这里重复。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Matter, MatterStakeholder } from '@shared/api/types/matter'
import i18n from '@shared/i18n'

const { mattersApi } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    patch: vi.fn(),
    listTags: vi.fn(async () => ({ items: [] })),
    setTagStyle: vi.fn(async () => ({})),
    listUpdates: vi.fn(async () => ({ items: [] })),
    getUpdate: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [] as MatterStakeholder[])
  }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMatterChatApi: () => ({ contextSnapshot: vi.fn(), applyUndo: vi.fn() }),
  useMattersApi: () => mattersApi,
  useMatterFlags: () => ({ mattersEnabled: true, matterAgentEnabled: false }),
  useMatterRuns: () => ({ data: undefined, isLoading: false }),
  useMatterPendingUpdates: () => ({ data: undefined, isLoading: false }),
  useStartMatterRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMatterAgentProfiles: () => ({ data: [], isLoading: false }),
  // L4 批次3：行动项执行契约的取数口（详情页整块挂 matterAgentEnabled）。
  useMatterItemDispatches: () => ({ data: [], isLoading: false }),
  useMatterAttention: () => ({ data: undefined, isLoading: false })
}))
vi.mock('@shared/state/toast', () => ({
  useToastStore: { getState: () => ({ push: vi.fn(), dismiss: vi.fn() }) },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.patch.mockResolvedValue({ matter: matter() })
  mattersApi.setTagStyle.mockResolvedValue({})
  mattersApi.listTags.mockResolvedValue({ items: [] })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
})

afterEach(cleanup)

describe('状态选择面 = 设计的模态', () => {
  test('chip 打开「更改业务状态」模态，选一档 → patch({ status })', async () => {
    renderDetail()
    await screen.findByText('Vendor launch')

    fireEvent.click(screen.getByRole('button', { name: '事项状态' }))
    const dialog = await screen.findByRole('dialog', { name: '更改业务状态' })
    expect(dialog.textContent).toContain('状态变更会写入时间线')

    fireEvent.click(screen.getByRole('option', { name: '已完成' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { status: 'done' },
        { expectedVersion: 3 }
      )
    )
    // 选完即收（设计 StatusMenu：onPick 后 onClose）。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '更改业务状态' })).toBeNull())
  })

  test('选中当前档不发写请求，Esc 关闭', async () => {
    renderDetail()
    await screen.findByText('Vendor launch')

    fireEvent.click(screen.getByRole('button', { name: '事项状态' }))
    await screen.findByRole('dialog', { name: '更改业务状态' })
    fireEvent.click(screen.getByRole('option', { name: '进行中' }))
    expect(mattersApi.patch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '事项状态' }))
    await screen.findByRole('dialog', { name: '更改业务状态' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '更改业务状态' })).toBeNull())
    expect(mattersApi.patch).not.toHaveBeenCalled()
  })
})

describe('标签创建流（设计 TagPicker + StylePicker）', () => {
  test('默认样式：只写 matter.tags，不 upsert 定义行', async () => {
    renderDetail()
    await screen.findByText('Vendor launch')

    fireEvent.click(screen.getByRole('button', { name: '标签' }))
    const input = await screen.findByPlaceholderText('搜索或创建标签')
    fireEvent.change(input, { target: { value: '上线' } })
    fireEvent.click(await screen.findByText('创建标签「上线」'))

    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { tags: ['上线'] },
        { expectedVersion: 3 }
      )
    )
    expect(mattersApi.setTagStyle).not.toHaveBeenCalled()
  })

  test('选了非默认样式：额外 setTagStyle upsert（形状 + 颜色）', async () => {
    renderDetail()
    await screen.findByText('Vendor launch')

    fireEvent.click(screen.getByRole('button', { name: '标签' }))
    const input = await screen.findByPlaceholderText('搜索或创建标签')
    fireEvent.change(input, { target: { value: '上线' } })

    fireEvent.click(await screen.findByRole('button', { name: '样式' }))
    fireEvent.click(await screen.findByRole('button', { name: '方块' }))
    fireEvent.click(screen.getByRole('button', { name: '严重色' }))
    fireEvent.click(screen.getByText('创建标签「上线」'))

    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { tags: ['上线'] },
        { expectedVersion: 3 }
      )
    )
    await waitFor(() =>
      expect(mattersApi.setTagStyle).toHaveBeenCalledWith(
        '上线',
        { color: '--c-crit', shape: 'square' },
        { reason: 'user_updated_matter_tag_style' }
      )
    )
  })
})

function renderDetail(): ReturnType<typeof render> {
  mattersApi.get.mockResolvedValue({ matter: matter(), items: [], timeline: [] })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterDetail matterId="MAT-0042" onBack={vi.fn()} onRemoved={vi.fn()} />
    </QueryClientProvider>
  )
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
