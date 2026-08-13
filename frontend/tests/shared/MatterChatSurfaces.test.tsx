// @vitest-environment happy-dom
//
// Matters MVP P6-A lane A5 — the two surface-level invariants:
//   · MatterDetail: 事项对话 targets the existing AI dock (0812: the context rail is gone,
//     so the same tests now pin its absence and the header pill's follow-up modal);
//   · MattersWorkspace with the flag off: nothing renders and nothing is requested.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterItem } from '@shared/api/types/matter'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'

const localStorageValues = new Map<string, string>()
const localStorageStub = {
  get length() {
    return localStorageValues.size
  },
  clear: () => localStorageValues.clear(),
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  key: (index: number) => [...localStorageValues.keys()][index] ?? null,
  removeItem: (key: string) => localStorageValues.delete(key),
  setItem: (key: string, value: string) => localStorageValues.set(key, value)
} satisfies Storage

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageStub })
Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageStub })

const { mattersApi, chatApi, mailApi, mattersEnabled, matterAgentEnabled } = vi.hoisted(() => ({
  mattersApi: {
    get: vi.fn(),
    list: vi.fn(),
    patch: vi.fn(),
    listUpdates: vi.fn(async () => ({ items: [] })),
    getUpdate: vi.fn(),
    listResources: vi.fn(async () => []),
    listStakeholders: vi.fn(async () => [])
  },
  chatApi: {
    contextSnapshot: vi.fn(async () => {
      throw new Error('not needed')
    }),
    applyUndo: vi.fn()
  },
  mailApi: {
    chat: {
      listAllSessions: vi.fn(async () => []),
      listMessages: vi.fn(async () => []),
      newSession: vi.fn()
    }
  },
  mattersEnabled: { value: true },
  matterAgentEnabled: { value: false }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => chatApi,
  useMattersEnabled: () => mattersEnabled.value,
  // P4 lane ③ 起 MatterDetail 还消费这五个 hook；默认给「flag 关」的惰性桩，
  // 详情 dogfood 回归可单独打开 runs 标签。
  useMatterFlags: () => ({
    mattersEnabled: mattersEnabled.value,
    matterAgentEnabled: matterAgentEnabled.value
  }),
  useMatterRuns: () => ({ data: undefined, isLoading: false }),
  useMatterUpdates: () => ({ data: undefined, isLoading: false }),
  useStartMatterRun: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMatterAgentProfiles: () => ({ data: [], isLoading: false }),
  // P5 lane ②：MattersWorkspace/MatterDetail 又多消费三个 attention hook。本测试只看
  // 面板/rail 槽位，一律给「无信号」惰性桩（Focus 与 AttnBand 不渲染，P3 断言面不变）。
  useGlobalAttention: () => ({ data: undefined, isLoading: false }),
  useMatterAttention: () => ({ data: undefined, isLoading: false }),
  useAttentionAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
}))
// P4 lane ③：useMatterChatSession 直调 serve-api 的 list-for-matter——mock 掉防真网络。
vi.mock('@shared/api/chat_api', () => ({
  createChatRuntime: vi.fn(),
  listSessionsForMatter: vi.fn(async () => [])
}))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterDetail } = await import('@shared/components/matters/MatterDetail')
const { MattersWorkspace } = await import('@shared/components/matters/MattersWorkspace')

await i18n.changeLanguage('zh-CN')

function matter(): Matter {
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
    updated_at: 1
  }
}

/** The rail's breakpoint (`min-width: 1400px`) must match so the rail is even a candidate. */
function stubWideViewport(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1400'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

/** 窄窗口：所有媒体查询都不命中（老右栏的 `min-width: 1400px` 首当其冲）。 */
function stubNarrowViewport(): void {
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
}

function renderDetail(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterDetail matterId="MAT-0042" onBack={vi.fn()} onRemoved={vi.fn()} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mattersEnabled.value = true
  matterAgentEnabled.value = false
  useAIChatPanel.setState({ visible: false, matterTarget: null, matterConversationEpoch: 0 })
  mattersApi.list.mockResolvedValue({ items: [matter()] })
  mattersApi.get.mockResolvedValue({ matter: matter(), items: [], timeline: [] })
  mattersApi.patch.mockResolvedValue({ matter: matter() })
  mattersApi.listResources.mockResolvedValue([])
  mattersApi.listStakeholders.mockResolvedValue([])
  stubWideViewport()
})

afterEach(cleanup)

describe('MatterDetail — chat entry, no context rail', () => {
  // 0812 D-D：右侧上下文栏已移除（与「上下文」tab 重复，且 ≥1400px 才渲染 ⇒ 把跟进配置
  // 藏在窗口宽度后面）。这里的断言从「rail 保住槽位」翻成「宽视口下 rail 也不该再出现」。
  test('no context rail and no standalone chat panel occupy the detail layout', async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText('Vendor launch')).toBeTruthy())
    expect(screen.queryByText('还没有关联资料。解除关联不会删除原始邮件或文档。')).toBeNull()
    expect(screen.queryByTestId('matter-chat-panel')).toBeNull()
    expect(screen.getByRole('button', { name: '事项对话' })).toBeTruthy()
  })

  test('clicking 事项对话 targets the AI dock and starts a new round each time', async () => {
    renderDetail()
    const openButton = await screen.findByRole('button', { name: '事项对话' })

    fireEvent.click(openButton)
    expect(useAIChatPanel.getState().visible).toBe(true)
    expect(useAIChatPanel.getState().matterTarget).toEqual({
      id: 42,
      publicId: 'MAT-0042',
      title: 'Vendor launch'
    })
    expect(useAIChatPanel.getState().matterConversationEpoch).toBe(1)
    expect(screen.queryByTestId('matter-chat-panel')).toBeNull()

    fireEvent.click(openButton)
    expect(useAIChatPanel.getState().matterConversationEpoch).toBe(2)
  })

  // 0812 D-B 的核心 bug：跟进配置入口此前只在右栏里，窄窗口下不可达。现在挂在详情头的
  // Agent pill 上 —— 这个测试跑在**没有**任何宽度前提的 happy-dom 里，能开就是能开。
  test('the follow-up rules modal opens from the header pill at any width', async () => {
    matterAgentEnabled.value = true
    stubNarrowViewport() // 窄窗口 —— 老入口（右栏）在这个宽度下根本不渲染
    renderDetail()
    fireEvent.click(await screen.findByRole('button', { name: /未绑定跟进 Agent/ }))
    expect(
      await screen.findByText('能力来自全局 Matter Agent，这里只定这件事什么时候触发、跑完做什么。')
    ).toBeTruthy()
    expect(screen.getByText('触发方式')).toBeTruthy()
    expect(screen.getByText('跟进时执行')).toBeTruthy()
  })
})

describe('MatterDetail — detail editing and rendering', () => {
  test('uses segmented detail tabs and renders markdown descriptions', async () => {
    const note: MatterItem = {
      id: 8,
      matter_id: 42,
      kind: 'note',
      title: 'Release note',
      description: '**条目重点**',
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
      deleted_at: null
    }
    matterAgentEnabled.value = true
    mattersApi.get.mockResolvedValue({
      matter: { ...matter(), description: '**背景重点**' },
      items: [note],
      timeline: []
    })

    renderDetail()

    expect(await screen.findByRole('tablist', { name: '事项详情' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /运行/ })).toBeTruthy()
    expect(await screen.findByText('背景重点')).toBeTruthy()
    expect(screen.getByText('条目重点')).toBeTruthy()
    expect(screen.queryByText('**背景重点**')).toBeNull()
    expect(screen.queryByText('**条目重点**')).toBeNull()
  })

  test('patches title, priority, type, and purpose inline', async () => {
    renderDetail()
    await screen.findByText('Vendor launch')

    fireEvent.click(screen.getByRole('button', { name: '编辑事项标题' }))
    fireEvent.change(screen.getByRole('textbox', { name: '事项标题' }), {
      target: { value: 'Vendor launch revised' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { title: 'Vendor launch revised' },
        { expectedVersion: 3 }
      )
    )

    // 0812 D-A：优先级从四档平铺的 SegmentedControl 收成一个彩色标签 + 下拉菜单。
    fireEvent.click(screen.getByRole('combobox', { name: '事项优先级' }))
    fireEvent.click(await screen.findByRole('option', { name: 'P2' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { priority: 'p2' },
        { expectedVersion: 3 }
      )
    )

    // 0813 D4：类型从 shadcn Select 换成设计的「搜索即筛选、没命中就现场新建」菜单
    // （Radix 的 listbox 里塞不下搜索框）→ 触发器是 button 不再是 combobox。
    fireEvent.click(screen.getByRole('button', { name: '事项类型' }))
    fireEvent.click(await screen.findByRole('option', { name: '产品' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { matter_type: '产品' },
        { expectedVersion: 3 }
      )
    )

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByRole('textbox', { name: /核心目标/ }), {
      target: { value: '## 新背景' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { description: '## 新背景' },
        { expectedVersion: 3 }
      )
    )
  })
})

describe('MattersWorkspace — flag off', () => {
  test('renders nothing and issues no matters request', () => {
    mattersEnabled.value = false
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const { container } = render(
      <QueryClientProvider client={client}>
        <MattersWorkspace />
      </QueryClientProvider>
    )
    expect(container.firstChild).toBeNull()
    expect(mattersApi.list).not.toHaveBeenCalled()
    expect(chatApi.contextSnapshot).not.toHaveBeenCalled()
  })
})

describe('MattersWorkspace — resizable matter list', () => {
  test('restores, drags, clamps, and persists the list width', async () => {
    window.localStorage.setItem('mailagent.matters.listWidth', '400')
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <MattersWorkspace />
      </QueryClientProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: '全部' }))
    const separator = screen.getByRole('separator', { name: '调整事项清单宽度' })
    const grid = separator.parentElement as HTMLDivElement
    expect(grid.style.getPropertyValue('--matter-list-width')).toBe('400px')

    let capturedPointer: number | null = null
    separator.setPointerCapture = vi.fn((pointerId: number) => {
      capturedPointer = pointerId
    })
    separator.hasPointerCapture = vi.fn((pointerId: number) => capturedPointer === pointerId)
    separator.releasePointerCapture = vi.fn(() => {
      capturedPointer = null
    })

    fireEvent.pointerDown(separator, { button: 0, clientX: 400, pointerId: 7 })
    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 7 })
    expect(grid.style.getPropertyValue('--matter-list-width')).toBe('480px')
    expect(window.localStorage.getItem('mailagent.matters.listWidth')).toBe('400')
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.pointerUp(separator, { pointerId: 7 })
    await waitFor(() => expect(separator.getAttribute('aria-valuenow')).toBe('480'))
    expect(window.localStorage.getItem('mailagent.matters.listWidth')).toBe('480')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  test('supports keyboard resizing', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <MattersWorkspace />
      </QueryClientProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: '全部' }))
    const separator = screen.getByRole('separator', { name: '调整事项清单宽度' })
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })

    expect(separator.getAttribute('aria-valuenow')).toBe('304')
    expect(window.localStorage.getItem('mailagent.matters.listWidth')).toBe('304')
  })
})
