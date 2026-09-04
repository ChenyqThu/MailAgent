// @vitest-environment happy-dom
//
// 资料库文件选择器（compose「从资料库选附件」的入口组件；mockup G 的 `LibraryPicker`）。
//
// 五条判据，前两条是这个组件唯一的职责：
//   ① 多选**跨文件夹、跨页签累加** —— 换文件夹 / 切到搜索页签时选中集不能被当前列表清掉；
//   ② 确认时交出去的是**文件对象本身**（调用方要 filename / size_bytes / id），不是 id 数组；
//   ③ 🔴 投影行（邮件附件，`id: null` 只有 `attachment_id`）**可选**且原样交出 —— 只读投影
//      是「不能写」不是「不能读」，把它禁掉等于「邮件附件转发不了」；
//   ④ 空文件夹与「真的零命中」各有各的空态，而中文 1 字是**出提示、不出结果**（服务端
//      `warnings` 非空 + 零命中），渲染成「没有匹配的文件」= 把「根本没查」说成「查了没有」；
//   ⑤ 取消不回调（且清掉这次的选择）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: { tree: vi.fn(), folder: vi.fn(), search: vi.fn() }
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

import i18n from '@shared/i18n'
import { LibraryFilePickerDialog } from '@shared/components/library/LibraryFilePickerDialog'
import type {
  LibraryFile,
  LibraryFolderPage,
  LibrarySearchHit,
  LibrarySearchResponse
} from '@shared/api/types/library'

await i18n.changeLanguage('zh-CN')

function file(over: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: 11,
    mount_id: 0,
    rel_path: '定价.md',
    path: 'my-docs/定价.md',
    parent_path: 'my-docs',
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
    ...over
  }
}

function page(files: LibraryFile[], path = 'my-docs'): LibraryFolderPage {
  return { path, folders: [], files, total: files.length, limit: 200, offset: 0, has_more: false }
}

function searchResponse(over: Partial<LibrarySearchResponse> = {}): LibrarySearchResponse {
  const hit: LibrarySearchHit = {
    ...file({ id: 33, filename: '合同.pdf', path: 'my-docs/合同.pdf' }),
    snippet: null,
    rank: null,
    match: 'filename',
    lane: 'fts'
  }
  return {
    query: '合同',
    mode: 'trigram',
    search_mode: 'hybrid',
    semantic: { available: true, model: 'qwen3-embed', chunks: 10 },
    hits: [hit],
    warnings: [],
    ...over
  }
}

const onConfirm = vi.fn()
const onOpenChange = vi.fn()

function renderPicker(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <LibraryFilePickerDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />
    </QueryClientProvider>
  )
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '添加为附件' }) as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue({
    folders: [
      { path: 'my-docs', parent_path: '', name: 'my-docs', mount_id: 0, file_count: 2 },
      {
        path: 'mail-attachments',
        parent_path: '',
        name: 'mail-attachments',
        mount_id: 0,
        file_count: 1
      }
    ],
    mounts: [],
    file_count: 3
  })
  api.folder.mockImplementation(async (path: string) =>
    path === 'mail-attachments'
      ? page(
          [
            file({
              id: null,
              filename: '发票.pdf',
              path: 'mail-attachments/2026-09/发票.pdf',
              parent_path: 'mail-attachments/2026-09',
              is_projection: true,
              attachment_id: 77
            })
          ],
          'mail-attachments'
        )
      : page([file(), file({ id: 12, filename: '排期.md', path: 'my-docs/排期.md' })])
  )
  api.search.mockResolvedValue(searchResponse())
})

afterEach(() => cleanup())

describe('资料库文件选择器', () => {
  test('打开即落「我的文档」，列出该文件夹的文件', async () => {
    renderPicker()
    await screen.findByLabelText('定价.md')
    expect(screen.getByLabelText('排期.md')).toBeTruthy()
    expect(api.folder).toHaveBeenCalledWith('my-docs', expect.objectContaining({ sort: 'date' }))
  })

  test('没选任何文件时确认钮禁用；选了才可点', async () => {
    renderPicker()
    await screen.findByLabelText('定价.md')
    expect(confirmButton().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('定价.md'))
    expect(confirmButton().disabled).toBe(false)
  })

  test('多选 + 再点一次取消选：计数跟着走，确认交出剩下的那些**文件对象**', async () => {
    renderPicker()
    await screen.findByLabelText('定价.md')
    fireEvent.click(screen.getByLabelText('定价.md'))
    fireEvent.click(screen.getByLabelText('排期.md'))
    expect(screen.getByText('已选 2 个')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('定价.md'))
    expect(screen.getByText('已选 1 个')).toBeTruthy()

    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 12, filename: '排期.md', size_bytes: 900 })
    ])
  })

  test('🔴 选中集跨文件夹累加：换文件夹不清掉上一个文件夹选的', async () => {
    renderPicker()
    await screen.findByLabelText('定价.md')
    fireEvent.click(screen.getByLabelText('定价.md'))

    fireEvent.click(screen.getByRole('treeitem', { name: '邮件附件' }))
    await screen.findByLabelText('发票.pdf')
    expect(screen.getByText('已选 1 个')).toBeTruthy()

    // 🔴 投影行（id 为 null，只有 attachment_id）可选，且原样交给调用方。
    fireEvent.click(screen.getByLabelText('发票.pdf'))
    fireEvent.click(confirmButton())
    expect(onConfirm.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 11 }),
      expect.objectContaining({ id: null, attachment_id: 77 })
    ])
  })

  test('搜索页签：输入即出命中行，且与树里选的累加', async () => {
    renderPicker()
    await screen.findByLabelText('定价.md')
    fireEvent.click(screen.getByLabelText('定价.md'))

    fireEvent.click(screen.getByRole('tab', { name: '搜索' }))
    fireEvent.change(screen.getByTestId('library-picker-search-input'), {
      target: { value: '合同' }
    })
    await screen.findByLabelText('合同.pdf')
    fireEvent.click(screen.getByLabelText('合同.pdf'))
    fireEvent.click(confirmButton())
    expect(onConfirm.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 11 }),
      expect.objectContaining({ id: 33 })
    ])
  })

  test('空文件夹出「这个文件夹里没有文件」', async () => {
    api.folder.mockResolvedValue(page([]))
    renderPicker()
    expect(await screen.findByTestId('library-picker-empty-folder')).toBeTruthy()
  })

  test('搜索真的零命中才给空态', async () => {
    api.search.mockResolvedValue(searchResponse({ hits: [], warnings: [] }))
    renderPicker()
    fireEvent.click(screen.getByRole('tab', { name: '搜索' }))
    fireEvent.change(screen.getByTestId('library-picker-search-input'), {
      target: { value: 'zzz' }
    })
    expect(await screen.findByTestId('library-picker-search-empty')).toBeTruthy()
  })

  test('🔴 中文 1 字：出提示、不出「没有匹配的文件」', async () => {
    api.search.mockResolvedValue(searchResponse({ hits: [], warnings: ['cjk_too_short:价'] }))
    renderPicker()
    fireEvent.click(screen.getByRole('tab', { name: '搜索' }))
    fireEvent.change(screen.getByTestId('library-picker-search-input'), { target: { value: '价' } })
    await waitFor(() => expect(screen.getByText(i18n.t('library.search.tooShort'))).toBeTruthy())
    expect(screen.queryByTestId('library-picker-search-empty')).toBeNull()
  })

  test('取消：不回调 onConfirm，关闭', async () => {
    renderPicker()
    await screen.findByLabelText('定价.md')
    fireEvent.click(screen.getByLabelText('定价.md'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })
})
