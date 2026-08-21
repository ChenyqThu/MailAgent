// @vitest-environment happy-dom
//
// V3-11 —— 「记住上次选中」冷启动判定的行为闸（设计 HANDOFF-列表与资料-v3.md §1）。
// MatterList/MatterDetail/MatterFocus 全部换成瘦身桩：这五个用例钉的是 MattersWorkspace 自己
// 的 selectedId/tab 编排（存/取「上次选中」、有记录/无记录/记录已不可见三路分叉、切 tab 不
// 清空选中、深链跳转优先级更高），不是那三个组件各自的渲染细节——它们已经有自己的测试文件。
//
// 🔴 持久化层走 `vi.mock('@shared/components/matters/matterLastSelected')` 换成内存实现，
// 不碰真实 `localStorage`：本仓当前 vitest + happy-dom + Node 组合下，happy-dom 环境里裸
// `localStorage`/`window.localStorage` 本身就取不到（`tests/components/CommandPalette.test.tsx`
// 的 `localStorage.clear()` 也包了一层 try/catch 才没红，实测在这里两者皆 `undefined`）——
// 拆出独立小模块正是为了让这条闸不依赖这个环境限制。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'

await i18n.changeLanguage('zh-CN')

// vi.mock 的调用会被提升到文件顶部（早于下面的 import/const）——固定装置必须走
// vi.hoisted，直接在下面 const 里引用会撞 TDZ（vitest 官方文档明写的坑）。
const { A, B, C, TEST_MATTERS, lastSelectedStore } = vi.hoisted(() => {
  function matter(overrides: Record<string, unknown> = {}): Matter {
    return {
      id: 1,
      public_id: 'MAT-0001',
      title: 'Ship the release',
      background: '',
      goal: '',
      matter_type: null,
      tags: [],
      status: 'active',
      health: 'unknown',
      priority: 'p1',
      owner_id: null,
      source: 'manual',
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
      version: 1,
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
    } as Matter
  }
  // B 的优先级（p0）压过 A（p2），是默认排序（rank）下「无记录 → 选第一条」的自然落点；
  // A 不是自然第一名，专门用来证明「有记录」时读的确实是持久化记录、不是巧合命中第一条。
  // C 已归档（task 08-14 起默认 scope='all' 含 done/canceled，「已完成」不再是「已不可见」
  // 的落点 —— 只有 archived/trash 才是；下面的 mock `list()` 照真实服务端「无参数 → 只回
  // 活跃行」语义把它挡在 liveMatters 之外，用来钉「有记录但已不可见」的退化路径）。
  const a = matter({ public_id: 'MAT-0001', priority: 'p2' })
  const b = matter({ public_id: 'MAT-0002', priority: 'p0' })
  const c = matter({ public_id: 'MAT-0003', priority: 'p3', archived_at: 10 })
  return {
    A: a,
    B: b,
    C: c,
    TEST_MATTERS: [a, b, c],
    lastSelectedStore: { value: null as string | null }
  }
})

vi.mock('@shared/components/matters/matterLastSelected', () => ({
  readLastSelectedMatterId: () => lastSelectedStore.value,
  writeLastSelectedMatterId: (publicId: string) => {
    lastSelectedStore.value = publicId
  }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({
    // MattersWorkspace 冷启动只发一个无参数的 `list()`（liveMatters）——照真实服务端
    // 默认子句 `deleted_at IS NULL AND archived_at IS NULL` 过滤，C（已归档）不进活跃集。
    list: async () => {
      const items = TEST_MATTERS.filter(
        (matter) => matter.archived_at == null && matter.deleted_at == null
      )
      return { items, total: items.length }
    }
  }),
  useMatterFlags: () => ({ mattersEnabled: true, matterAgentEnabled: false }),
  usePendingMatterUpdates: () => ({ data: undefined, isLoading: false }),
  useGlobalAttention: () => ({ data: { items: [] } }),
  useAttentionAction: () => ({ mutate: vi.fn() })
}))

vi.mock('@shared/components/matters/MatterFocus', () => ({
  MatterFocus: () => <div data-testid="matter-focus" />
}))
vi.mock('@shared/components/matters/MatterList', () => ({
  MatterList: (props: { selectedId: string | null; matters: readonly unknown[] }) => (
    <div
      data-testid="matter-list"
      data-selected-id={props.selectedId ?? ''}
      data-matter-count={props.matters.length}
    />
  )
}))
vi.mock('@shared/components/matters/MatterDetail', () => ({
  MatterDetail: (props: { matterId: string }) => (
    <div data-testid="matter-detail" data-matter-id={props.matterId} />
  )
}))
vi.mock('@shared/components/matters/MatterCreateDialog', () => ({ MatterCreateDialog: () => null }))
vi.mock('@shared/components/matters/MatterTagManagerModal', () => ({
  MatterTagManagerModal: () => null
}))

const { MattersWorkspace } = await import('@shared/components/matters/MattersWorkspace')
const { useMatterNavigation } = await import('@shared/components/matters/navigation')

function renderWorkspace(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MattersWorkspace />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  lastSelectedStore.value = null
  useMatterNavigation.setState({ targetPublicId: null })
})
afterEach(cleanup)

describe('MattersWorkspace — V3-11 记住上次选中', () => {
  test('有记录且可见 → 落「事项」tab 并选中那条', async () => {
    lastSelectedStore.value = A.public_id
    renderWorkspace()

    const detail = await screen.findByTestId('matter-detail')
    expect(detail.getAttribute('data-matter-id')).toBe(A.public_id)
    expect(screen.getByRole('tab', { name: '事项' }).getAttribute('aria-selected')).toBe('true')
  })

  test('有记录但已不可见（已归档）→ 退化成选第一条，且不强制切 tab', async () => {
    lastSelectedStore.value = C.public_id
    renderWorkspace()

    // 冷启动默认落看板；只有「有记录且可见」才会被拽去事项 tab —— 退化路径不该顺带改动 tab。
    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '事项' }))

    const list = await screen.findByTestId('matter-list')
    await waitFor(() => expect(list.getAttribute('data-selected-id')).toBe(B.public_id))
  })

  test('无记录 → 选第一条，且不强制切 tab', async () => {
    renderWorkspace()

    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '事项' }))

    const list = await screen.findByTestId('matter-list')
    await waitFor(() => expect(list.getAttribute('data-selected-id')).toBe(B.public_id))
  })

  test('切到「看板」不清空选中，切回来仍是原来那条', async () => {
    lastSelectedStore.value = A.public_id
    renderWorkspace()

    expect((await screen.findByTestId('matter-detail')).getAttribute('data-matter-id')).toBe(
      A.public_id
    )

    fireEvent.click(screen.getByRole('tab', { name: '看板' }))
    expect(await screen.findByTestId('matter-focus')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '事项' }))
    const detail = await screen.findByTestId('matter-detail')
    expect(detail.getAttribute('data-matter-id')).toBe(A.public_id)
  })

  test('深链跳转（useMatterNavigation）压过冷启动初选', async () => {
    lastSelectedStore.value = A.public_id
    useMatterNavigation.getState().open(B.public_id)
    renderWorkspace()

    const detail = await screen.findByTestId('matter-detail')
    await waitFor(() => expect(detail.getAttribute('data-matter-id')).toBe(B.public_id))
    expect(useMatterNavigation.getState().targetPublicId).toBeNull()
  })
})

// task 08-14 —— PRD §5 验收第三条：范围默认 all，已归档/回收站的事项不出现。这里不是靠
// matterInScope 挡（scope='all' 对它恒真），而是靠 liveMatters 本身就是服务端「无参数只回
// 活跃行」的结果集 —— C（已归档）从未进入这份数据，「全部」自然只剩 A、B 两条。
describe('MattersWorkspace — scope 默认 all（task 08-14）', () => {
  test('已归档事项不出现在默认「全部」范围下的清单里', async () => {
    renderWorkspace()
    fireEvent.click(screen.getByRole('tab', { name: '事项' }))

    const list = await screen.findByTestId('matter-list')
    await waitFor(() => expect(list.getAttribute('data-matter-count')).toBe('2'))
  })
})
