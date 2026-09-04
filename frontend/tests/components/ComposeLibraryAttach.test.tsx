// @vitest-environment happy-dom
//
// compose ←「从资料库选附件」的接线（选择器本体的行为在
// tests/components/library/LibraryFilePicker.test.tsx，这里只断 ComposePanel 这一侧）：
//
//   · 库内文件不经 staging，落地即 done chip，发送时是第三条腿 `{library_file_id}`；
//   · 🔴 投影行（邮件附件，`id: null`）没有 library id，只能走已有的 `{attachment_id}` 腿 ——
//     两种行由同一个选择器交出来，落成哪种 ref 是 compose 这边判的；
//   · 同一个文件重复挑不重复添加；超 20MB 前端先拦（与本机文件那条路同口径）；
//   · 入口跟资料库整域同一道门（`desktopMac`）：非 macOS 桌面不出现。
//
// 选择器整个被 stub 掉：它自己的多选 / 搜索 / 空态有专门的用例，在这里再渲一遍只会把
// library API 的 mock 拖进 compose 的测试里。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { LibraryFile } from '@shared/api/types/library'

const {
  mockSend,
  mockSettingsGet,
  mockUpload,
  mockDraftPlan,
  mockEmailGet,
  mockToastError,
  picked
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSettingsGet: vi.fn(),
  mockUpload: vi.fn(),
  mockDraftPlan: vi.fn(),
  mockEmailGet: vi.fn(),
  mockToastError: vi.fn(),
  // 选择器 stub 点「确认」时交出去的那一批（每条用例自己填）。
  picked: { files: [] as LibraryFile[] }
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      send: mockSend,
      uploadComposeAttachment: mockUpload,
      draftPlan: mockDraftPlan,
      get: mockEmailGet
    },
    settings: { get: mockSettingsGet }
  })
}))
vi.mock('@shared/state/toast', () => ({ toastError: mockToastError, toastSuccess: vi.fn() }))
vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({ EmailBodyFrame: () => null }))
vi.mock('@shared/components/library/LibraryFilePickerDialog', () => ({
  LibraryFilePickerDialog: ({
    open,
    onConfirm
  }: {
    open: boolean
    onConfirm(files: readonly LibraryFile[]): void
  }) =>
    open ? (
      <button type="button" onClick={() => onConfirm(picked.files)}>
        stub-确认挑选
      </button>
    ) : null
}))

import i18n from '@shared/i18n'
import { ComposePanelInner } from '../../src/shared/components/email/compose/ComposePanel'

await i18n.changeLanguage('zh-CN')

function libFile(over: Partial<LibraryFile> = {}): LibraryFile {
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

function setPlatform(platform: string | null): void {
  const w = window as unknown as Record<string, unknown>
  if (platform === null) delete w.electron
  else w.electron = { process: { platform } }
}

function renderCompose(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />
    </QueryClientProvider>
  )
}

/** 打开选择器 → stub 直接确认交出 picked.files。 */
function pickFromLibrary(): void {
  fireEvent.click(screen.getByRole('button', { name: '从资料库选附件' }))
  fireEvent.click(screen.getByRole('button', { name: 'stub-确认挑选' }))
}

async function addRecipient(addr: string): Promise<void> {
  const input = screen.getByLabelText('收件人') as HTMLInputElement
  fireEvent.change(input, { target: { value: addr } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText(addr)).toBeTruthy())
}

async function send(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
  fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
  await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  vi.clearAllMocks()
  setPlatform('darwin')
  picked.files = [libFile()]
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockSend.mockResolvedValue({ sent: true })
})

afterEach(() => {
  cleanup()
  setPlatform(null)
})

describe('compose — 从资料库选附件', () => {
  test('库内文件不经上传直接成 chip，发送时落 {library_file_id}', async () => {
    renderCompose()
    await addRecipient('alice@acme.com')
    pickFromLibrary()
    await waitFor(() => expect(screen.getByText('定价.md')).toBeTruthy())
    expect(mockUpload).not.toHaveBeenCalled()

    await send()
    expect(mockSend.mock.calls[0][0].attachments).toEqual([{ library_file_id: 11 }])
  })

  test('🔴 投影行（邮件附件，没有 library id）走已有的 {attachment_id} 腿', async () => {
    picked.files = [
      libFile({
        id: null,
        filename: '发票.pdf',
        path: 'mail-attachments/2026-09/发票.pdf',
        is_projection: true,
        attachment_id: 77
      })
    ]
    renderCompose()
    await addRecipient('alice@acme.com')
    pickFromLibrary()
    await waitFor(() => expect(screen.getByText('发票.pdf')).toBeTruthy())

    await send()
    expect(mockSend.mock.calls[0][0].attachments).toEqual([{ attachment_id: 77 }])
  })

  test('同一个库文件挑两次只进一条', async () => {
    renderCompose()
    await addRecipient('alice@acme.com')
    pickFromLibrary()
    await waitFor(() => expect(screen.getByText('定价.md')).toBeTruthy())
    pickFromLibrary()

    await send()
    expect(mockSend.mock.calls[0][0].attachments).toEqual([{ library_file_id: 11 }])
  })

  test('超 20MB 的库文件跳过并提示，不进附件列表', async () => {
    picked.files = [libFile({ id: 21, filename: '大包.zip', size_bytes: 21 * 1024 * 1024 })]
    renderCompose()
    await addRecipient('alice@acme.com')
    pickFromLibrary()
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(screen.queryByText('大包.zip')).toBeNull()

    await send()
    expect(mockSend.mock.calls[0][0].attachments).toBeUndefined()
  })

  test('🔴 入口跟资料库整域同一道门：非 macOS 桌面不出现', () => {
    setPlatform('win32')
    renderCompose()
    expect(screen.queryByRole('button', { name: '从资料库选附件' })).toBeNull()
    // 本机文件那条路不受影响。
    expect(screen.getByRole('button', { name: '附件' })).toBeTruthy()
  })
})
