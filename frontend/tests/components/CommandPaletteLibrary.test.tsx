// @vitest-environment happy-dom
//
// P2-L7 —— ⌘K 第五 lane「资料库」：
//   · 数据路径：GET /library/search（q + limit=8），空 query 零请求；
//   · 三档检索纪律的用户可见形态 —— 中文 1 字出提示不出结果 / 2 字 LIKE 无 rank 照常出行 /
//     ≥3 字整串 MATCH 且 snippet 的 [ ] 标记渲染成高亮；
//   · warnings 是复数数组，多条全渲染；
//   · 激活：点击行 = 关面板 + 深链 `/library?file={id}`（design §9.5）；
//   · scope 'library' 只看资料库组；远程 web build 整域隐藏、零请求。
// mock 形状照 tests/components/CommandPaletteContacts.test.tsx。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { LibrarySearchHit } from '@shared/api/types/library'
import { useCommandPalette } from '@shared/state/command-palette'

const { mockSearch, mockListMailboxes, mockLibrarySearch, mockNavigate } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockListMailboxes: vi.fn(),
  mockLibrarySearch: vi.fn(),
  mockNavigate: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      search: mockSearch,
      listMailboxes: mockListMailboxes,
      flag: vi.fn(),
      nlToDsl: vi.fn(),
      list: vi.fn(),
      listEnriched: vi.fn(),
      listByThread: vi.fn(),
      get: vi.fn(),
      body: vi.fn(),
      aiFields: vi.fn(),
      resync: vi.fn(),
      createDraft: vi.fn(),
      pin: vi.fn(),
      listPinnedIds: vi.fn()
    },
    llm: { run: vi.fn(), stats: vi.fn(), selftest: vi.fn() },
    attachment: { list: vi.fn(), localPath: vi.fn(), readDataUrl: vi.fn() },
    ai: { translate: vi.fn(), abortTranslate: vi.fn() },
    chat: {}
  })
}))

vi.mock('@shared/hooks/useLibraryApi', () => ({
  useLibraryApi: () => ({ search: mockLibrarySearch })
}))

vi.mock('@shared/assistant/searchAgentClient', () => ({
  runGatewaySearchAgent: vi.fn(async () => ({ ok: true, hits: [], summary: null }))
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({
    list: vi.fn(async () => ({ items: [] })),
    lookupResourceLinks: vi.fn(async () => ({ results: {} }))
  }),
  useMattersEnabled: () => false
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: false, loading: false }),
  useContactsApi: () => ({ list: vi.fn(async () => ({ items: [], total: 0 })) })
}))

import i18n from '@shared/i18n'
import { CommandPalette } from '@shared/components/command/CommandPalette'

await i18n.changeLanguage('zh-CN')

function libraryHit(overrides: Partial<LibrarySearchHit> = {}): LibrarySearchHit {
  return {
    id: 31,
    mount_id: 0,
    rel_path: 'notes/合同评审.md',
    path: 'my-docs/notes/合同评审.md',
    parent_path: 'my-docs/notes',
    filename: '合同评审.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 2048,
    mtime: 1_756_000_000,
    content_hash: 'abc',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_756_000_000,
    updated_at: 1_756_000_000,
    snippet: null,
    rank: null,
    match: 'text',
    ...overrides
  }
}

function renderPalette(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <CommandPalette />
    </QueryClientProvider>
  )
}

// 资料库 scope chip 的可及名。label 键 `palette.matters.scope.library` 待 i18n lane
// 补上，补之前 t() 回落成键本身 —— 两种形态都认，免得这条闸在补 key 那天变红。
const LIBRARY_SCOPE_CHIP = /资料库|palette\.matters\.scope\.library/

async function typeQuery(value: string): Promise<void> {
  const input = await screen.findByRole('combobox')
  fireEvent.change(input, { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useCommandPalette.getState().setOpen(false)
  mockListMailboxes.mockResolvedValue([
    { mailbox: '收件箱', total: 100, unread: 5, flagged: 2, failed: 0 }
  ])
  mockSearch.mockResolvedValue({ items: [], total_indexed: 1247 })
  mockLibrarySearch.mockResolvedValue({
    query: '合同评审',
    mode: 'trigram',
    hits: [libraryHit()],
    warnings: []
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useCommandPalette.getState().setOpen(false)
})

describe('CommandPalette — 资料库第五 lane', () => {
  test('输入 query → library.search(q, 8)，命中行渲染文件名 + 虚拟路径', async () => {
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合同评审')
    await waitFor(() => expect(mockLibrarySearch).toHaveBeenCalledWith('合同评审', 8))
    // 文件名会被命中高亮拆开，行定位用**不参与高亮**的虚拟路径。
    await screen.findByText('my-docs/notes/合同评审.md')
  })

  test('空 query 不发 /library/search（hasQuery gate）', async () => {
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await screen.findByRole('combobox')
    await waitFor(() => expect(mockListMailboxes).toHaveBeenCalled())
    expect(mockLibrarySearch).not.toHaveBeenCalled()
  })

  test('中文 1 个字：出 warning 提示，不出结果，也不出「没有匹配的文件」空态', async () => {
    mockLibrarySearch.mockResolvedValue({
      query: '合',
      mode: 'too_short',
      hits: [],
      warnings: ['cjk_too_short:合']
    })
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合')
    await screen.findByText('至少输入 2 个字')
    expect(screen.queryByText('没有匹配的文件')).toBeNull()
    expect(screen.queryByText('my-docs/notes/合同评审.md')).toBeNull()
  })

  test('warnings 是复数数组 —— 多条全部渲染，不 join 也不只取第一条', async () => {
    mockLibrarySearch.mockResolvedValue({
      query: '合',
      mode: 'too_short',
      hits: [],
      warnings: ['cjk_too_short:合', 'something_new:42']
    })
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合')
    const first = await screen.findByText('至少输入 2 个字')
    // 两条 warning = 两个兄弟行。第二条的文案键 `library.search.warnGeneric` 待 i18n
    // lane 补，所以这里数行数而不是断言文案。
    const rows = first.closest('div')?.parentElement
    expect(rows?.children).toHaveLength(2)
  })

  test('2 个字走 LIKE：rank 为 null、snippet 无标记，行照常渲染', async () => {
    mockLibrarySearch.mockResolvedValue({
      query: '合同',
      mode: 'like',
      hits: [libraryHit({ rank: null, snippet: '本次合同评审的结论如下', match: 'text' })],
      warnings: []
    })
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合同')
    await screen.findByText('my-docs/notes/合同评审.md')
    expect(screen.getByText('本次合同评审的结论如下')).toBeTruthy()
  })

  test('≥3 字整串 MATCH：snippet 的 [ ] 命中标记渲染成 <mark>', async () => {
    // 🔴 文件名故意不含 query：否则 `<mark>` 可能来自文件名高亮，这条断言就成了
    //     恒绿装饰（变异验证实测踩到过）。
    mockLibrarySearch.mockResolvedValue({
      query: '合同评审',
      mode: 'trigram',
      hits: [
        libraryHit({
          filename: '季度总结.md',
          path: 'my-docs/notes/季度总结.md',
          rank: -1.4,
          snippet: '…本次[合同评审]的结论…',
          match: 'text'
        })
      ],
      warnings: []
    })
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合同评审')
    // 🔴 面板是 createPortal 到 body 的，render() 的 container 里什么都没有。
    const row = (await screen.findByText('my-docs/notes/季度总结.md')).closest('li') as HTMLElement
    const marks = Array.from(row.querySelectorAll('mark')).map((m) => m.textContent)
    expect(marks).toEqual(['合同评审'])
    // 方括号是标记本身，不该漏进正文。
    expect(row.textContent).not.toContain('[合同评审]')
  })

  test('点击命中行 → 关面板 + 深链 /library?file={id}', async () => {
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合同评审')
    const path = await screen.findByText('my-docs/notes/合同评审.md')
    fireEvent.click(path.closest('li') as HTMLElement)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/library', search: { file: 31 } })
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test("scope 'library'：只看资料库组，Email 组隐藏", async () => {
    useCommandPalette.getState().setOpen(true)
    renderPalette()
    await typeQuery('合同评审')
    await screen.findByText('my-docs/notes/合同评审.md')
    expect(screen.getByText('Email')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: LIBRARY_SCOPE_CHIP }))
    await waitFor(() => expect(screen.queryByText('Email')).toBeNull())
    expect(screen.getByText('my-docs/notes/合同评审.md')).toBeTruthy()
  })
})

describe('CommandPalette — 资料库 lane 的 web build 闸（design §2.5 整域隐藏）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('web build：不发 /library/search，也不出资料库 scope chip', async () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.resetModules()
    const { CommandPalette: WebPalette } = await import('@shared/components/command/CommandPalette')
    const { useCommandPalette: webStore } = await import('@shared/state/command-palette')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <WebPalette />
      </QueryClientProvider>
    )
    webStore.getState().setOpen(true)
    await typeQuery('合同评审')
    await waitFor(() => expect(mockSearch).toHaveBeenCalled())
    expect(mockLibrarySearch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: LIBRARY_SCOPE_CHIP })).toBeNull()
    webStore.getState().setOpen(false)
  })
})
