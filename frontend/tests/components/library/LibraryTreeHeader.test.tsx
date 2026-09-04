// @vitest-environment happy-dom
//
// 左树头部的搜索与排序（dogfood 0903 owner 反馈第 3 件：「详情页顶部的搜索太重」）。
//
// 搬家之后有三条判据，前两条错了在真 app 里就是「搜不了」和「排序钮点了没反应」：
//   · 搜索框在**树面**里，输入即回调（词本身住在 workspace —— 内容区要按它切结果面）；
//   · 排序钮开的是同一份 `library-tree` store 的 sortKey / sortDir，四个键 + 两个方向；
//   · 🔴 投影区 / 废纸篓的排序由服务端定死（`sortDisabledHint`），钮必须置灰 —— 这条原先由
//     FolderView 工具条上那个钮承担，控件搬上来判据也得跟着搬，漏了就是「点了没反应还没提示」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: { tree: vi.fn(), mounts: vi.fn() }
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ settings: { pickFolder: vi.fn() } })
}))

import i18n from '@shared/i18n'
import { LibraryTreePanel } from '@shared/components/library/LibraryTreePanel'
import { resetLibraryTreeState, useLibraryTree } from '@shared/state/library-tree'
import { PROJECTION_SLUG, TRASH_SLUG } from '@shared/libraryConstants'

await i18n.changeLanguage('zh-CN')

const onSearchChange = vi.fn()

function renderTree(selectedPath: string, query = ''): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <LibraryTreePanel
        selectedPath={selectedPath}
        expanded={new Set<string>()}
        searchQuery={query}
        onSearchChange={onSearchChange}
        onSelectFolder={vi.fn()}
        onExpandedChange={vi.fn()}
        onNewMarkdown={vi.fn()}
        onImportFiles={vi.fn()}
        onReveal={vi.fn()}
      />
    </QueryClientProvider>
  )
}

/** 排序菜单里可见的项（含方向那两条）。 */
async function openSortMenu(): Promise<string[]> {
  fireEvent.click(screen.getByTestId('library-tree-sort'))
  await screen.findByRole('menu')
  return Array.from(document.querySelectorAll('[role="menu"] [role="menuitemradio"]')).map(
    (el) => el.textContent?.trim() ?? ''
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // 🔴 先清持久化再 reset —— `resetLibraryTreeState` 读的是 localStorage 那份，只调它的话
  // 上一条用例选过的排序会漏进下一条（本文件恰好有「出厂是 date/desc」的断言）。
  window.localStorage.removeItem('mailagent.library.tree.v1')
  resetLibraryTreeState()
  api.tree.mockResolvedValue({
    folders: [{ path: 'my-docs', parent_path: '', name: 'my-docs', mount_id: 0, file_count: 2 }],
    mounts: [],
    file_count: 2
  })
})

afterEach(() => {
  cleanup()
})

describe('资料库左树头部', () => {
  test('搜索框在树面里，输入即上行给 workspace', async () => {
    renderTree('my-docs')
    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '定价' } })
    expect(onSearchChange).toHaveBeenCalledWith('定价')
  })

  test('有词时给清除按钮，点了回空串', () => {
    renderTree('my-docs', '定价')
    fireEvent.click(screen.getByTestId('library-search-clear'))
    expect(onSearchChange).toHaveBeenLastCalledWith('')
  })

  test('排序菜单 = 四个键 + 两个方向', async () => {
    renderTree('my-docs')
    expect(await openSortMenu()).toEqual(['按名称', '按大小', '按类型', '按时间', '升序', '降序'])
  })

  test('选一个排序键 → 落进 store（换键回该键的自然序）', async () => {
    renderTree('my-docs')
    await openSortMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: '按名称' }))
    await waitFor(() => expect(useLibraryTree.getState().sortKey).toBe('name'))
    // 出厂是 date/desc；换到 name 走自然序 asc（store 的 setSort 规则）。
    expect(useLibraryTree.getState().sortDir).toBe('asc')
  })

  test('选方向 → 只改方向，不动排序键', async () => {
    renderTree('my-docs')
    await openSortMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: '升序' }))
    await waitFor(() => expect(useLibraryTree.getState().sortDir).toBe('asc'))
    expect(useLibraryTree.getState().sortKey).toBe('date')
  })

  test('🔴 投影区文件夹：排序由服务端定死 ⇒ 钮置灰并给出原因', () => {
    renderTree(`${PROJECTION_SLUG}/2026-09`)
    const button = screen.getByTestId('library-tree-sort') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe(i18n.t('library.folder.sortDisabledHint'))
  })

  test('🔴 废纸篓同理置灰', () => {
    renderTree(TRASH_SLUG)
    expect((screen.getByTestId('library-tree-sort') as HTMLButtonElement).disabled).toBe(true)
  })

  test('普通文件夹不置灰，title 里带着当前排序', () => {
    renderTree('my-docs')
    const button = screen.getByTestId('library-tree-sort') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.title).toContain(i18n.t('library.folder.sortDate'))
  })
})
