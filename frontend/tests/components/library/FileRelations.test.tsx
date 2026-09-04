// @vitest-environment happy-dom
//
// 预览面的关联行（dogfood 0903 owner 反馈第 2 件：「资料关联了其他事项/邮件，在哪里显示？」）。
//
// 这一面**不产生新数据**，只把已经存在的列与已经存在的端点画出来，所以判据也就是那四条：
//   · 投影行的邮件身份在行上（`internal_id`），不该再发一次查询；
//   · 「另存到资料库」之后的库内行只剩 `source_ref`（= 附件 id），要走既有的只读兄弟端点回补；
//   · `source='chat'` 的 `source_ref` 前半段是 session id，**空会话段没有落点**（新会话首条
//     消息发出时 session 还没持久化）—— 那种行不该画一枚点不动的 chip；
//   · 事项反查用 `library:{id}` 走既有的 `GET /matters/links/by-resource`；投影行没有
//     library id ⇒ 一条请求都不该发。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api, mattersApi, navigate } = vi.hoisted(() => ({
  api: { file: vi.fn(), attachment: vi.fn() },
  mattersApi: { lookupResourceLinks: vi.fn() },
  navigate: vi.fn()
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMattersEnabled: () => true
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import i18n from '@shared/i18n'
import type { LibraryFileDetail } from '@shared/api/types/library'
import { FileRelations } from '@shared/components/library/FileRelations'
import { useActiveEmail } from '@shared/state/active-email'

await i18n.changeLanguage('zh-CN')

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
    content: '',
    ...over
  }
}

function linkHit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    public_id: 'mt-77',
    title: '定价方案评审',
    status: 'active',
    health: 'ok',
    priority: 'normal',
    link_id: 3,
    resource_id: 9,
    pinned: true,
    sub_state: 'none',
    archived_at: null,
    available: true,
    ...over
  }
}

function renderRelations(file: LibraryFileDetail): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <FileRelations file={file} onSelectFile={vi.fn()} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.lookupResourceLinks.mockResolvedValue({ results: {} })
  useActiveEmail.setState({ activeInternalId: null, navTargetId: null })
})

afterEach(() => {
  cleanup()
})

describe('资料详情的关联行', () => {
  test('无来源、无事项 ⇒ 整行不渲染（不留一条空的分隔）', async () => {
    renderRelations(detail({}))
    await waitFor(() => expect(mattersApi.lookupResourceLinks).toHaveBeenCalled())
    expect(screen.queryByTestId('library-relations')).toBeNull()
  })

  test('投影行：邮件身份在行上，出「来源邮件」chip 且不再查一次附件', async () => {
    renderRelations(
      detail({
        id: null,
        is_projection: true,
        attachment_id: 9,
        internal_id: 501,
        subject: '2026 定价',
        sender_name: '王工',
        source: 'mail',
        source_ref: '9'
      })
    )
    const chip = await screen.findByTestId('library-relation-mail')
    expect(chip.textContent).toContain('2026 定价')
    expect(chip.textContent).toContain('王工')
    expect(api.attachment).not.toHaveBeenCalled()
  })

  test('🔴 投影行没有 library id ⇒ 一条事项反查请求都不发', async () => {
    renderRelations(detail({ id: null, is_projection: true, attachment_id: 9, internal_id: 501 }))
    await screen.findByTestId('library-relation-mail')
    expect(mattersApi.lookupResourceLinks).not.toHaveBeenCalled()
  })

  test('点「来源邮件」→ 邮件被设成 nav target（跳转走既有通道，不新造）', async () => {
    renderRelations(
      detail({ id: null, is_projection: true, attachment_id: 9, internal_id: 501, subject: 'S' })
    )
    fireEvent.click(await screen.findByTestId('library-relation-mail'))
    expect(useActiveEmail.getState().activeInternalId).toBe(501)
    expect(useActiveEmail.getState().navTargetId).toBe(501)
    expect(navigate).toHaveBeenCalled()
  })

  test('库内 source=mail 行：拿 source_ref 当附件 id 走只读兄弟端点回补邮件身份', async () => {
    api.attachment.mockResolvedValue(
      detail({
        id: null,
        is_projection: true,
        attachment_id: 42,
        internal_id: 777,
        subject: '合同'
      })
    )
    renderRelations(detail({ id: 5, source: 'mail', source_ref: '42' }))
    const chip = await screen.findByTestId('library-relation-mail')
    expect(api.attachment).toHaveBeenCalledWith(42)
    expect(chip.textContent).toContain('合同')
  })

  test('source=chat：session 段是正整数才画 chip', async () => {
    renderRelations(detail({ id: 5, source: 'chat', source_ref: '77:msg-abc' }))
    expect(await screen.findByTestId('library-relation-chat')).toBeTruthy()
  })

  test('🔴 source=chat 但 session 段是空的（新会话首条消息）⇒ 不画点不动的 chip', async () => {
    renderRelations(detail({ id: 5, source: 'chat', source_ref: ':msg-abc' }))
    await waitFor(() => expect(mattersApi.lookupResourceLinks).toHaveBeenCalled())
    expect(screen.queryByTestId('library-relation-chat')).toBeNull()
  })

  test('事项反查：按 library:{id} 反查并逐件画 chip', async () => {
    mattersApi.lookupResourceLinks.mockResolvedValue({
      results: { 'library:5': [linkHit(), linkHit({ public_id: 'mt-78', title: '续约' })] }
    })
    renderRelations(detail({ id: 5 }))
    const chips = await screen.findAllByTestId('library-relation-matter')
    expect(mattersApi.lookupResourceLinks).toHaveBeenCalledWith('mailagent', ['library:5'])
    expect(chips.map((c) => c.textContent)).toEqual(['定价方案评审', '续约'])
  })
})
