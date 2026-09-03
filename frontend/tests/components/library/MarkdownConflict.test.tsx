// @vitest-environment happy-dom
//
// markdown 编辑保存的 CAS 冲突态（design §4；P1 验收第 1 条：「两处并发改同一文件时后保存者
// 看到冲突态而非覆盖」）。三件事一件都不能少：
//   ① 提示「已被改动」；
//   ② 显示磁盘上的当前版本 —— 🔴 靠**重拉** `GET /library/file/{id}`，409 的 body 在
//      `http_client` 那层被 ApiError 吃掉（只留 code/message/hint），到不了 UI；
//   ③ 我的文本不丢 —— 编辑框里还是我敲的那份，「用我的覆盖」拿新 hash 再写一次。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: {
    tree: vi.fn(),
    file: vi.fn(),
    text: vi.fn(),
    writeFile: vi.fn(),
    inlineUrl: vi.fn(() => ''),
    attachment: vi.fn(),
    attachmentText: vi.fn(),
    attachmentInlineUrl: vi.fn(() => '')
  }
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import i18n from '@shared/i18n'
import { LIBRARY_VERSION_CONFLICT } from '@shared/api/library'
import { FilePreview } from '@shared/components/library/FilePreview'
import type { LibraryFileActions } from '@shared/components/library/useLibraryFileActions'
import type { LibraryFileDetail } from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

const MINE = '# 我改的版本\n\n第二段'
const THEIRS = '# agent 改的版本\n\n它写的那段'

function detail(over: Partial<LibraryFileDetail>): LibraryFileDetail {
  return {
    id: 1,
    mount_id: 0,
    rel_path: 'note.md',
    path: 'my-docs/note.md',
    parent_path: 'my-docs',
    filename: 'note.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 20,
    mtime: 1_756_000_000,
    content_hash: 'oldhash0000',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_755_000_000,
    updated_at: 1_756_000_000,
    content: '# 原始内容',
    ...over
  }
}

const actions: LibraryFileActions = {
  open: vi.fn(),
  reveal: vi.fn(),
  keep: vi.fn(),
  keepAttachment: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn(),
  saveParsedMarkdown: vi.fn(),
  dialogs: null
}

function conflictError(): Error {
  return Object.assign(new Error('version conflict'), { code: LIBRARY_VERSION_CONFLICT })
}

function renderPreview(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <FilePreview fileRef={{ id: 1 }} actions={actions} onSelectFile={vi.fn()} onChat={vi.fn()} />
    </QueryClientProvider>
  )
}

/** 进编辑态、把正文换成 `MINE`、点保存。 */
async function editAndSave(): Promise<HTMLTextAreaElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  const box = (await screen.findByRole('textbox', { name: 'Edit' })) as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: MINE } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  return box
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue({ folders: [], mounts: [], file_count: 0 })
})

afterEach(() => {
  cleanup()
})

describe('markdown 保存冲突（409）', () => {
  test('提示已被改动 / 显示当前版本 / 我的文本不丢', async () => {
    // 打开时读到 oldhash；保存时服务端说已经变成 newhash 了。
    api.file
      .mockResolvedValueOnce(detail({}))
      .mockResolvedValue(detail({ content: THEIRS, content_hash: 'newhash1111' }))
    api.writeFile.mockRejectedValue(conflictError())
    renderPreview()

    const box = await editAndSave()

    expect(await screen.findByText('File was changed')).toBeTruthy()
    // 当前版本来自**重拉**，不是 409 的 body。
    await waitFor(() => expect(api.file).toHaveBeenCalledTimes(2))
    const current = screen.getByTestId('library-conflict-current')
    expect(current.textContent).toContain('agent 改的版本')
    // 🔴 验收第 1 条的核心：我的文本原样留在编辑框里。
    expect(box.value).toBe(MINE)
  })

  test('「用我的覆盖」拿重拉回来的新 hash 再写一次（不是重发旧 hash）', async () => {
    api.file
      .mockResolvedValueOnce(detail({}))
      .mockResolvedValue(detail({ content: THEIRS, content_hash: 'newhash1111' }))
    api.writeFile.mockRejectedValueOnce(conflictError()).mockResolvedValue(detail({}))
    renderPreview()

    await editAndSave()
    await screen.findByText('File was changed')
    expect(api.writeFile).toHaveBeenNthCalledWith(
      1,
      1,
      expect.objectContaining({ expected_hash: 'oldhash0000', content: MINE })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }))
    await waitFor(() => expect(api.writeFile).toHaveBeenCalledTimes(2))
    expect(api.writeFile).toHaveBeenNthCalledWith(
      2,
      1,
      expect.objectContaining({ expected_hash: 'newhash1111', content: MINE })
    )
  })

  test('没撞冲突时正常保存：带打开时读到的 hash，然后回只读态', async () => {
    api.file.mockResolvedValue(detail({}))
    api.writeFile.mockResolvedValue(detail({ content: MINE, content_hash: 'newhash2222' }))
    renderPreview()

    await editAndSave()

    await waitFor(() =>
      expect(api.writeFile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ expected_hash: 'oldhash0000', content: MINE })
      )
    )
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit' })).toBeNull())
    expect(screen.queryByText('File was changed')).toBeNull()
  })
})
