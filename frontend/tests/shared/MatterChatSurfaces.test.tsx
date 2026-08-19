// @vitest-environment happy-dom
//
// Matters MVP P6-A lane A5 — the two surface-level invariants:
//   · MatterDetail: 事项对话 targets the existing AI dock (0812: the context rail is gone,
//     so the same tests now pin its absence and the header pill's follow-up modal);
//   · MattersWorkspace with the flag off: nothing renders and nothing is requested.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
    listStakeholders: vi.fn(async () => []),
    // R3-#2（dogfood 轮 3）—— 左轨「使用中标签」整段筛选行删除后，工作台不该再发这个请求；
    // 保留 mock 是为了让下面那条回归测试能证明「就算标签数据存在也不再渲染/不再请求」，
    // 而不是巧合地因为 mock 缺失才通过。
    listTags: vi.fn(async () => ({ items: [] }))
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
  mattersApi.listTags.mockResolvedValue({ items: [] })
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
      matter: { ...matter(), background: '**背景重点**' },
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

    // 0812 D-A：优先级从四档平铺的 SegmentedControl 收成一个彩色标签 + 下拉菜单；
    // 轮 3 #2：面板从 shadcn Select 换成设计 PickMenu（Popmenu 逃生舱）→ 触发器是
    // button 不再是 combobox（同类型控件的处理）。
    fireEvent.click(screen.getByRole('button', { name: '事项优先级' }))
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

    // v61：背景与目标是两个独立字段，两个 textarea 各自存进自己那一列 —— 🔴 patch 体里
    // **没有任何拼接**，看见 `## 背景` 之类的分隔符就是分段方案又爬回来了。
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByRole('textbox', { name: '背景' }), {
      target: { value: '三方排期互相不认' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: '目标' }), {
      target: { value: '拿到一份都认的排期' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { background: '三方排期互相不认', goal: '拿到一份都认的排期' },
        { expectedVersion: 3 }
      )
    )
  })

  test('only the half that changed is sent, and the other column is untouched', async () => {
    // 🔴 拆两列的全部意义：改目标不该把背景一起重写。老方案做不到这件事（整串是一个
    // 字段，任何一次保存都是全量覆盖）。
    mattersApi.get.mockResolvedValue({
      matter: { ...matter(), background: '原来的背景', goal: '原来的目标' },
      items: [],
      timeline: []
    })

    renderDetail()
    await screen.findByText('原来的背景')

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByRole('textbox', { name: '目标' }), {
      target: { value: '改过的目标' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mattersApi.patch).toHaveBeenCalledWith(
        'MAT-0042',
        { background: '原来的背景', goal: '改过的目标' },
        { expectedVersion: 3 }
      )
    )
  })

  test('renders 背景 / 目标 as two labelled blocks', async () => {
    mattersApi.get.mockResolvedValue({
      matter: { ...matter(), background: '三方排期互相不认', goal: '拿到都认的排期' },
      items: [],
      timeline: []
    })

    renderDetail()

    expect(await screen.findByText('三方排期互相不认')).toBeTruthy()
    expect(screen.getByText('拿到都认的排期')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '背景' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '目标' })).toBeTruthy()
  })

  test('a matter with only 背景 renders one block, not an empty 目标 heading', async () => {
    // v61 后半段留空是常态（创建调研只填得起背景），空段不许渲染出一个光秃秃的标题。
    mattersApi.get.mockResolvedValue({
      matter: { ...matter(), background: '只有背景', goal: '' },
      items: [],
      timeline: []
    })

    renderDetail()

    expect(await screen.findByText('只有背景')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '背景' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '目标' })).toBeNull()
  })

  test('migrated legacy prose lands in 背景 verbatim — headings are never parsed', async () => {
    // 🔴 v61 的数据规则：老 `description` 整串原样搬进 background（迁移单源
    // `sync_store.split_legacy_matter_description`），前端**不再解析任何小标题**。
    // 万一某行真的带着 `## 背景` 字面量（迁移拆过的行不会，但 owner 自己敲得出来），
    // 它就只是 Markdown 正文里的一个标题，不是分段指令。
    mattersApi.get.mockResolvedValue({
      matter: { ...matter(), background: '## 背景\n老的一句话', goal: '' },
      items: [],
      timeline: []
    })

    renderDetail()

    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    expect((screen.getByRole('textbox', { name: '背景' }) as HTMLTextAreaElement).value).toBe(
      '## 背景\n老的一句话'
    )
    expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('')
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

    // M1（v3 信息架构）：左轨视图列已退役，进列表 = 点「事项」tab（默认落看板）。
    fireEvent.click(await screen.findByRole('tab', { name: '事项' }))
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

    // E10①（dogfood 轮 2）—— 拖拽上限从 480 提到 560（见 MattersWorkspace.MAX_MATTER_LIST_WIDTH）。
    fireEvent.pointerDown(separator, { button: 0, clientX: 400, pointerId: 7 })
    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 7 })
    expect(grid.style.getPropertyValue('--matter-list-width')).toBe('560px')
    expect(window.localStorage.getItem('mailagent.matters.listWidth')).toBe('400')
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.pointerUp(separator, { pointerId: 7 })
    await waitFor(() => expect(separator.getAttribute('aria-valuenow')).toBe('560'))
    expect(window.localStorage.getItem('mailagent.matters.listWidth')).toBe('560')
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

    // M1（v3 信息架构）：左轨视图列已退役，进列表 = 点「事项」tab（默认落看板）。
    fireEvent.click(await screen.findByRole('tab', { name: '事项' }))
    const separator = screen.getByRole('separator', { name: '调整事项清单宽度' })
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })

    // E10①—— 无持久化宽度时的起点镜像 design `listWidthFor`：happy-dom 默认视口 1024px
    // < 1440 → 336（窄档），ArrowLeft 一步 -16 → 320。
    expect(separator.getAttribute('aria-valuenow')).toBe('320')
    expect(window.localStorage.getItem('mailagent.matters.listWidth')).toBe('320')
  })

  test('E10①：窗口 ≥1440px 时首次进入的默认宽度是 380（design listWidthFor 宽档）', async () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
      })
      render(
        <QueryClientProvider client={client}>
          <MattersWorkspace />
        </QueryClientProvider>
      )
      // M1（v3 信息架构）：左轨视图列已退役，进列表 = 点「事项」tab（默认落看板）。
      fireEvent.click(await screen.findByRole('tab', { name: '事项' }))
      const separator = screen.getByRole('separator', { name: '调整事项清单宽度' })
      expect(separator.getAttribute('aria-valuenow')).toBe('380')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    }
  })
})

// V3-04（v3 信息架构，改判 R3-#2）—— 轮 3 删的是「标签作为**导航入口**」（左轨「使用中标签」
// 整段），owner 拍板本轮把标签作为**临时筛选条件**放回筛选菜单：这是有意反转，不是回滚。
// 原来那条「listTags 永不被调用」的反向闸随之重写成正向语义：标签数据只喂筛选菜单的二级
// 面板（打开列表面才请求），列表旁**不再有**任何标签导航轨；在面板里勾选一个标签会生成
// 可删的条件 chip。改回「标签轨」渲染路径、或把面板拆掉，这条都会红。
describe('MattersWorkspace — tags are a filter facet, not a nav rail (V3-04)', () => {
  test('tag definitions feed the filter menu; no tag rail exists outside it', async () => {
    mattersApi.list.mockResolvedValue({ items: [{ ...matter(), tags: ['合规'] }] })
    mattersApi.listTags.mockResolvedValue({
      items: [
        { name: '合规', color: '--c-accent', shape: 'circle', created_at: null, usage_count: 1 }
      ]
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <MattersWorkspace />
      </QueryClientProvider>
    )

    // 看板 tab（默认落点）不请求标签 —— 标签数据是列表筛选面的私有依赖。
    expect(mattersApi.listTags).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('tab', { name: '事项' }))
    expect(await screen.findByText('Vendor launch')).toBeTruthy()
    await waitFor(() => expect(mattersApi.listTags).toHaveBeenCalled())
    // 菜单未打开时**列表面**里没有任何标签控件（没有导航轨）。
    //
    // 🔴 取景范围收窄到列表面本身（分隔条 `role="separator"` 的前一个兄弟节点，即
    // `<MatterList>` 的挂载点），不是整个 render：V3-11 起冷启动「无记录 → 选第一条」会
    // 自动选中这里唯一的事项，详情栏随之渲染真实的 `MatterDetail` —— 它在标签区（轮 3
    // 保留下来的「标签只在详情页与设置里」结论）合法地渲染标签 chip + 添加标签按钮，
    // 若断言查询整个页面会被这段合法 UI 误伤。这条闸本身要测的是「标签不许以导航面/
    // 常驻轨的形态回到**列表**」，`MatterDetail` 里的标签编辑从来不在它的管辖范围。
    const separator = screen.getByRole('separator', { name: '调整事项清单宽度' })
    const listPane = separator.previousElementSibling as HTMLElement
    // 🔴 锚点自证：`previousElementSibling` 是基于 DOM 相邻位置的定位——如果将来有人在
    // 列表与分隔条之间插进任何一个元素（wrapper / 提示条 / portal 容器），它会静默指向
    // 别的节点，下面两条 `queryByText`/`queryByRole` 断言会在**错误的空节点**里查不到东西、
    // 照样通过，闸从「守卫」退化成「恒绿」且没人发现。用 `MatterList` 自己独有、必然已挂载
    // 的搜索框（`matters.list.searchInView` 占位符，含固定的「搜索」二字，不随 scope 名变）
    // 做前置断言：指错了就在这里先红，不会带着错误锚点往下跑出一个假绿。
    expect(within(listPane).getByPlaceholderText(/搜索/)).toBeTruthy()
    expect(within(listPane).queryByRole('button', { name: '合规' })).toBeNull()
    expect(within(listPane).queryByText('标签')).toBeNull()

    // 打开筛选菜单 → 下钻「标签」二级面板 → 勾选 → 生成可删条件 chip。
    fireEvent.click(screen.getByRole('button', { name: /筛选/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '标签' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /合规/ }))
    expect(await screen.findByRole('button', { name: /#合规/ })).toBeTruthy()
  })
})
