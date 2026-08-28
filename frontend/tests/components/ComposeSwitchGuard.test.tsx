// @vitest-environment happy-dom
//
// EmailDetail 切邮件时的 compose 处置。
// 08-27 标签工作区 (Lane W) — overlay (reply/forward) 的 T6「钉住 + 弹确认」退役, 改为
// **现场快照进标签** (TabDescriptor.draft): 切邮件静默携带、切回自动重开并恢复编辑增量、
// 显式关闭清快照。draft 快照在场的标签 locked (不参与 LRU 自动淘汰)。
// dogfood 波3 — draft-edit (草稿点开即编辑, 非 store 驱动) 同入快照链, T9 钉住退役:
//   - 切换 = 快照静默携带 (无弹窗), 切回经 initialTabDraft 恢复;
//   - 关标签 = 关闭守卫 (requestCloseTab → EmailDetail 承接 → 面板 UnsavedChangesDialog)。
// 另含 404 轻量核销 (isSuccess 且 data===null → 收标签 + toast)。
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
import { useActiveEmail } from '../../src/shared/state/active-email'
import { MAIN_SLOT, useTabWorkspace } from '../../src/shared/state/tab-workspace'
import {
  _resetTabBridgeForTest,
  requestCloseTab,
  useTabCloseGuard
} from '../../src/shared/state/tab-workspace-bridge'
import { useToastStore, __resetToastStore } from '../../src/shared/state/toast'
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
  _resetTabBridgeForTest()
  __resetToastStore()
})

afterEach(() => {
  cleanup()
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT, closedStack: [] })
  _resetTabBridgeForTest()
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
    rerender(view(43))
    rerender(view(42))
    expect(useComposeStore.getState().open).toBe(false)
  })
})

describe('EmailDetail 切邮件 — draft-edit 现场快照进标签 (dogfood 波3, T9 钉住退役)', () => {
  // 草稿点开即编辑 = EmailDetail 的 mailbox 分支直接渲染 draft-edit 面板 (非 store 驱动)。
  // 波3: 切走不再钉住弹确认 —— 卸载兜底把现场写进 email:99 的标签快照, 切回恢复。
  function draft99Tab(): ReturnType<typeof useTabWorkspace.getState>['tabs'][number] | undefined {
    return useTabWorkspace.getState().tabs.find((t) => t.id === 'email:99')
  }

  async function renderDirtyDraft(): Promise<ReturnType<typeof render>> {
    useTabWorkspace.getState().openTab('email', 99, '草稿99')
    const r = render(view(99))
    // draft-edit 面板渲染 (to_addr 提纯成 chip → 预填完成 → dirty baseline 就位)
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
    // 编辑主题 → dirty (预填 setContent 不标脏, 用户改主题才标)
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '草稿99改了' } })
    return r
  }

  test('dirty → 切走: 无守卫弹窗, 快照落在 email:99 (mode=draft-edit + dirty), 标签锁定', async () => {
    const r = await renderDirtyDraft()
    // 第二次编辑：dirty 已置位不再触发 live 写 —— 这个值只有卸载兜底才能带走，
    // 断言它就是在钉「cleanup 捕获的是最新现场」，砍掉 cleanup 会红。
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '草稿99又改了' } })
    r.rerender(view(42))
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
    expect(screen.queryByText('未保存的更改')).toBeNull()
    const tab = draft99Tab()
    const snap = readComposeTabDraft(tab?.draft)
    expect(snap).not.toBeNull()
    expect(snap?.mode).toBe('draft-edit')
    expect(snap?.subject).toBe('草稿99又改了')
    expect(snap?.dirty).toBe(true)
    expect(tab?.locked).toBe(true)
  })

  test('dirty → 切走再切回: 面板经 initialTabDraft 恢复编辑增量', async () => {
    const r = await renderDirtyDraft()
    r.rerender(view(42))
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
    r.rerender(view(99))
    await waitFor(() =>
      expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('草稿99改了')
    )
    expect(mockDraft).not.toHaveBeenCalled()
  })

  test('clean → 切走: 不写快照 (干看不锁标签), 无守卫弹窗', async () => {
    useTabWorkspace.getState().openTab('email', 99, '草稿99')
    const { rerender } = render(view(99))
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    rerender(view(42))
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
    expect(screen.queryByText('未保存的更改')).toBeNull()
    const tab = draft99Tab()
    expect(tab?.draft).toBeUndefined()
    expect(tab?.locked).toBe(false)
    expect(mockDraft).not.toHaveBeenCalled()
  })
})

describe('删除 / 发送联动关标签 (dogfood 波3) — 对象消亡才收 tab', () => {
  test('删除草稿确认后 → 关闭 email:99 标签 (死 tab 不留)', async () => {
    useTabWorkspace.getState().openTab('email', 99, '草稿99')
    render(view(99))
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^删除$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^删除$/ }))
    await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith(99))
    await waitFor(() =>
      expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(false)
    )
  })

  test('发送成功后 (替换语义顺带删原稿) → 同样收标签', async () => {
    useTabWorkspace.getState().openTab('email', 99, '草稿99')
    render(view(99))
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(false)
    )
  })

  test('普通取消编辑 (ESC, clean) → 标签保留 (只有对象消亡才收)', async () => {
    useTabWorkspace.getState().openTab('email', 99, '草稿99')
    render(view(99))
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    // 测试里 internalId 是手动驱动的 prop（真实 app 里跟随投影翻 null → 面板卸载），
    // 这里以「本地选中被清、标签原样」为判据。
    await waitFor(() => expect(useActiveEmail.getState().activeInternalId).toBeNull())
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(true)
  })
})

describe('标签关闭守卫 (dogfood 波3) — requestCloseTab 对 dirty 草稿标签', () => {
  async function renderDirtyDraft99(): Promise<void> {
    useTabWorkspace.getState().openTab('email', 99, '草稿99')
    render(view(99))
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    // 编辑 → dirty → live 快照当场写进标签 (关闭守卫的判据位)
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '草稿99改了' } })
    await waitFor(() => expect(readComposeTabDraft(draft99())?.dirty).toBe(true))
  }
  function draft99(): Record<string, unknown> | undefined {
    return useTabWorkspace.getState().tabs.find((t) => t.id === 'email:99')?.draft
  }

  test('dirty 标签 → 请求关闭: 弹 UnsavedChangesDialog, 标签不直接关', async () => {
    await renderDirtyDraft99()
    act(() => {
      requestCloseTab('email:99')
    })
    expect(await screen.findByText('未保存的更改')).toBeTruthy()
    // 标签仍在 (先激活 + 弹框, 不是先摘标签)
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(true)
    expect(useTabWorkspace.getState().active).toBe('email:99')
    expect(useTabCloseGuard.getState().pending?.tabId).toBe('email:99')
  })

  test('守卫 → 保存草稿: email.draft 成功后关标签, 入最近关闭栈', async () => {
    await renderDirtyDraft99()
    act(() => {
      requestCloseTab('email:99')
    })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(false)
    )
    const stack = useTabWorkspace.getState().closedStack
    expect(stack[stack.length - 1]).toMatchObject({ kind: 'email', targetId: 99 })
    expect(useTabCloseGuard.getState().pending).toBeNull()
  })

  test('守卫 → 丢弃更改: 关标签, 未存草稿', async () => {
    await renderDirtyDraft99()
    act(() => {
      requestCloseTab('email:99')
    })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '丢弃更改' }))
    await waitFor(() =>
      expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(false)
    )
    expect(mockDraft).not.toHaveBeenCalled()
    expect(useTabCloseGuard.getState().pending).toBeNull()
  })

  test('守卫 → 继续编辑 (取消): 请求作废, 标签保留, 编辑增量仍在', async () => {
    await renderDirtyDraft99()
    act(() => {
      requestCloseTab('email:99')
    })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    await waitFor(() => expect(screen.queryByText('未保存的更改')).toBeNull())
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:99')).toBe(true)
    // 取消经 attemptClose 的 onAbort 收回请求 —— 不清会让后续 ⌘W 永久哑掉
    expect(useTabCloseGuard.getState().pending).toBeNull()
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('草稿99改了')
  })
})

describe('404 轻量核销 (dogfood 波3)', () => {
  test('详情 isSuccess 且 data=null (行确实不存在) → 收标签 + toast', async () => {
    mockGet.mockImplementation((id: number) =>
      Promise.resolve(id === 77 ? null : id === 99 ? DRAFT_99 : id === 43 ? EMAIL_43 : EMAIL_42)
    )
    useTabWorkspace.getState().openTab('email', 77, '已删邮件')
    render(view(77))
    await waitFor(() =>
      expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:77')).toBe(false)
    )
    expect(useToastStore.getState().items.some((i) => i.title.includes('已不存在'))).toBe(true)
  })

  test('dirty 草稿快照在场 → 不核销 (宁缺勿误杀: 收标签 = 丢未保存现场)', async () => {
    mockGet.mockImplementation((id: number) => Promise.resolve(id === 77 ? null : EMAIL_42))
    useTabWorkspace.getState().openTab('email', 77, '行没了但有现场')
    act(() => {
      useTabWorkspace
        .getState()
        .updateTab('email:77', { draft: { kind: 'compose', dirty: true }, locked: true })
    })
    render(view(77))
    // 错误壳渲染（data=null 落 !detailQ.data 分支），标签与快照原样保留
    await waitFor(() => expect(screen.getByText('Email not found.')).toBeTruthy())
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:77')).toBe(true)
    expect(useToastStore.getState().items).toHaveLength(0)
  })

  test('查询报错 (5xx/网络) → 维持错误壳, 不收标签 (宁缺勿误杀)', async () => {
    mockGet.mockImplementation((id: number) =>
      id === 77 ? Promise.reject(new Error('boom')) : Promise.resolve(EMAIL_42)
    )
    useTabWorkspace.getState().openTab('email', 77, '网络错')
    render(view(77))
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:77')).toBe(true)
    expect(useToastStore.getState().items).toHaveLength(0)
  })
})
