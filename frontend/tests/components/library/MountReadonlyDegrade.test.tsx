// @vitest-environment happy-dom
//
// F5（owner 09-02 拍板）：**挂载根切只读时，正在编辑的文件降级为只读，未保存文本不丢，也不拒切。**
//
// 这条不变量横跨两个组件 —— 切换发生在树的挂载菜单（`PATCH /library/mounts/{id}`），降级发生在
// 预览面（`FilePreview` 按挂载的 `mode` 推 `readonly`，再把 `MarkdownEditor` 的 mode 压成 `read`）。
// 所以在这里从预览面这一端钉：换一份 `GET /library/tree`（挂载 mode 从 rw 变 ro）就等价于「用户刚在
// 树里切了只读」，不必把两个组件一起渲染。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: {
    tree: vi.fn(),
    file: vi.fn(),
    text: vi.fn(),
    writeFile: vi.fn(),
    inlineUrl: vi.fn(() => 'http://127.0.0.1:8200/api/library/file/1/inline'),
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
import { FilePreview } from '@shared/components/library/FilePreview'
import type { LibraryFileActions } from '@shared/components/library/useLibraryFileActions'
import type { LibraryMountMode } from '@shared/libraryConstants'

await i18n.changeLanguage('en-US')

const MOUNT_ID = 7

function treeWith(mode: LibraryMountMode) {
  return {
    folders: [{ path: '@工作区', parent_path: '', name: '@工作区', mount_id: MOUNT_ID, file_count: 1 }],
    mounts: [
      { id: MOUNT_ID, label: '工作区', path: '@工作区', mode, status: 'ok' as const, file_count: 1 }
    ],
    file_count: 1
  }
}

function fileDetail() {
  return {
    id: 1,
    mount_id: MOUNT_ID,
    rel_path: 'note.md',
    path: '@工作区/note.md',
    parent_path: '@工作区',
    filename: 'note.md',
    kind: 'markdown' as const,
    mime: 'text/markdown',
    size_bytes: 12,
    mtime: 1_756_000_000,
    content_hash: 'aaaaaaaa1111',
    source: 'user' as const,
    source_ref: null,
    created_by: 'user',
    status: 'present' as const,
    text_status: 'extracted' as const,
    created_at: 1_755_000_000,
    updated_at: 1_756_000_000,
    content: 'on disk'
  }
}

function stubActions(): LibraryFileActions {
  return {
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
}

let qc: QueryClient

function renderPreview(): void {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <FilePreview
        fileRef={{ id: 1 }}
        actions={stubActions()}
        onSelectFile={vi.fn()}
        onChat={vi.fn()}
      />
    </QueryClientProvider>
  )
}

/** 换掉树响应并让 query 重取 = 「用户刚在树里切了挂载的权限」。 */
async function switchMountTo(mode: LibraryMountMode): Promise<void> {
  api.tree.mockResolvedValue(treeWith(mode))
  await qc.invalidateQueries({ queryKey: ['library', 'tree'] })
}

function textarea(): HTMLTextAreaElement | null {
  return document.querySelector('textarea')
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue(treeWith('rw'))
  api.file.mockResolvedValue(fileDetail())
  api.text.mockResolvedValue({ file_id: 1, markdown: 'on disk', text_status: 'extracted' })
})
afterEach(cleanup)

describe('挂载根切只读时正在编辑的文件（F5）', () => {
  test('rw 挂载：编辑按钮在，能进编辑态', async () => {
    renderPreview()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(textarea()).not.toBeNull())
  })

  test('切成只读：编辑器降级只读（textarea 与保存按钮都收起），且**没有任何拒绝**', async () => {
    renderPreview()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(textarea()).not.toBeNull())
    fireEvent.change(textarea() as HTMLTextAreaElement, { target: { value: 'my unsaved draft' } })

    await switchMountTo('ro')

    await waitFor(() => expect(textarea()).toBeNull())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    // 降级不是「保存失败」：一次写请求都不该发出去。
    expect(api.writeFile).not.toHaveBeenCalled()
    // 只读态渲染的是磁盘正文，编辑动作整体消失。
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  // 09-03 已修（`MarkdownEditor.tsx`）：`userLeftEdit` ref 区分「用户自己退出编辑态」（取消 /
  // 保存成功 / 放弃冲突，都经 `leaveEdit`）与「被 readonly 压出去」（mode prop 自己变），后者回到
  // edit 时跳过 `setText(content)`，草稿原样留着。
  test('切回可写：未保存的草稿还在编辑框里（没被磁盘正文盖掉）', async () => {
    renderPreview()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(textarea()).not.toBeNull())
    fireEvent.change(textarea() as HTMLTextAreaElement, { target: { value: 'my unsaved draft' } })

    await switchMountTo('ro')
    await waitFor(() => expect(textarea()).toBeNull())
    await switchMountTo('rw')

    await waitFor(() => expect(textarea()).not.toBeNull())
    expect((textarea() as HTMLTextAreaElement).value).toBe('my unsaved draft')
  })
})
