// @vitest-environment happy-dom
//
// task 08-20 P0-2 —— 详情页的「换一条事项」体验。旧行为：key 一变 data 就塌成 undefined，
// 整面缩成一行「加载中」文字（owner 说的「跳转体验不好」的直接来源）。新行为：
//   · 首次进入（没有上一条可留）→ 骨架，不是一行文字；
//   · 换选中事项 → 保留上一条内容 + 压暗一档，新数据到达再整体换掉；
//   · 🔴 占位期间**冻结交互**：此刻 `matterId` 已是新的、`matter.version` 还是上一条的，
//     任何一次写都会带着这对不匹配的组合发出去（乐观锁必然打回）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'

const { mattersApi } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    patch: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    getUpdate: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [])
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
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
})
afterEach(cleanup)

describe('MatterDetail 加载占位（task 08-20）', () => {
  test('首次加载出骨架，不是一行「加载中」文字', async () => {
    // 🔴 初值给一个 no-op 而不是 null：Promise executor 是同步跑的，赋值必定先于调用；
    // 写成 `| null` 只会让 TS 在调用点把它窄化成 null（typecheck:tests 会红）。
    let resolveFirst: () => void = () => {}
    mattersApi.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ matter: matter(), items: [], timeline: [] })
        })
    )
    renderDetail('MAT-0042')

    expect(screen.getByTestId('matter-detail-skeleton')).toBeTruthy()
    expect(screen.queryByText('加载中…')).toBeNull()

    resolveFirst()
    expect(await screen.findByText('Vendor launch')).toBeTruthy()
  })

  test('换一条事项：上一条内容留在屏上并被冻结，新数据到达后整体换掉', async () => {
    mattersApi.get.mockResolvedValue({ matter: matter(), items: [], timeline: [] })
    const view = renderDetail('MAT-0042')
    await screen.findByText('Vendor launch')

    // 第二条的请求挂着不回 —— 这就是「占位期」。
    let resolveSecond: () => void = () => {}
    mattersApi.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSecond = () =>
            resolve({
              matter: matter({ id: 43, public_id: 'MAT-0043', title: 'Contract renewal' }),
              items: [],
              timeline: []
            })
        })
    )
    view.rerender(view.wrap(detail('MAT-0043')))

    // 上一条的标题还在（没有塌成骨架 / 加载中），整棵树被压暗且不可交互。
    const title = await screen.findByText('Vendor launch')
    expect(screen.queryByTestId('matter-detail-skeleton')).toBeNull()
    const root = title.closest('[aria-busy="true"]')
    expect(root).toBeTruthy()
    expect(root?.className).toContain('pointer-events-none')

    resolveSecond()
    expect(await screen.findByText('Contract renewal')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull())
  })
})

function detail(matterId: string): React.ReactElement {
  return <MatterDetail matterId={matterId} onBack={vi.fn()} onRemoved={vi.fn()} />
}

/** rerender 时必须连 Provider 一起给（`render` 返回的 rerender 换的是整棵树）。 */
function renderDetail(matterId: string): ReturnType<typeof render> & {
  wrap(node: React.ReactElement): React.ReactElement
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const wrap = (node: React.ReactElement): React.ReactElement => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  )
  return { ...render(wrap(detail(matterId))), wrap }
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
