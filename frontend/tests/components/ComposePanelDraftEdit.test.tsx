// @vitest-environment happy-dom
//
// 草稿编辑态 (draft-edit) + 重要性 — ComposePanelInner mode='draft-edit':
//   - 回填走 email.get (to/cc/subject/is_important) + email.body(html) (正文), 不调 draftPlan。
//   - 发送 = email.send(mode='new', importance) → 成功后 email.deleteDraft (替换语义)。
//   - 放弃 = email.deleteDraft。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const {
  mockDraftPlan,
  mockDraft,
  mockSend,
  mockDeleteDraft,
  mockSettingsGet,
  mockEmailGet,
  mockEmailBody
} = vi.hoisted(() => ({
  mockDraftPlan: vi.fn(),
  mockDraft: vi.fn(),
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
      draft: mockDraft,
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
  mockDraft.mockResolvedValue({ success: true, mirror_internal_id: null })
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

  test('发送 → email.send(mode=new, importance=high) → deleteDraft 后台执行不阻塞关闭', async () => {
    // task 08-20: 删草稿 IMAP 慢链 (2.5-5.4s) 曾把发送反馈拖到 ~11.5s —— 现在
    // 发送成功即关面板, deleteDraft 后台跑。用 pending promise 断言顺序。
    let resolveDelete!: (v: unknown) => void
    mockDeleteDraft.mockImplementation(() => new Promise((r) => (resolveDelete = r)))
    const onClose = vi.fn()
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const arg = mockSend.mock.calls[0][0]
    // wire mode = 'new' (零线程派生); is_important=true → importance='high'
    expect(arg).toMatchObject({ internalId: 99, mode: 'new', importance: 'high' })
    // D1 Bug A — draft-edit 发送带草稿行自己的 id, 服务端据此恢复回复线程 linkage。
    expect(arg.sourceDraftId).toBe(99)
    expect(arg.to).toEqual(['chenyq.thu@gmail.com'])
    // 发送成功后删原草稿 (替换语义); deleteDraft 还 pending, 面板已关 (不再 await)
    await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith(99))
    expect(onClose).toHaveBeenCalled()
    await act(async () => resolveDelete({ success: true }))
  })

  test('删除 → 二次确认弹窗 → 确认后 deleteDraft + 面板即关 (乐观, 不等 IMAP 慢链)', async () => {
    let resolveDelete!: (v: unknown) => void
    mockDeleteDraft.mockImplementation(() => new Promise((r) => (resolveDelete = r)))
    const onClose = vi.fn()
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    // 点顶部「删除」→ 不立即删, 先弹二次确认 (草稿删除不可逆)
    fireEvent.click(screen.getByRole('button', { name: /^删除$/ }))
    expect(mockDeleteDraft).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('删除草稿？')).toBeTruthy()
    // 弹窗内确认 → deleteDraft 发起; task 08-20 乐观删除: 请求还 pending 面板已关
    fireEvent.click(within(dialog).getByRole('button', { name: /^删除$/ }))
    await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith(99))
    expect(onClose).toHaveBeenCalled()
    await act(async () => resolveDelete({ success: true }))
  })
})

describe('ComposePanel — D2 marker 拆分回填 (draft-edit)', () => {
  const MARKER_BODY =
    '<p>回复段REPLY</p>' +
    '<div data-ma-quote="1"><p>在 2026年7月8日写道：</p><blockquote>引用段QUOTE</blockquote></div>'

  test('有 marker → 回复段进编辑器, 引用段进折叠引用区, 发送拼回且 marker 保留', async () => {
    mockEmailBody.mockResolvedValue({ content: MARKER_BODY, format: 'html' })
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    // 折叠引用区出现 (拆分回填标签「引用原文」, 非保真「原文」+ hint)
    expect(screen.getByText('引用原文')).toBeTruthy()
    expect(screen.queryByText(/保真保留/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const body = mockSend.mock.calls[0][0].bodyHtml as string
    expect(body).toContain('回复段REPLY') // 编辑器段
    expect(body).toContain('引用段QUOTE') // 引用区拼回
    expect(body).toContain('data-ma-quote') // 🔴 marker 经 sanitize 拼回后保留
    // 引用段只此一份 (没有同时灌进编辑器)
    expect(body.indexOf('引用段QUOTE')).toBe(body.lastIndexOf('引用段QUOTE'))
  })

  test('marker + 回复段是 preserve-only 布局表 → 整块保真, 编辑器留空, 零丢字节', async () => {
    mockEmailBody.mockResolvedValue({
      content: `<table role="presentation"><tr><td>表格回复段TBL</td></tr></table>${'<div data-ma-quote="1"><blockquote>引用段QX</blockquote></div>'}`,
      format: 'html'
    })
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    // 走保真通路: 「原文」标签 + hint
    expect(screen.getByText('原文')).toBeTruthy()
    expect(screen.getByText(/保真保留/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const body = mockSend.mock.calls[0][0].bodyHtml as string
    expect(body).toContain('表格回复段TBL')
    expect(body).toContain('引用段QX')
    expect(body.indexOf('引用段QX')).toBe(body.lastIndexOf('引用段QX'))
  })
})

describe('ComposePanel — D5 富文本混合门 (draft-edit)', () => {
  test('标准 table → 进入编辑器, 发送时序列化为 Outlook 兼容 HTML', async () => {
    mockEmailBody.mockResolvedValue({
      content: '<table><tr><td>季度数据QX</td></tr></table>',
      format: 'html'
    })
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    expect(screen.getByText('季度数据QX')).toBeTruthy()
    expect(screen.queryByText('原文')).toBeNull()
    expect(screen.queryByText(/保真保留/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const body = mockSend.mock.calls[0][0].bodyHtml as string
    expect(body).toContain('季度数据QX')
    expect(body).toContain('<table')
    expect(body).toContain('border="1"')
    expect(body).toContain('cellpadding="0"')
    expect(body.indexOf('季度数据QX')).toBe(body.lastIndexOf('季度数据QX'))
  })

  test('html 为空 → markdown 回落 (plaintext 降级灌编辑器)', async () => {
    mockEmailBody.mockImplementation((_id: number, opts?: { format?: string }) =>
      Promise.resolve(
        opts?.format === 'markdown'
          ? { content: '纯文本草稿内容MD', format: 'markdown' }
          : { content: null, format: 'html' }
      )
    )
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    expect(mockEmailBody).toHaveBeenCalledWith(99, { format: 'markdown' })
    // markdown 内容进了编辑器 → 发送正文里有
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].bodyHtml as string).toContain('纯文本草稿内容MD')
  })

  test('草稿已有附件 → attachment_id 引用 chips + send payload 带 refs (inline 走隐藏保真集, derived 不算)', async () => {
    mockEmailGet.mockResolvedValue({
      ...DRAFT,
      attachments: [
        { id: 7, filename: 'plan.xlsx', size_bytes: 2048, is_inline: false, derived_from: null },
        { id: 8, filename: 'logo.png', size_bytes: 100, is_inline: true, derived_from: null },
        { id: 9, filename: 'plan.csv', size_bytes: 50, is_inline: false, derived_from: 7 }
      ]
    })
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('plan.xlsx')).toBeTruthy())
    // inline (正文图) / derived (office 预转) 不生成 chip
    expect(screen.queryByText('logo.png')).toBeNull()
    expect(screen.queryByText('plan.csv')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    // task 08-20 D2: inline 部件 (id 8) 随隐藏保真集进 refs — 不进 tray 但必须过线,
    // 否则替换保存的 EML 有 cid 引用无 part; derived (id 9) 仍排除。
    expect(mockSend.mock.calls[0][0].attachments).toEqual([
      { attachment_id: 7 },
      { attachment_id: 8 }
    ])
  })
})

describe('ComposePanel — 保存按钮 + C-1 replace 锚 (task 08-20 draft-save)', () => {
  test('draft-edit 显示保存按钮, 存后不关闭, payload 带 sourceDraftId + 显式 attachments 键', async () => {
    const onClose = vi.fn()
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^保存草稿$/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    const arg = mockDraft.mock.calls[0][0]
    expect(arg).toMatchObject({ internalId: 99, mode: 'new', sourceDraftId: 99 })
    // D3 — draft-edit 恒发显式 attachments 键 (含空数组): 键省略时服务端无从区分
    // 「没有附件」与「客户端漏传」。
    expect(arg.attachments).toEqual([])
    // 存后留在编辑态 (新建 compose 才存后关闭)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('保存成功后 sourceDraftId/附件引用 换到镜像新行 (第二次保存替换锚不失效)', async () => {
    mockEmailGet.mockResolvedValue({
      ...DRAFT,
      attachments: [
        { id: 7, filename: 'plan.xlsx', size_bytes: 2048, is_inline: false, derived_from: null },
        { id: 8, filename: 'logo.png', size_bytes: 100, is_inline: true, derived_from: null }
      ]
    })
    mockDraft.mockResolvedValue({
      success: true,
      mirror_internal_id: 1000000123,
      mirror_attachment_ids: { 'plan.xlsx': 501, 'logo.png': 502 },
      replaced_source_draft_id: 99
    })
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('plan.xlsx')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^保存草稿$/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    expect(mockDraft.mock.calls[0][0]).toMatchObject({ internalId: 99, sourceDraftId: 99 })
    expect(mockDraft.mock.calls[0][0].attachments).toEqual([
      { attachment_id: 7 },
      { attachment_id: 8 }
    ])

    // 第二次保存: 锚 + 附件引用全部指向镜像新行 (旧行 99 已被 replace 删掉)
    fireEvent.click(screen.getByRole('button', { name: /^保存草稿$/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(2))
    const second = mockDraft.mock.calls[1][0]
    expect(second).toMatchObject({ internalId: 1000000123, sourceDraftId: 1000000123 })
    expect(second.attachments).toEqual([{ attachment_id: 501 }, { attachment_id: 502 }])
  })

  test('守卫与按钮双入口单飞: 保存 in-flight 时守卫「保存草稿」不发第二次 APPEND', async () => {
    let resolveDraft!: (v: unknown) => void
    mockDraft.mockImplementation(() => new Promise((r) => (resolveDraft = r)))
    const onClose = vi.fn()
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('chenyq.thu@gmail.com')).toBeTruthy())
    // 改主题标脏 → ESC 会弹离开守卫
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '改过的主题' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存草稿$/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    // in-flight 中经 ESC 走离开守卫 → 弹未保存确认
    fireEvent.keyDown(window, { key: 'Escape' })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^保存草稿$/ }))
    // 单飞: 复用同一 in-flight promise, 不发第二次 APPEND
    expect(mockDraft).toHaveBeenCalledTimes(1)
    await act(async () => resolveDraft({ success: true, mirror_internal_id: null }))
    // 守卫续跑 proceed (ESC 的 proceed = onClose)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockDraft).toHaveBeenCalledTimes(1)
  })
})
