// @vitest-environment happy-dom
//
// D14（0813 dogfood）—— 详情右上角「更多」菜单的**收起**行为。
//
// 🔴 为什么要单独一道闸：改动前这个菜单只有「再点一次触发器」一条关闭路径 —— 点正文、切
// tab、滚动、按 Esc 全都关不掉，它就一直挂在右上角压着内容。这类缺陷不会让任何既有测试变红
// （渲染、点击、mutation 全都正常），只有从「点外部之后它还在不在」这个角度钉才拦得住。
//
// 判据取触发器的 `aria-expanded`（同步的状态真相）+ 菜单节点最终从 DOM 消失（菜单接了
// `useExitAnimation`，退场播完才卸载，所以后者必须 waitFor）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'

const { mattersApi } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    list: vi.fn(),
    patch: vi.fn(),
    getUpdate: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => []),
    archive: vi.fn(),
    reopen: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn()
  }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => ({ contextSnapshot: vi.fn() }),
  useMattersEnabled: () => true,
  useMatterFlags: () => ({ mattersEnabled: true, matterAgentEnabled: false }),
  useMatterRuns: () => ({ data: undefined, isLoading: false }),
  useMatterPendingUpdates: () => ({ data: undefined, isLoading: false }),
  useStartMatterRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMatterAgentProfiles: () => ({ data: [], isLoading: false }),
  // L4 批次3：行动项执行契约的取数口（详情页整块挂 matterAgentEnabled）。
  useMatterItemDispatches: () => ({ data: [], isLoading: false }),
  useMatterAttention: () => ({ data: undefined, isLoading: false }),
  useGlobalAttention: () => ({ data: undefined, isLoading: false }),
  useAttentionAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
}))
vi.mock('@shared/api/chat_api', () => ({
  createChatRuntime: vi.fn(),
  listSessionsForMatter: vi.fn(async () => [])
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: { listAllSessions: vi.fn(async () => []), listMessages: vi.fn(async () => []) }
  })
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')

await i18n.changeLanguage('zh-CN')

function matter(): Matter {
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
    updated_at: 1
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
  mattersApi.list.mockResolvedValue({ items: [matter()] })
  mattersApi.get.mockResolvedValue({ matter: matter(), items: [], timeline: [] })
  mattersApi.patch.mockResolvedValue({ matter: matter() })
})

afterEach(cleanup)

function renderDetail(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <MatterDetail matterId="MAT-0042" onBack={vi.fn()} onRemoved={vi.fn()} />
    </QueryClientProvider>
  )
}

async function openMoreMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: '更多' })
  fireEvent.click(trigger)
  await screen.findByRole('menu', { name: '更多' })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  return trigger
}

describe('MatterDetail —「更多」菜单的收起', () => {
  test('点菜单外部即收起（改动前只有再点一次触发器一条路）', async () => {
    renderDetail()
    const trigger = await openMoreMenu()

    // 判据必须是 mousedown：菜单项自己吃 click，靠 click 冒泡判外部会在「点了一项」和
    // 「点了外面」之间分不清。
    fireEvent.mouseDown(document.body)

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(screen.queryByRole('menu', { name: '更多' })).toBeNull())
  })

  test('点菜单内部不收起（否则菜单项一按下去就没了，压根点不中）', async () => {
    renderDetail()
    const trigger = await openMoreMenu()

    fireEvent.mouseDown(screen.getByRole('menuitem', { name: '归档' }))

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: '更多' })).toBeTruthy()
  })

  test('Esc 收起', async () => {
    renderDetail()
    const trigger = await openMoreMenu()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(screen.queryByRole('menu', { name: '更多' })).toBeNull())
  })

  test('选中一项后菜单收起（设计 detail.jsx:13 `onClose(); fn();`）', async () => {
    renderDetail()
    const trigger = await openMoreMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: '归档' }))

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(screen.queryByRole('menu', { name: '更多' })).toBeNull())
    expect(mattersApi.archive).toHaveBeenCalledWith('MAT-0042', { expectedVersion: 3 })
  })
})
