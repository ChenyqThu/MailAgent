// @vitest-environment happy-dom
//
// EmailDetail 切邮件时的 compose 处置。
// 08-27 标签工作区 (Lane W) — overlay (reply/forward) 的 T6「钉住 + 弹确认」退役, 改为
// **现场快照进标签** (TabDescriptor.draft): 切邮件静默携带、切回自动重开并恢复编辑增量、
// 显式关闭清快照。draft 快照在场的标签 locked (不参与 LRU 自动淘汰)。
// T9 拦截点 — draft-edit (草稿点开即编辑, 非 store 驱动) 切邮件守卫维持不变:
//   - draft-edit dirty → 切走: 钉住原草稿 + 弹守卫; 保存/丢弃放行, 取消留守。
//   - draft-edit clean → 切走: 直接放行到新邮件 (原行为)。
// 详情列子组件非本用例关注点 → stub, 只保留 compose 面板。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const {
  mockGet,
  mockAiFields,
  mockGetCached,
  mockAbortTranslate,
  mockDraftPlan,
  mockDraft,
  mockSend,
  mockBody,
  mockDeleteDraft,
  mockSettingsGet
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockAiFields: vi.fn(),
  mockGetCached: vi.fn(),
  mockAbortTranslate: vi.fn(),
  mockDraftPlan: vi.fn(),
  mockDraft: vi.fn(),
  mockSend: vi.fn(),
  mockBody: vi.fn(),
  mockDeleteDraft: vi.fn(),
  mockSettingsGet: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      get: mockGet,
      aiFields: mockAiFields,
      draftPlan: mockDraftPlan,
      draft: mockDraft,
      send: mockSend,
      body: mockBody,
      deleteDraft: mockDeleteDraft
    },
    ai: {
      getCached: mockGetCached,
      abortTranslate: mockAbortTranslate,
      translateBatch: vi.fn(),
      deleteCached: vi.fn()
    },
    settings: { get: mockSettingsGet }
  })
}))

vi.mock('../../src/shared/components/email/EmailToolbar', () => ({ EmailToolbar: () => null }))
vi.mock('../../src/shared/components/email/AttachmentList', () => ({ AttachmentList: () => null }))
vi.mock('../../src/shared/components/email/ThreadAttachmentBar', () => ({
  ThreadAttachmentBar: () => null
}))
vi.mock('../../src/shared/components/ai/AIFieldsBlock', () => ({ AIFieldsBlock: () => null }))
vi.mock('../../src/shared/components/calendar/MeetingInviteCard', () => ({
  MeetingInviteCard: () => null
}))
vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({ EmailBodyFrame: () => null }))

import i18n from '@shared/i18n'
import { EmailDetail } from '../../src/shared/components/email/EmailDetail'
import { useComposeStore } from '../../src/shared/state/compose'
import { MAIN_SLOT, useTabWorkspace } from '../../src/shared/state/tab-workspace'
import { readComposeTabDraft } from '../../src/shared/components/email/compose/composeTabDraft'

await i18n.changeLanguage('zh-CN')

const EMAIL_42 = {
  internal_id: 42,
  subject: '邮件42',
  sender: 'a@x.com',
  sender_name: 'A',
  mailbox: '收件箱',
  date: '2026-07-15T00:00:00Z',
  is_read: true,
  is_flagged: false,
  is_important: false,
  attachments: []
}
const EMAIL_43 = { ...EMAIL_42, internal_id: 43, subject: '邮件43' }
// 草稿 (mailbox='草稿箱') — EmailDetail 直接渲染 ComposePanelInner mode='draft-edit'。
const DRAFT_99 = {
  internal_id: 99,
  subject: '草稿99',
  sender: 'me@acme.com',
  sender_name: '',
  to_addr: '"bob@acme.com" <bob@acme.com>',
  cc_addr: '',
  mailbox: '草稿箱',
  date: '2026-07-15T00:00:00Z',
  is_read: true,
  is_flagged: false,
  is_important: false,
  attachments: []
}
const PLAN = {
  internal_id: 42,
  mode: 'reply' as const,
  to: ['alice@acme.com'],
  cc: [],
  bcc: [],
  subject: 'Re: 邮件42',
  reply_html: '<p>hi</p>',
  forward_intro_html: '',
  attachments: 0,
  warnings: []
}

let qc: QueryClient
function view(id: number): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <EmailDetail internalId={id} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  mockGet.mockImplementation((id: number) =>
    Promise.resolve(id === 99 ? DRAFT_99 : id === 43 ? EMAIL_43 : EMAIL_42)
  )
  mockAiFields.mockResolvedValue(null)
  mockGetCached.mockResolvedValue(null)
  mockDraftPlan.mockResolvedValue(PLAN)
  mockDraft.mockResolvedValue({ success: true })
  mockSend.mockResolvedValue({ sent: true })
  mockBody.mockResolvedValue({ content: '<p>草稿正文</p>', format: 'html' })
  mockDeleteDraft.mockResolvedValue({ success: true })
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
  // 08-27 标签工作区：overlay 的切邮件语义改为「现场快照进标签」——两封邮件先开成标签
  //（快照写在 TabDescriptor.draft 上，没有标签就没有落点）。模块级 store 跨用例存活，复位。
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT, closedStack: [] })
  useTabWorkspace.getState().openTab('email', 42, '邮件42')
  useTabWorkspace.getState().openTab('email', 43, '邮件43')
})

afterEach(() => {
  cleanup()
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT, closedStack: [] })
})

describe('EmailDetail 切邮件 — overlay compose 现场快照进标签 (08-27 标签工作区, 替代 T6 弹确认)', () => {
  test('overlay dirty → 切邮件: 不弹守卫, 现场快照写进原标签 draft, store 关闭', async () => {
    const { rerender } = render(view(42))
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    // 编辑主题 → dirty
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '改了主题' } })
    // 切到邮件 43 —— 静默携带: 无守卫弹窗, 快照落在 email:42 的描述符上
    rerender(view(43))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(false))
    expect(screen.queryByText('未保存的更改')).toBeNull()
    const tab42 = useTabWorkspace.getState().tabs.find((t) => t.id === 'email:42')
    const snap = readComposeTabDraft(tab42?.draft)
    expect(snap).not.toBeNull()
    expect(snap?.mode).toBe('reply')
    expect(snap?.subject).toBe('改了主题')
    expect(snap?.dirty).toBe(true)
    // 带着 draft 快照的标签锁定 (不参与 LRU 自动淘汰)
    expect(tab42?.locked).toBe(true)
  })

  test('overlay dirty → 切走再切回: compose 自动重开, 编辑增量恢复', async () => {
    const { rerender } = render(view(42))
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '改了主题' } })
    rerender(view(43))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(false))
    // 切回 42：快照在 → 自动重开 + 主题恢复
    rerender(view(42))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(true))
    expect(useComposeStore.getState().internalId).toBe(42)
    await waitFor(() =>
      expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('改了主题')
    )
  })

  test('overlay clean → 切邮件: store 关闭但快照仍携带 (切回 compose 仍开)', async () => {
    const { rerender } = render(view(42))
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    // 不编辑 → clean → 切邮件
    rerender(view(43))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(false))
    expect(screen.queryByText('未保存的更改')).toBeNull()
    // clean 快照: bodyHtml null (没动过正文 → 恢复时保留 plan 建议正文), dirty false
    const snap = readComposeTabDraft(
      useTabWorkspace.getState().tabs.find((t) => t.id === 'email:42')?.draft
    )
    expect(snap).not.toBeNull()
    expect(snap?.bodyHtml).toBeNull()
    expect(snap?.dirty).toBe(false)
  })

  test('显式丢弃 (自己标签上关闭) → 已携带的快照清除, 切回不再重开', async () => {
    const { rerender } = render(view(42))
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '改了主题' } })
    // 先切走让快照真实落盘, 再切回恢复现场 —— 这样下面的「清除」断言才不是恒真。
    rerender(view(43))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(false))
    expect(
      readComposeTabDraft(useTabWorkspace.getState().tabs.find((t) => t.id === 'email:42')?.draft)
    ).not.toBeNull()
    rerender(view(42))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(true))
    // 显式关闭 (= 守卫放行后的 proceed 路径): 在**自己的标签上** open 翻 false → 快照清除
    act(() => useComposeStore.getState().closeCompose())
    await waitFor(() =>
      expect(
        readComposeTabDraft(useTabWorkspace.getState().tabs.find((t) => t.id === 'email:42')?.draft)
      ).toBeNull()
    )
    // 切走再切回: 无快照 → 不自动重开
    rerender(view(43))
    rerender(view(42))
    expect(useComposeStore.getState().open).toBe(false)
  })
})

describe('EmailDetail 切邮件 — draft-edit 离开守卫 (T9 拦截点补口)', () => {
  // 草稿点开即编辑 = EmailDetail 的 mailbox 分支直接渲染 draft-edit 面板 (非 store 驱动)。
  // 编辑后切走原本直接 unmount 丢字节 —— T9 补上同 T6 的钉住 + 守卫。
  async function renderDirtyDraftThenSwitch(): Promise<ReturnType<typeof render>> {
    const r = render(view(99))
    // draft-edit 面板渲染 (to_addr 提纯成 chip → 预填完成 → dirty baseline 就位)
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
    // 编辑主题 → dirty (预填 setContent 不标脏, 用户改主题才标)
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '草稿99改了' } })
    // 切到普通邮件 42
    r.rerender(view(42))
    return r
  }

  test('draft-edit dirty → 切走: 弹守卫 + 原 draft-edit 保持渲染 (钉住草稿 99)', async () => {
    await renderDirtyDraftThenSwitch()
    // 守卫弹窗出现 (没有静默 unmount 丢草稿)
    expect(await screen.findByText('未保存的更改')).toBeTruthy()
    // draft-edit 面板仍挂载 (钉住), 主题保留改后的值 (同一实例, 编辑增量不丢)
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('草稿99改了')
  })

  test('draft-edit dirty → 保存草稿: 存草稿后放行, 面板卸载到新邮件', async () => {
    await renderDirtyDraftThenSwitch()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存草稿' }))
    // 存草稿 (email.draft) 成功后放行 → 被钉草稿面板卸载, 普通邮件详情渲染
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
  })

  test('draft-edit dirty → 丢弃更改: 直接放行, 面板卸载 + 未存草稿', async () => {
    await renderDirtyDraftThenSwitch()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃更改' }))
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
    expect(mockDraft).not.toHaveBeenCalled()
  })

  test('draft-edit dirty → 取消: 弹窗关闭 + 面板留守 (草稿 99 继续编辑)', async () => {
    await renderDirtyDraftThenSwitch()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    // 弹窗关闭, 但 draft-edit 面板留守 (钉住未放行), 编辑增量仍在
    await waitFor(() => expect(screen.queryByText('未保存的更改')).toBeNull())
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('草稿99改了')
  })

  test('draft-edit clean → 切走: 无守卫弹窗, 直接放行到新邮件', async () => {
    const { rerender } = render(view(99))
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    // 不编辑 → clean → 切邮件 42
    rerender(view(42))
    // 直接放行: draft-edit 面板卸载, 无守卫弹窗
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
    expect(screen.queryByText('未保存的更改')).toBeNull()
    expect(mockDraft).not.toHaveBeenCalled()
  })
})
