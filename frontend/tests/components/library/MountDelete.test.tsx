// @vitest-environment happy-dom
//
// 挂载区删除走系统废纸篓（F12 / design §8.2；task 09-03）。
//
// 🔴 服务端对挂载区文件的 `DELETE /library/file/{id}` **恒拒** `E_AUTH_FAILED` —— 那不是缺陷，
// 是「我们不接管用户自己目录里的文件」。所以 renderer 这一侧必须按 `mount_id` 分流：
//   · `mount_id > 0` → 主进程 `shell.trashItem`（`trashLibraryTarget`），**一次 `trashFile` 都不发**，
//     删完让那个挂载对账一次（否则那行会以 present 的样子留在列表里）；
//   · `mount_id === 0` → 库内 `.trash`（`DELETE /library/file/{id}`），IPC 一次都不调。
// 文案同样在菜单层就分开（F12）：挂载区那条是「移到系统废纸篓」，别让用户以为进的是库内废纸篓。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api, trashLibraryTarget } = vi.hoisted(() => ({
  api: {
    tree: vi.fn(),
    file: vi.fn(),
    text: vi.fn(),
    trashFile: vi.fn(),
    rescan: vi.fn(),
    inlineUrl: vi.fn(() => ''),
    attachment: vi.fn(),
    attachmentText: vi.fn(),
    attachmentInlineUrl: vi.fn(() => '')
  },
  trashLibraryTarget: vi.fn()
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
// `openTargetOf` 用真的（它就是「file id 还是 attachment id」那条判据），只替身掉 IPC 本身。
vi.mock('@shared/components/library/libraryIpc', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  trashLibraryTarget
}))
vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import i18n from '@shared/i18n'
import { FilePreview } from '@shared/components/library/FilePreview'
import { useLibraryFileActions } from '@shared/components/library/useLibraryFileActions'
import type { LibraryFileDetail } from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

const MOUNT_ID = 7

function detail(mountId: number): LibraryFileDetail {
  return {
    id: 1,
    mount_id: mountId,
    rel_path: 'note.md',
    path: mountId > 0 ? '@工作区/note.md' : 'my-docs/note.md',
    parent_path: mountId > 0 ? '@工作区' : 'my-docs',
    filename: 'note.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 12,
    mtime: 1_756_000_000,
    content_hash: 'h',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_755_000_000,
    updated_at: 1_756_000_000,
    content: 'body'
  }
}

function treeWithMount() {
  return {
    folders: [],
    mounts: [
      {
        id: MOUNT_ID,
        label: '工作区',
        path: '@工作区',
        mode: 'rw' as const,
        status: 'ok' as const,
        file_count: 1
      }
    ],
    file_count: 1
  }
}

function Harness(): React.JSX.Element {
  const actions = useLibraryFileActions()
  return (
    <>
      <FilePreview fileRef={{ id: 1 }} actions={actions} onSelectFile={vi.fn()} onChat={vi.fn()} />
      {actions.dialogs}
    </>
  )
}

function renderPreview(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue(treeWithMount())
  api.text.mockResolvedValue({ file_id: 1, markdown: 'body', text_status: 'extracted' })
  api.trashFile.mockResolvedValue(detail(0))
  api.rescan.mockResolvedValue({ scanned: 1, added: 0, updated: 0, missing: 1, elapsed_ms: 3 })
  trashLibraryTarget.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe('挂载区删除（F12）', () => {
  test('🔴 挂载区：走系统废纸篓 + 对账，一次 trashFile 都不发', async () => {
    api.file.mockResolvedValue(detail(MOUNT_ID))
    renderPreview()

    // 菜单文案在这一层就分开了。
    const del = await screen.findByRole('button', {
      name: i18n.t('library.trash.moveToSystemTrash')
    })
    fireEvent.click(del)
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('library.actions.delete') })
    )

    await waitFor(() =>
      expect(trashLibraryTarget).toHaveBeenCalledWith({ kind: 'file', fileId: 1 })
    )
    expect(api.trashFile).not.toHaveBeenCalled()
    await waitFor(() => expect(api.rescan).toHaveBeenCalledWith(MOUNT_ID))
  })

  test('库内：照旧进库内 .trash，IPC 一次都不调', async () => {
    api.file.mockResolvedValue(detail(0))
    renderPreview()

    const del = await screen.findByRole('button', { name: i18n.t('library.actions.delete') })
    fireEvent.click(del)
    // 确认框的确认键与库内删除动作同名，取最后一个（对话框后渲染）。
    const confirms = await screen.findAllByRole('button', {
      name: i18n.t('library.actions.delete')
    })
    fireEvent.click(confirms[confirms.length - 1] as HTMLElement)

    await waitFor(() => expect(api.trashFile).toHaveBeenCalledWith(1))
    expect(trashLibraryTarget).not.toHaveBeenCalled()
    expect(api.rescan).not.toHaveBeenCalled()
  })

  test('系统废纸篓失败 → 不谎报成功（不发对账、确认框留着）', async () => {
    api.file.mockResolvedValue(detail(MOUNT_ID))
    trashLibraryTarget.mockResolvedValue({ ok: false, code: 'E_INTERNAL', message: 'denied' })
    renderPreview()

    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('library.trash.moveToSystemTrash') })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('library.actions.delete') })
    )

    await waitFor(() => expect(trashLibraryTarget).toHaveBeenCalled())
    expect(api.rescan).not.toHaveBeenCalled()
    expect(api.trashFile).not.toHaveBeenCalled()
  })
})
