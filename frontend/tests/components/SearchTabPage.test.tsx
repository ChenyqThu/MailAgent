// @vitest-environment happy-dom
//
// 「新标签页」搜索页（08-27 P2 补批 Lane S）的烟囱面：
//   1. 空态形态 —— slogan / 大搜索框 / hint chips / 「最近打开」（数据 = 标签工作区
//      自己的 tabs + closedStack，搜索标签自身不出现在里面）；
//   2. 输入 → 复用 palette 的搜索内核（同一个 mailApi.email.search 契约）→ EmailHitRow；
//   3. 点结果 = 开对象标签（真 bridge 路径），搜索标签保留不变身。
// mock 形状对照 tests/components/CommandPalette.test.tsx（同一批内核的另一张脸）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const memoryStore: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in memoryStore ? memoryStore[k] : null),
  setItem: (k: string, v: string) => {
    memoryStore[k] = v
  },
  removeItem: (k: string) => {
    delete memoryStore[k]
  },
  clear: () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  }
})

const { mockSearch, mockNavigate } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockNavigate: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { search: mockSearch },
    settings: { get: vi.fn() },
    report: { getConfig: vi.fn() }
  })
}))

vi.mock('@shared/hooks/useLibraryApi', () => ({
  // 资料库第五 lane（P2-L7）跟着任何一次渲染发查询；本文件不测它，给个空结果，
  // 免得真去 fetch loopback serve-api。
  useLibraryApi: () => ({
    search: async () => ({ query: '', mode: 'empty', hits: [], warnings: [] })
  })
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

// 事项 / 通讯录两路关掉（本测只钉邮件内核那条腿；两组的查询在 enabled=false 下不发）。
vi.mock('@shared/components/matters/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMattersEnabled: () => false
}))
vi.mock('@shared/components/contacts/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useContactsEnabled: () => ({ enabled: false })
}))

import i18n from '@shared/i18n'
import { SearchTabPage } from '@shared/components/search/SearchTabPage'
import { _resetSearchTabForTest } from '@shared/state/search-tab'
import { useSearchHistory } from '@shared/state/search-history'
import {
  MAIN_SLOT,
  SEARCH_TAB_ID,
  SEARCH_TARGET_ID,
  useTabWorkspace
} from '@shared/state/tab-workspace'

await i18n.changeLanguage('zh-CN')

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <SearchTabPage />
    </QueryClientProvider>
  )
}

const SAMPLE_RESULT = {
  items: [
    {
      internal_id: 101,
      subject: 'redis timeout debug session',
      sender: 'Alice <alice@example.com>',
      date_received: '2026-05-15T09:00:00+08:00',
      mailbox: '收件箱',
      rank: -1.8,
      snippet: 'the <mark>redis</mark> client keeps timing out',
      notion_page_id: null,
      notion_url: null,
      ai_priority: null,
      lang: 'en' as const
    }
  ],
  total_indexed: 1000,
  parse_warnings: []
}

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  mockSearch.mockReset().mockResolvedValue(SAMPLE_RESULT)
  mockNavigate.mockReset()
  _resetSearchTabForTest()
  useSearchHistory.setState({ history: [], saved: [] })
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 8,
    closedStack: []
  })
})

afterEach(cleanup)

describe('SearchTabPage — 空态', () => {
  test('slogan / 输入框 / hint chips 就位；「最近打开」来自标签工作区且不含搜索标签自身', () => {
    useTabWorkspace.getState().openTab('email', 7, '周报确认')
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    renderPage()
    expect(screen.getByText('搜索邮件、事项、联系人与日程')).toBeTruthy()
    expect(
      screen.getByPlaceholderText('输入关键词，或用 from: has: mailbox: 精确检索')
    ).toBeTruthy()
    expect(screen.getByText('from:david')).toBeTruthy()
    expect(screen.getByText('has:attachment')).toBeTruthy()
    expect(screen.getByText('✦ AI 深度搜索')).toBeTruthy()
    // 最近打开：email:7 在，搜索标签自身不在
    expect(screen.getByText('最近打开')).toBeTruthy()
    expect(screen.getByText('周报确认')).toBeTruthy()
    expect(screen.queryAllByText('新标签页')).toHaveLength(0)
  })

  test('点「最近打开」= 激活那个对象标签（搜索标签保留）', () => {
    useTabWorkspace.getState().openTab('email', 7, '周报确认')
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    renderPage()
    fireEvent.click(screen.getByText('周报确认'))
    const state = useTabWorkspace.getState()
    expect(state.active).toBe('email:7')
    expect(state.tabs.some((t) => t.id === SEARCH_TAB_ID)).toBe(true)
  })
})

describe('SearchTabPage — 搜索与结果', () => {
  test('输入走 palette 同款内核（同 limit 契约），命中行可点开成对象标签', async () => {
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    renderPage()
    const input = screen.getByPlaceholderText('输入关键词，或用 from: has: mailbox: 精确检索')
    fireEvent.change(input, { target: { value: 'redis' } })
    // debounce 250ms → useQuery 发一次
    await waitFor(() => expect(mockSearch).toHaveBeenCalled(), { timeout: 2000 })
    expect(mockSearch).toHaveBeenCalledWith({ query: 'redis', limit: 50 })
    // 主题经 highlightTerms 拆成 <mark>redis</mark> + 余下文本节点 —— 按余段匹配。
    const row = await screen.findByText('timeout debug session', { exact: false })
    fireEvent.click(row)
    // 结果打开成对象标签（真 bridge 路径），搜索标签不变身；路由去邮件域
    const state = useTabWorkspace.getState()
    expect(state.tabs.some((t) => t.id === 'email:101')).toBe(true)
    expect(state.tabs.some((t) => t.id === SEARCH_TAB_ID)).toBe(true)
    expect(state.active).toBe('email:101')
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/', search: { view: 'inbox' } })
  })

  test('settled 成功搜索推进「最近搜索」历史（palette 同判据，页内搜索不再是旁观者）', async () => {
    renderPage()
    const input = screen.getByPlaceholderText('输入关键词，或用 from: has: mailbox: 精确检索')
    fireEvent.change(input, { target: { value: 'redis' } })
    await waitFor(() => expect(useSearchHistory.getState().history).toContain('redis'), {
      timeout: 2000
    })
  })

  test('续改1：query 与结果视图会话内保持 —— 卸载重挂（切走再 ⌘T 切回的等价物）不丢', async () => {
    const first = renderPage()
    const input = screen.getByPlaceholderText('输入关键词，或用 from: has: mailbox: 精确检索')
    fireEvent.change(input, { target: { value: 'redis' } })
    await screen.findByText('timeout debug session', { exact: false })
    first.unmount()

    renderPage()
    const restored = screen.getByPlaceholderText(
      '输入关键词，或用 from: has: mailbox: 精确检索'
    ) as HTMLInputElement
    // 输入框回读 store —— 不是空态
    expect(restored.value).toBe('redis')
    // 结果视图由 query 重新导出（新 QueryClient ⇒ 重拉一次也算「回放」，装机上共享缓存直接命中）
    await screen.findByText('timeout debug session', { exact: false })
  })
})
