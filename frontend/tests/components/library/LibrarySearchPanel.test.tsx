// @vitest-environment happy-dom
//
// 资料库页内的全库搜索面（task 09-03 P2-L7 后半；design §9.1，mockup B3 / E1）。
// 四条判据，前两条是这条 lane 最容易做错的地方：
//
//   ① 🔴 **中文 1 字 = 出提示、不出结果**（服务端 `warnings: ['cjk_too_short:X']` + 零命中）。
//      渲染成「没有匹配的文件」= 把「这次根本没查」说成「查了没有」—— 用户会以为库里真没有。
//   ② 🔴 snippet 的命中标记是**字面 `[` / `]`**（`src/library/repository.py::search` 的
//      `snippet(…, '[', ']', …)`），不是 `<mark>` ⇒ 切段按 React 节点渲，**正文一个字符都不进
//      innerHTML**。断法：喂一段长得像 HTML 的正文，`<b>` 必须还是字面文本、不能变成元素
//      （断 innerHTML 里有没有 `[` 是无效断言 —— Tailwind 的 `rounded-[2px]` 自己就带方括号）。
//   ③ 语义腿没就绪（`semantic.available === false`）要明示「纯关键词」—— 它**不在 warnings 里**
//      （服务端有意为之），UI 不自己渲就永远没人知道。
//   ④ 2 字走 LIKE：有结果、但服务端 `rank` 为 null（按 mtime 排）——照样出行，不显示相关度。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({ api: { search: vi.fn() } }))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

import i18n from '@shared/i18n'
import {
  LibrarySearchBar,
  LibrarySearchResults
} from '@shared/components/library/LibrarySearchPanel'
import type {
  LibrarySearchHit,
  LibrarySearchResponse
} from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

function hit(over: Partial<LibrarySearchHit> = {}): LibrarySearchHit {
  return {
    id: 12,
    mount_id: 0,
    rel_path: 'plans/定价.md',
    path: 'my-docs/plans/定价.md',
    parent_path: 'my-docs/plans',
    filename: '定价.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 900,
    mtime: 1_756_000_000,
    content_hash: 'h',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_755_000_000,
    updated_at: 1_756_000_000,
    snippet: '本季度[客单价]继续上行',
    rank: -1.2,
    match: 'text',
    lane: 'fts',
    ...over
  }
}

function response(over: Partial<LibrarySearchResponse> = {}): LibrarySearchResponse {
  return {
    query: '客单价',
    mode: 'trigram',
    search_mode: 'hybrid',
    semantic: { available: true, model: 'qwen3-embed', chunks: 120 },
    hits: [hit()],
    warnings: [],
    ...over
  }
}

const onSelect = vi.fn()

function renderResults(query: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <LibrarySearchResults query={query} onSelectFile={onSelect} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.search.mockResolvedValue(response())
})

afterEach(() => {
  cleanup()
})

describe('P2-L7 资料库页内搜索', () => {
  test('≥3 字：出行 + snippet 命中标记切成 <mark>，正文不进 innerHTML', async () => {
    renderResults('客单价')
    const row = await screen.findByTestId('library-search-row')
    expect(row.textContent).toContain('定价.md')
    expect(row.textContent).toContain('my-docs/plans/定价.md')

    const snippet = screen.getByTestId('library-search-snippet')
    // 命中段是真的 <mark> 节点……
    expect(snippet.querySelector('mark')?.textContent).toBe('客单价')
    // ……而字面括号一个都不该漏到正文里（漏了 = 没切段，直接把服务端串塞进去了）。
    expect(snippet.textContent).toBe('本季度客单价继续上行')
  })

  test('🔴 snippet 正文永不进 innerHTML：像 HTML 的正文按字面渲染', async () => {
    api.search.mockResolvedValue(
      response({ hits: [hit({ snippet: '<b>加粗</b> 与 [命中]' })] })
    )
    renderResults('加粗')
    const snippet = await screen.findByTestId('library-search-snippet')
    // 走了 dangerouslySetInnerHTML 这里就会多出一个真的 <b> 元素。
    expect(snippet.querySelector('b')).toBeNull()
    expect(snippet.textContent).toBe('<b>加粗</b> 与 命中')
    expect(snippet.querySelector('mark')?.textContent).toBe('命中')
  })

  test('🔴 中文 1 字：出提示、不出结果，且不能说成「没有匹配的文件」', async () => {
    api.search.mockResolvedValue(
      response({ query: '价', mode: 'too_short', hits: [], warnings: ['cjk_too_short:价'] })
    )
    renderResults('价')
    await waitFor(() =>
      expect(screen.getByText(i18n.t('library.search.tooShort'))).toBeTruthy()
    )
    expect(screen.queryByTestId('library-search-row')).toBeNull()
    expect(screen.queryByTestId('library-search-empty')).toBeNull()
  })

  test('真的零命中（没有 warning）才给空态', async () => {
    api.search.mockResolvedValue(response({ query: 'zzz', mode: 'porter', hits: [], warnings: [] }))
    renderResults('zzz')
    await waitFor(() => expect(screen.getByTestId('library-search-empty')).toBeTruthy())
  })

  test('🔴 语义腿没就绪要明示「纯关键词」（它不在 warnings 里）', async () => {
    api.search.mockResolvedValue(
      response({
        search_mode: 'fts',
        semantic: { available: false, model: null, chunks: 0 }
      })
    )
    renderResults('客单价')
    await waitFor(() =>
      expect(screen.getByText(i18n.t('library.search.noSemantic'))).toBeTruthy()
    )
  })

  test('语义就绪时不挂那句提示', async () => {
    renderResults('客单价')
    await screen.findByTestId('library-search-row')
    expect(screen.queryByText(i18n.t('library.search.noSemantic'))).toBeNull()
  })

  test('2 字走 LIKE：rank 为 null 照样出行，不显示相关度', async () => {
    api.search.mockResolvedValue(
      response({ query: '定价', mode: 'like', hits: [hit({ rank: null, snippet: '本季度定价方案' })] })
    )
    renderResults('定价')
    const row = await screen.findByTestId('library-search-row')
    expect(row.textContent).toContain('定价.md')
    expect(screen.getByTestId('library-search-snippet').textContent).toBe('本季度定价方案')
  })

  test('点一行 = 交给调用方去打开那个文件', async () => {
    renderResults('客单价')
    fireEvent.click(await screen.findByTestId('library-search-row'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }))
  })

  test('搜索框：输入即受控回调；有内容时给清除按钮', () => {
    const onChange = vi.fn()
    const { rerender } = render(<LibrarySearchBar value="" onChange={onChange} />)
    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '客单价' } })
    expect(onChange).toHaveBeenCalledWith('客单价')
    expect(screen.queryByTestId('library-search-clear')).toBeNull()

    rerender(<LibrarySearchBar value="客单价" onChange={onChange} />)
    fireEvent.click(screen.getByTestId('library-search-clear'))
    expect(onChange).toHaveBeenLastCalledWith('')
  })
})
