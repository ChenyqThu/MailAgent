// @vitest-environment happy-dom
//
// 预览面的分派与动作可见性（task 09-03 P1-L5；design §2.3 / §2.4，mockup C1 / C5-C8）。
// 钉住四组判据 —— 每一条错了在真 app 里都是「按钮在不该在的地方」或「面不对」：
//   · 动作条按 source / is_projection / status 分档（投影行没有编辑·移动·删除·历史）；
//   · `text_status` 三态各自的面（pending / failed / unsupported）；
//   · missing / trashed 的横幅与写动作收窄；
//   · F1 剥 frontmatter（只读面不能出现 `---` 与 `title:`）、F2「派生自 X」回链 chip。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: {
    tree: vi.fn(),
    folder: vi.fn(),
    file: vi.fn(),
    text: vi.fn(),
    inlineUrl: vi.fn(() => 'http://127.0.0.1:8200/api/library/file/1/inline'),
    attachment: vi.fn(),
    attachmentText: vi.fn(),
    attachmentInlineUrl: vi.fn(() => 'http://127.0.0.1:8200/api/library/attachment/9/inline')
  }
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
// Streamdown 的真渲染对本文件的断言没有信息量，还会把 `---` 变成 <hr> 让「剥没剥掉」不可见。
vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import i18n from '@shared/i18n'
import { FilePreview } from '@shared/components/library/FilePreview'
import type { LibraryFileActions } from '@shared/components/library/useLibraryFileActions'
import type { LibraryFileDetail } from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

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
    size_bytes: 120,
    mtime: 1_756_000_000,
    content_hash: 'aaaaaaaa1111',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_755_000_000,
    updated_at: 1_756_000_000,
    content: '# hello',
    ...over
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

let actions: LibraryFileActions
const onSelectFile = vi.fn()

function renderPreview(ref: { id: number } | { attachmentId: number } = { id: 1 }): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <FilePreview
        fileRef={ref}
        actions={actions}
        onBack={vi.fn()}
        backLabel="my-docs"
        onSelectFile={onSelectFile}
        onChat={vi.fn()}
      />
    </QueryClientProvider>
  )
}

/** 动作条上的按钮名单（「Chat」恒在，不进断言噪音）。 */
function actionLabels(): string[] {
  return Array.from(document.querySelectorAll('header button')).map(
    (b) => b.textContent?.trim() ?? ''
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue({ folders: [], mounts: [], file_count: 0 })
  api.text.mockResolvedValue({
    file_id: 1,
    text_status: 'extracted',
    markdown: 'parsed body',
    extractor: 'anydoc',
    truncated: false,
    source_hash: 'aaaaaaaa1111',
    content_hash: 'aaaaaaaa1111',
    stale: false,
    hint: null
  })
})

afterEach(() => {
  cleanup()
})

describe('FilePreview 动作可见性', () => {
  test('库内 markdown：编辑 / 移动 / 删除 / 历史都在，没有「另存到资料库」', async () => {
    actions = stubActions()
    api.file.mockResolvedValue(detail({}))
    renderPreview()

    await screen.findByText('note.md')
    const labels = actionLabels()
    expect(labels).toContain('Edit')
    expect(labels).toContain('Reveal in Finder')
    expect(labels).toContain('Move to…')
    expect(labels).toContain('Delete')
    expect(labels).toContain('History')
    expect(labels).not.toContain('Save to Library')
  })

  test('投影行（id 为 null）：只剩另存 / 打开，没有编辑·移动·删除·历史·访达', async () => {
    actions = stubActions()
    api.attachment.mockResolvedValue(
      detail({
        id: null,
        is_projection: true,
        attachment_id: 9,
        kind: 'office',
        filename: '合同.docx',
        path: 'mail-attachments/2026-07/合同.docx',
        parent_path: 'mail-attachments/2026-07',
        source: 'mail',
        content: null
      })
    )
    api.attachmentText.mockResolvedValue({
      file_id: null,
      attachment_id: 9,
      text_status: 'extracted',
      markdown: 'contract text',
      extractor: 'anydoc',
      truncated: false,
      source_hash: null,
      content_hash: null,
      stale: false,
      hint: null
    })
    renderPreview({ attachmentId: 9 })

    await screen.findByText('合同.docx')
    const labels = actionLabels()
    expect(labels).toContain('Save to Library')
    expect(labels).not.toContain('Edit')
    expect(labels).not.toContain('Move to…')
    expect(labels).not.toContain('Delete')
    expect(labels).not.toContain('History')
    expect(labels).not.toContain('Reveal in Finder')
    // 端点选择只在 hooks 层做一次：投影行恒走 attachment 兄弟端点，不碰 /file/{id}。
    expect(api.file).not.toHaveBeenCalled()
    expect(api.attachment).toHaveBeenCalledWith(9)
  })

  test('非 markdown 且已解析：出「另存解析版为 markdown」，点了带原文（未剥 frontmatter）', async () => {
    actions = stubActions()
    const office = detail({ kind: 'office', filename: 'a.docx', content: null })
    api.file.mockResolvedValue(office)
    api.text.mockResolvedValue({
      file_id: 1,
      text_status: 'extracted',
      markdown: '---\ntitle: A\n---\n\nbody',
      extractor: 'anydoc',
      truncated: false,
      source_hash: 'aaaaaaaa1111',
      content_hash: 'aaaaaaaa1111',
      stale: false,
      hint: null
    })
    renderPreview()

    const button = await screen.findByRole('button', { name: 'Save parsed version as Markdown' })
    fireEvent.click(button)
    expect(actions.saveParsedMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      '---\ntitle: A\n---\n\nbody'
    )
  })
})

describe('FilePreview 状态面', () => {
  test('missing：横幅在，打开被禁用，解析文本仍然读得出来', async () => {
    actions = stubActions()
    api.file.mockResolvedValue(detail({ kind: 'office', status: 'missing', content: null }))
    renderPreview()

    // 头部徽标与横幅同文案：按 role=alert 定位横幅本身，才不是「徽标在就算过」。
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('File is no longer on disk')
    const open = screen.getByRole('button', { name: 'Open with system app' })
    expect((open as HTMLButtonElement).disabled).toBe(true)
    // missing 的解析文本还在索引里 —— 面不能空。
    expect(await screen.findByTestId('md')).toBeTruthy()
  })

  test('trashed：出恢复按钮，写动作（移动 / 删除）收掉', async () => {
    actions = stubActions()
    api.file.mockResolvedValue(detail({ status: 'trashed' }))
    renderPreview()

    const restore = await screen.findByRole('button', { name: 'Restore' })
    fireEvent.click(restore)
    expect(actions.restore).toHaveBeenCalledTimes(1)
    const labels = actionLabels()
    expect(labels).not.toContain('Move to…')
    expect(labels).not.toContain('Delete')
  })

  test.each([
    ['pending', 'Parsing…'],
    ['failed', 'Parsing failed'],
    ['unsupported', "Parsing isn't supported for this type yet"]
  ])('text_status = %s 出对应的面', async (status, expected) => {
    actions = stubActions()
    api.file.mockResolvedValue(detail({ kind: 'office', content: null }))
    api.text.mockResolvedValue({
      file_id: 1,
      text_status: status,
      markdown: null,
      extractor: null,
      truncated: false,
      source_hash: null,
      content_hash: 'aaaaaaaa1111',
      stale: false,
      // 🔴 hint 是自由文本、不是枚举：面必须由 text_status 决定，被它带偏就说明分支写错了。
      hint: '一句服务端自由文本'
    })
    renderPreview()

    expect(await screen.findByText(expected)).toBeTruthy()
    expect(screen.queryByText('一句服务端自由文本')).toBeNull()
  })
})

describe('FilePreview F1 / F2', () => {
  test('F1：只读面剥掉 YAML frontmatter，title 上到正文之上的元信息行', async () => {
    actions = stubActions()
    api.file.mockResolvedValue(
      detail({ content: '---\ntitle: 季度计划\ntags: [a, b]\n---\n\n正文第一行' })
    )
    renderPreview()

    const body = await screen.findByTestId('md')
    expect(body.textContent).toBe('正文第一行')
    expect(body.textContent).not.toContain('---')
    expect(body.textContent).not.toContain('title:')
    expect(screen.getByText('季度计划')).toBeTruthy()
    expect(screen.getByText('a')).toBeTruthy()
  })

  test('F2：派生文件顶部出「派生自 X」回链，点击选中原文件', async () => {
    actions = stubActions()
    api.file.mockImplementation(async (id: number) =>
      id === 7
        ? detail({ id: 7, filename: '服务协议.pdf', kind: 'pdf' })
        : detail({ id: 2, filename: '服务协议（解析版）.md', source: 'derived', source_ref: '7' })
    )
    renderPreview({ id: 2 })

    const chip = await screen.findByRole('button', { name: 'Derived from “服务协议.pdf”' })
    fireEvent.click(chip)
    expect(onSelectFile).toHaveBeenCalledWith({ id: 7 })
  })

  test('F2：非派生文件不渲回链', async () => {
    actions = stubActions()
    api.file.mockResolvedValue(detail({ source: 'user', source_ref: null }))
    renderPreview()

    await screen.findByText('note.md')
    await waitFor(() => expect(screen.queryByText(/Derived from/)).toBeNull())
  })
})
