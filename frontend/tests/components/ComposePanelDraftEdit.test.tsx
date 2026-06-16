// @vitest-environment happy-dom
//
// 草稿编辑态 (draft-edit) + 重要性 — ComposePanelInner mode='draft-edit':
//   - 回填走 email.get (to/cc/subject/is_important) + email.body(html) (正文), 不调 draftPlan。
//   - 发送 = email.send(mode='new', importance) → 成功后 email.deleteDraft (替换语义)。
//   - 放弃 = email.deleteDraft。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockDraftPlan, mockSend, mockDeleteDraft, mockSettingsGet, mockEmailGet, mockEmailBody } =
  vi.hoisted(() => ({
    mockDraftPlan: vi.fn(),
    mockSend: vi.fn(),
    mockDeleteDraft: vi.fn(),
    mockSettingsGet: vi.fn(),
    mockEmailGet: vi.fn(),
    mockEmailBody: vi.fn()
  }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      draftPlan: mockDraftPlan,
      send: mockSend,
      deleteDraft: mockDeleteDraft,
      get: mockEmailGet,
      body: mockEmailBody
    },
    settings: { get: mockSettingsGet }
  })
}))

vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({
  EmailBodyFrame: () => null
}))

import i18n from '@shared/i18n'
import { ComposePanelInner } from '../../src/shared/components/email/compose/ComposePanel'

await i18n.changeLanguage('zh-CN')

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const DRAFT = {
  internal_id: 99,
  subject: 'Network Intel · 周报',
  sender: 'me@acme.com',
  to_addr: '"chenyq.thu@gmail.com" <chenyq.thu@gmail.com>',
  cc_addr: '',
  mailbox: '草稿箱',
  is_important: true,
  attachments: []
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockEmailGet.mockResolvedValue(DRAFT)
  mockEmailBody.mockResolvedValue({ content: '<p>草稿正文ABC</p>', format: 'html' })
  mockSend.mockResolvedValue({ sent: true })
  mockDeleteDraft.mockResolvedValue({ success: true })
})

afterEach(() => cleanup())

describe('ComposePanel — 草稿编辑态 (draft-edit)', () => {
  test('回填走 email.get + email.body, 不调 draftPlan', async () => {
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    // to 从 to_addr 提纯成 chip
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    // subject 从 email.get 回填
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('Network Intel · 周报')
    // draftPlan 完全不调用 (草稿态不走 reply 推导)
    expect(mockDraftPlan).not.toHaveBeenCalled()
    expect(mockEmailBody).toHaveBeenCalledWith(99, { format: 'html' })
  })

  test('发送 → email.send(mode=new, importance=high) → 成功后 deleteDraft', async () => {
    const onClose = vi.fn()
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const arg = mockSend.mock.calls[0][0]
    // wire mode = 'new' (零线程派生); is_important=true → importance='high'
    expect(arg).toMatchObject({ internalId: 99, mode: 'new', importance: 'high' })
    expect(arg.to).toEqual(['chenyq.thu@gmail.com'])
    // 发送成功后删原草稿 (替换语义) + 关闭
    await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith(99))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('删除 → 二次确认弹窗 → 确认后才 deleteDraft (草稿改 DB 需确认)', async () => {
    const onClose = vi.fn()
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    // 点顶部「删除」→ 不立即删, 先弹二次确认 (草稿删除不可逆)
    fireEvent.click(screen.getByRole('button', { name: /^删除$/ }))
    expect(mockDeleteDraft).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除草稿？')).toBeTruthy()
    // 弹窗内确认 → deleteDraft
    fireEvent.click(within(dialog).getByRole('button', { name: /^删除$/ }))
    await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith(99))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
