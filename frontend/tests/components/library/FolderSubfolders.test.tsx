// @vitest-environment happy-dom
//
// dogfood 0903 —— 文件夹视图必须画出子文件夹。
//
// 报的现象：「点开文件夹，没有显示子文件夹；如果一个文件夹下全都是子文件夹，会显示为空。」
// 根因不是服务端 —— `/library/folder` 一直在返 `folders`，是内容区只画了 `files`。
//
// 三条判据：
//   ① 只有子文件夹、零文件的文件夹**不是空态**（这正是 `mail-attachments` 按月分组那一层）；
//   ② 点子文件夹 = 调 `onOpenFolder(它的虚拟路径)`；
//   ③ 顶层那五个 slug 显示 i18n 文案，再往下显示真实目录名。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: { folder: vi.fn(), tree: vi.fn() }
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

import i18n from '@shared/i18n'
import { FolderView } from '@shared/components/library/FolderView'
import type { LibraryFileActions } from '@shared/components/library/useLibraryFileActions'

await i18n.changeLanguage('en-US')

function stubActions(): LibraryFileActions {
  return {
    open: vi.fn(),
    reveal: vi.fn(),
    keep: vi.fn(),
    move: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
    purge: vi.fn(),
    deriveParsed: vi.fn(),
    dialogs: null
  } as unknown as LibraryFileActions
}

const onOpenFolder = vi.fn()

function renderAt(path: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <FolderView
        path={path}
        readonly
        trash={false}
        actions={stubActions()}
        onOpenFile={vi.fn()}
        onOpenFolder={onOpenFolder}
        onDropFiles={vi.fn()}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  onOpenFolder.mockReset()
  api.tree.mockResolvedValue({ folders: [], mounts: [], file_count: 0 })
})
afterEach(cleanup)

describe('文件夹视图 — 子文件夹', () => {
  test('只有子文件夹、零文件时不是空态，点一下进得去', async () => {
    api.folder.mockResolvedValue({
      path: 'mail-attachments',
      folders: [
        { name: '2026-09', path: 'mail-attachments/2026-09', file_count: 12 },
        { name: '2026-08', path: 'mail-attachments/2026-08', file_count: 3 }
      ],
      files: [],
      total: 0,
      limit: 200,
      offset: 0,
      has_more: false
    })
    renderAt('mail-attachments')

    await waitFor(() => expect(screen.getAllByTestId('library-folder-tile')).toHaveLength(2))
    // 空态文案绝不能同时在场 —— 这正是 owner 报的现象。
    expect(screen.queryByText('No files in this folder yet')).toBeNull()
    expect(screen.getByText('12 files')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Open folder 2026-09'))
    expect(onOpenFolder).toHaveBeenCalledWith('mail-attachments/2026-09')
  })

  test('顶层 slug 走 i18n 文案，子目录用真实目录名', async () => {
    api.folder.mockResolvedValue({
      path: '',
      folders: [
        { name: 'my-docs', path: 'my-docs', file_count: 4 },
        { name: 'plans', path: 'my-docs/plans', file_count: 1 }
      ],
      files: [],
      total: 0,
      limit: 200,
      offset: 0,
      has_more: false
    })
    renderAt('')

    await waitFor(() => expect(screen.getAllByTestId('library-folder-tile')).toHaveLength(2))
    expect(screen.getByLabelText('Open folder My docs')).toBeTruthy()
    expect(screen.getByLabelText('Open folder plans')).toBeTruthy()
  })
})
