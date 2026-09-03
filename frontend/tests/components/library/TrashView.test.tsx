// @vitest-environment happy-dom
//
// 废纸篓视图（task 09-03 P2-L4；design §1.1 + mockup C13 + F11）。四条判据：
//   ① 「原位置」显示的是**原来那个文件夹**（`parent_path`，服务端软删时**有意保留**它供 restore），
//      不是 `.trash/{id}/…` 那条搬过去的路径 —— 显示搬走后的路径等于没告诉用户东西原来在哪；
//   ② 剩余天数按 `TRASH_TTL_DAYS` 从 `updated_at` 算，≤5 天转警示色；
//   ③ 恢复 = 直接调 `POST /restore`（软删可逆，不拦一道）；
//   ④ 🔴 F11「立即永久删除」**必须二次确认**：点按钮只开确认框，确认后才 `DELETE ?purge=true`。
//
// 用真的 `useLibraryFileActions`（确认框就住在它里面）—— 只把 REST client 换成替身，
// 这样「两步确认」这条判据验的是产品里真的那条链，不是测试自己搭的。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: {
    folder: vi.fn(),
    tree: vi.fn(),
    restoreFile: vi.fn(),
    purgeFile: vi.fn(),
    trashFile: vi.fn()
  }
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
import { useLibraryFileActions } from '@shared/components/library/useLibraryFileActions'
import { TRASH_SLUG, TRASH_TTL_DAYS } from '@shared/libraryConstants'
import type { LibraryFile } from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

/** 3 天前删的 ⇒ 还剩 27 天（真实时钟，不装假定时器：waitFor 也要走真定时器）。 */
const TRASHED_AT = Date.now() / 1000 - 3 * 86_400

const TRASHED: LibraryFile = {
  id: 7,
  mount_id: 0,
  // 服务端软删把 rel_path 搬到 `.trash/{id}/{filename}`，但 parent_path 留着原文件夹。
  rel_path: `${TRASH_SLUG}/7/sow.md`,
  path: `${TRASH_SLUG}/7/sow.md`,
  parent_path: 'my-docs/plans',
  filename: 'sow.md',
  kind: 'markdown',
  mime: 'text/markdown',
  size_bytes: 320,
  mtime: TRASHED_AT,
  content_hash: 'h',
  source: 'user',
  source_ref: null,
  created_by: 'user',
  status: 'trashed',
  text_status: 'extracted',
  created_at: 1_755_000_000,
  updated_at: TRASHED_AT
}

function page(files: LibraryFile[]) {
  return { path: TRASH_SLUG, folders: [], files, total: files.length, limit: 200, offset: 0, has_more: false }
}

/** 产品里的接法：动作 hook 持有确认框，页面渲染一次 `actions.dialogs`。 */
function Harness(): React.JSX.Element {
  const actions = useLibraryFileActions()
  return (
    <>
      <FolderView
        path={TRASH_SLUG}
        readonly
        trash
        actions={actions}
        onOpenFile={vi.fn()}
        onDropFiles={vi.fn()}
      />
      {actions.dialogs}
    </>
  )
}

function renderTrash(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue({ folders: [], mounts: [], file_count: 0 })
  api.folder.mockResolvedValue(page([TRASHED]))
  api.restoreFile.mockResolvedValue({ ...TRASHED, status: 'present' })
  api.purgeFile.mockResolvedValue({ ...TRASHED })
})

afterEach(() => {
  cleanup()
})

describe('P2-L4 废纸篓视图', () => {
  test('「原位置」是原来的文件夹，不是 .trash 里那条搬过去的路径', async () => {
    renderTrash()
    const row = await screen.findByTestId('library-trash-row')
    // 断在属性上而不是渲染文案：这一行的文案是带 `{path}` 的插值串，locale 落地前后
    // 文案会变，而「喂进去的是哪个字段」是这条判据的全部。
    expect(row.querySelector('[data-trash-origin]')?.getAttribute('data-trash-origin')).toBe(
      'my-docs/plans'
    )
    // 搬过去的那条路径（`.trash/7/sow.md`）一个字都不该出现在行上。
    expect(row.textContent).not.toContain(TRASHED.path)
  })

  test('剩余天数按保留期算', async () => {
    renderTrash()
    const row = await screen.findByTestId('library-trash-row')
    expect(row.textContent).toContain(String(TRASH_TTL_DAYS - 3))
  })

  test('恢复 = 直接调 restore（软删可逆，不拦确认）', async () => {
    renderTrash()
    await screen.findByTestId('library-trash-row')
    fireEvent.click(screen.getByTestId('library-trash-restore'))
    await waitFor(() => expect(api.restoreFile).toHaveBeenCalledWith(7))
  })

  test('🔴 F11 永久删除必须二次确认：点按钮不删，确认后才 purge', async () => {
    renderTrash()
    await screen.findByTestId('library-trash-row')

    fireEvent.click(screen.getByTestId('library-trash-purge'))
    expect(api.purgeFile).not.toHaveBeenCalled()
    // 确认框里出现的是「永久删除」那套文案（与「移到废纸篓」不是同一句）。
    await screen.findByText(i18n.t('library.trash.deleteForeverConfirmTitle', { name: 'sow.md' }))

    fireEvent.click(screen.getByRole('button', { name: i18n.t('library.trash.deleteForeverConfirm') }))
    await waitFor(() => expect(api.purgeFile).toHaveBeenCalledWith(7))
  })

  test('废纸篓空了给自己的空态，不是「把文件拖进来」', async () => {
    api.folder.mockResolvedValue(page([]))
    renderTrash()
    await waitFor(() => expect(screen.getByTestId('library-trash-empty')).toBeTruthy())
    expect(screen.queryByText(i18n.t('library.empty.folderHint'))).toBeNull()
  })
})
