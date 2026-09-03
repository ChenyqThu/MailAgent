// @vitest-environment happy-dom
//
// P2-L7 —— `/search` 页的资料库组：
//   · 与 ⌘K 共用同一个 query key + limit（GET /library/search，limit=8）；
//   · 🔴 组序 = flat 键盘序：Library 组渲染在 Email 之前，且 ⏎（highlight 0）打开的是
//     第一条库文件而不是第一封邮件 —— 这条同时钉住 SearchResultGroups 的渲染顺序与
//     SearchTabPage 的 flat 构造顺序（两处靠注释互指，漂了这里就红）；
//   · 中文 1 个字：出 warning 不出结果（组仍要渲染，否则提示无处可去）；
//   · 点击 = 深链 `/library?file={id}`。
// mock 形状照 tests/components/SearchTabPage.test.tsx。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { LibrarySearchHit } from '@shared/api/types/library'

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

const { mockSearch, mockLibrarySearch, mockNavigate, mockPush } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockLibrarySearch: vi.fn(),
  mockNavigate: vi.fn(),
  mockPush: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { search: mockSearch },
    settings: { get: vi.fn() },
    report: { getConfig: vi.fn() }
  })
}))

vi.mock('@shared/components/library/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLibraryApi: () => ({ search: mockLibrarySearch })
}))

// 深链走 router.history.push（`/library` 还不是已注册路由，见 library/deeplink.ts）。
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({ history: { push: mockPush } })
}))

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
import { MAIN_SLOT, useTabWorkspace } from '@shared/state/tab-workspace'

await i18n.changeLanguage('zh-CN')

const PLACEHOLDER = '输入关键词，或用 from: has: mailbox: 精确检索'

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

function libraryHit(overrides: Partial<LibrarySearchHit> = {}): LibrarySearchHit {
  return {
    id: 31,
    mount_id: 0,
    // 🔴 文件名故意不含 query：`<mark>` 只能来自 snippet 的 [ ] 标记，否则那条断言
    //     会被文件名高亮喂绿（变异验证实测踩到过）。
    rel_path: 'notes/runbook.md',
    path: 'my-docs/notes/runbook.md',
    parent_path: 'my-docs/notes',
    filename: 'runbook.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 900,
    mtime: 1_756_000_000,
    content_hash: 'abc',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_756_000_000,
    updated_at: 1_756_000_000,
    snippet: '连接池里的 [redis] 超时阈值',
    rank: -1.2,
    match: 'text',
    lane: 'fts',
    ...overrides
  }
}

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <SearchTabPage />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  mockSearch.mockReset().mockResolvedValue(SAMPLE_RESULT)
  mockLibrarySearch.mockReset().mockResolvedValue({
    query: 'redis',
    mode: 'porter',
    hits: [libraryHit()],
    warnings: []
  })
  mockNavigate.mockReset()
  mockPush.mockReset()
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

describe('SearchTabPage — 资料库组', () => {
  test('输入 query → library.search(q, 8)，命中行与 [ ] 高亮就位', async () => {
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: 'redis' } })
    await waitFor(() => expect(mockLibrarySearch).toHaveBeenCalledWith('redis', 8), {
      timeout: 2000
    })
    const row = (await screen.findByText('my-docs/notes/runbook.md')).closest('li') as HTMLElement
    expect(Array.from(row.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['redis'])
  })

  test('🔴 组序：Library 组渲染在 Email 之前，且 ⏎ 打开的是第一条库文件', async () => {
    renderPage()
    const input = screen.getByPlaceholderText(PLACEHOLDER)
    fireEvent.change(input, { target: { value: 'redis' } })
    await screen.findByText('my-docs/notes/runbook.md')
    await screen.findByText('timeout debug session', { exact: false })

    // ① 渲染顺序（SearchResultGroups）。组头由「标题 / · / 计数」三个 span 拼成，
    // textContent 里没有空格，所以按前缀找。
    const heads = Array.from(document.body.querySelectorAll('h2')).map((h) => h.textContent ?? '')
    const libraryAt = heads.findIndex((text) => text.startsWith('Library'))
    const emailAt = heads.findIndex((text) => text.startsWith('Email'))
    expect(libraryAt).toBeGreaterThanOrEqual(0)
    expect(emailAt).toBeGreaterThanOrEqual(0)
    expect(libraryAt).toBeLessThan(emailAt)

    // ② flat 键盘序（SearchTabPage）：highlight 从 0 起，⏎ 必须落在资料库第一行。
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockPush).toHaveBeenCalledWith('/library?file=31')
    expect(mockNavigate).not.toHaveBeenCalledWith({ to: '/', search: { view: 'inbox' } })
  })

  test('点击命中行 = 深链 /library?file={id}', async () => {
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: 'redis' } })
    const path = await screen.findByText('my-docs/notes/runbook.md')
    fireEvent.click(path.closest('li') as HTMLElement)
    expect(mockPush).toHaveBeenCalledWith('/library?file=31')
  })

  test('中文 1 个字：资料库组仍渲染，只出 warning 不出命中行', async () => {
    mockLibrarySearch.mockResolvedValue({
      query: '合',
      mode: 'too_short',
      hits: [],
      warnings: ['cjk_too_short:合']
    })
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: '合' } })
    await screen.findByText('至少输入 2 个字')
    expect(screen.queryByText('my-docs/notes/runbook.md')).toBeNull()
  })
})
