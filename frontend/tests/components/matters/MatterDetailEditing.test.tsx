// @vitest-environment happy-dom
//
// 批次 2b —— G-11 条目行编辑与 meta（行内改标题 / 删除 / 状态 Pip / 等 {人} / 到期）
// + G-08 等待条（展示 / 就地编辑 / 清除）。写路径必须是用户直接操作（patchItem /
// deleteItem / patch，带乐观锁），不是 Agent 提案。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Matter, MatterItem, MatterStakeholder } from '@shared/api/types/matter'
import i18n from '@shared/i18n'

const { mattersApi } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    patch: vi.fn(),
    patchItem: vi.fn(),
    deleteItem: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    getUpdate: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [] as MatterStakeholder[])
  }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterFlags: () => ({ mattersEnabled: true, matterAgentEnabled: false }),
  useMatterRuns: () => ({ data: undefined, isLoading: false }),
  useMatterUpdates: () => ({ data: undefined, isLoading: false }),
  useStartMatterRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMatterAgentProfiles: () => ({ data: [], isLoading: false }),
  useMatterAttention: () => ({ data: undefined, isLoading: false })
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.patch.mockResolvedValue({ matter: matter() })
  mattersApi.patchItem.mockResolvedValue({ matter: matter() })
  mattersApi.deleteItem.mockResolvedValue({ matter: matter() })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
})

afterEach(cleanup)

describe('G-11 — 条目行 meta 与行内编辑', () => {
  test('meta 行渲染状态 Pip、「等 {人}」与到期；数据没有的字段不出现', async () => {
    mattersApi.listStakeholders.mockResolvedValue([stakeholder({ is_waiting_on: false })])
    renderDetail({
      items: [
        item({
          id: 7,
          status: 'blocked',
          waiting_on_stakeholder_id: 31,
          due_at: Date.now() + 40 * 86_400_000
        })
      ]
    })

    expect(await screen.findByText('推进联调')).toBeTruthy()
    // 事项本身是 active（状态 chip「进行中」），条目 Pip 用 blocked 档避免同文案撞车。
    expect(await screen.findByText('受阻')).toBeTruthy()
    expect(await screen.findByText(/等 谭工/)).toBeTruthy()
    expect(screen.getByText(/到期$/)).toBeTruthy()
    // 设计 mock-only 的「已阻塞 {时长}」没有数据判据，不渲染。
    expect(screen.queryByText(/已阻塞/)).toBeNull()
  })

  test('行内改标题走 patchItem（用户直接操作 + 乐观锁）', async () => {
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getAllByRole('button', { name: '编辑标题' })[0])
    const input = screen.getByRole('textbox', { name: '编辑标题' })
    fireEvent.change(input, { target: { value: '推进二期联调' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(mattersApi.patchItem).toHaveBeenCalledWith(
        'MAT-0042',
        7,
        { title: '推进二期联调' },
        { expectedVersion: 3 }
      )
    )
  })

  test('删除条目走 deleteItem（软删，后端留恢复通道）', async () => {
    renderDetail({ items: [item({ id: 7 })] })
    await screen.findByText('推进联调')

    fireEvent.click(screen.getAllByRole('button', { name: '删除条目' })[0])
    await waitFor(() =>
      expect(mattersApi.deleteItem).toHaveBeenCalledWith('MAT-0042', 7, { expectedVersion: 3 })
    )
  })
})

describe('G-08 — 等待条', () => {
  test('waiting_context 与等待中干系人合成一行 warn 文案', async () => {
    mattersApi.listStakeholders.mockResolvedValue([stakeholder()])
    renderDetail({ matterOverrides: { waiting_context: { note: '等法务意见' } } })

    expect(await screen.findByText(/等待 谭工 · 等法务意见/)).toBeTruthy()
  })

  test('就地编辑保存为 {note} dict；清除写 null（DIRECT_PATCH_FIELDS 通道）', async () => {
    renderDetail({ matterOverrides: { waiting_context: { note: '等报价' } } })
    const bar = await screen.findByTitle('编辑等待原因')

    fireEvent.click(bar)
    const input = screen.getByRole('textbox', { name: '编辑等待原因' })
    fireEvent.change(input, { target: { value: '等法务意见' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { waiting_context: { note: '等法务意见' } },
        { expectedVersion: 3 }
      )
    )

    mattersApi.patch.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '清除等待原因' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { waiting_context: null },
        { expectedVersion: 3 }
      )
    )
  })

  test('没有等待事实时整条不渲染', async () => {
    renderDetail({})
    await screen.findByText('Vendor launch')
    expect(screen.queryByTitle('编辑等待原因')).toBeNull()
  })
})

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

function stakeholder(overrides: Partial<MatterStakeholder> = {}): MatterStakeholder {
  return {
    id: 31,
    matter_id: 42,
    person_key: 'pk-31',
    display_name: '谭工',
    email_normalized: 'tan@b.test',
    organization: null,
    role: null,
    relationship: null,
    is_waiting_on: true,
    last_contact_at: null,
    source_resource_id: null,
    deleted_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides
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
    description: '',
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
