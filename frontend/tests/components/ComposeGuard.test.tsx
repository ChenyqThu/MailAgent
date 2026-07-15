// @vitest-environment happy-dom
//
// T6 Bug C — compose 离开守卫 (dirty 跟踪 + UnsavedChangesDialog)。
//   - 预填/回填绝不标脏 (reply plan + draft-edit body 两例) → 未编辑即关闭无弹窗。
//   - 编辑字段后标脏 → 关闭 (丢弃/ESC) 弹三键确认。
//   - 三键: 取消 (留守) / 丢弃 (关闭不存) / 保存草稿 (存后关闭; 失败留守)。
//   - 发送成功不弹守卫。
//   - useComposeGuard 状态机 (含保存失败留守) 单测。
//   - 新邮件浮窗 scrim/× 经守卫桥关闭 (dirty 弹, clean 直接关)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockDraftPlan, mockDraft, mockSend, mockSettingsGet, mockEmailGet, mockEmailBody } =
  vi.hoisted(() => ({
    mockDraftPlan: vi.fn(),
    mockDraft: vi.fn(),
    mockSend: vi.fn(),
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
import {
  ComposePanel,
  ComposePanelInner
} from '../../src/shared/components/email/compose/ComposePanel'
import { ComposeNewModal } from '../../src/shared/components/email/compose/ComposeNewModal'
import { useComposeStore } from '../../src/shared/state/compose'
import { useComposeNewStore } from '../../src/shared/state/compose-new'
import { useComposeGuard } from '../../src/shared/components/email/compose/useComposeGuard'

await i18n.changeLanguage('zh-CN')

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const PLAN = {
  internal_id: 42,
  mode: 'reply' as const,
  to: ['alice@acme.com'],
  cc: [],
  bcc: [],
  subject: 'Re: 合同审阅',
  reply_html: '<p>你好</p>',
  forward_intro_html: '',
  attachments: 0,
  warnings: []
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDraftPlan.mockResolvedValue(PLAN)
  mockDraft.mockResolvedValue({ success: true })
  mockSend.mockResolvedValue({ sent: true })
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockEmailGet.mockResolvedValue({ internal_id: 42, attachments: [] })
  mockEmailBody.mockResolvedValue({ content: '<p>草稿正文</p>', format: 'html' })
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
})

afterEach(() => cleanup())

// 打开 reply overlay + 等预填落地 (subject chip 出现)。
async function openReply(): Promise<void> {
  act(() => useComposeStore.getState().openCompose(42, 'reply'))
  renderWithClient(<ComposePanel />)
  await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
}

// 改主题 = 一个可靠的「用户编辑」信号 (纯 input, 不依赖 TipTap 在 happy-dom 的行为)。
function editSubject(value: string): void {
  fireEvent.change(screen.getByLabelText('主题'), { target: { value } })
}

describe('ComposePanel 离开守卫 — 预填不标脏', () => {
  test('reply 预填后未编辑 → 丢弃直接关闭, 无未保存弹窗 (旧坑回归守护)', async () => {
    await openReply()
    fireEvent.click(screen.getByRole('button', { name: /^丢弃$/ }))
    // dirty=false → 直接 proceed, 不弹 UnsavedChangesDialog。
    expect(screen.queryByText('未保存的更改')).toBeNull()
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
  })

  test('draft-edit 回填后未编辑 → ESC 直接关闭, 无未保存弹窗', async () => {
    const onClose = vi.fn()
    mockEmailGet.mockResolvedValue({
      internal_id: 99,
      subject: '周报草稿',
      to_addr: '"bob@acme.com" <bob@acme.com>',
      cc_addr: '',
      mailbox: '草稿箱',
      is_important: false,
      attachments: []
    })
    renderWithClient(<ComposePanelInner internalId={99} mode="draft-edit" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('未保存的更改')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ComposePanel 离开守卫 — 编辑后三键', () => {
  test('编辑主题 → 丢弃弹 UnsavedChangesDialog', async () => {
    await openReply()
    editSubject('Re: 合同审阅 (改)')
    fireEvent.click(screen.getByRole('button', { name: /^丢弃$/ }))
    expect(await screen.findByText('未保存的更改')).toBeTruthy()
    // 面板仍在 (未关闭)
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
  })

  test('取消 (继续编辑) → 弹窗关, composer 留守', async () => {
    await openReply()
    editSubject('改了')
    fireEvent.click(screen.getByRole('button', { name: /^丢弃$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /继续编辑/ }))
    await waitFor(() => expect(screen.queryByText('未保存的更改')).toBeNull())
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
    expect(mockDraft).not.toHaveBeenCalled()
  })

  test('丢弃更改 → composer 关闭, 不保存草稿', async () => {
    await openReply()
    editSubject('改了')
    fireEvent.click(screen.getByRole('button', { name: /^丢弃$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /丢弃更改/ }))
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
    expect(mockDraft).not.toHaveBeenCalled()
  })

  test('保存草稿 → email.draft 调用, 成功后关闭', async () => {
    await openReply()
    editSubject('改了主题XYZ')
    fireEvent.click(screen.getByRole('button', { name: /^丢弃$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /保存草稿/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    // 存的正是编辑后的主题
    expect(mockDraft.mock.calls[0][0].subject).toBe('改了主题XYZ')
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
  })

  test('保存草稿失败 → composer 留守 (未关闭), 弹窗关', async () => {
    mockDraft.mockRejectedValue(Object.assign(new Error('boom'), { code: 'E_AUTH' }))
    await openReply()
    editSubject('改了')
    fireEvent.click(screen.getByRole('button', { name: /^丢弃$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /保存草稿/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    // 失败: 守卫弹窗关闭, 但 composer 仍在 (用户可重试)。
    await waitFor(() => expect(screen.queryByText('未保存的更改')).toBeNull())
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
  })
})

describe('ComposePanel 离开守卫 — ESC / 发送', () => {
  test('ESC dirty → 弹守卫 (不直接关)', async () => {
    await openReply()
    editSubject('改了')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByText('未保存的更改')).toBeTruthy()
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
  })

  test('发送成功 → 不弹未保存弹窗 (发送不是丢弃)', async () => {
    await openReply()
    editSubject('改了')
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('未保存的更改')).toBeNull()
    await waitFor(() => expect(document.querySelector('[aria-label="compose-panel"]')).toBeNull())
  })
})

describe('useComposeGuard — 状态机', () => {
  test('clean → guardClose 直接 proceed, 不开弹窗', () => {
    const proceed = vi.fn()
    const saveDraft = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useComposeGuard({ dirty: false, saveDraft }))
    act(() => result.current.guardClose(proceed))
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(result.current.unsavedOpen).toBe(false)
  })

  test('dirty → guardClose 开弹窗; 丢弃 proceed; 取消不 proceed', () => {
    const proceed = vi.fn()
    const saveDraft = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) => useComposeGuard({ dirty, saveDraft }),
      { initialProps: { dirty: true } }
    )
    act(() => result.current.guardClose(proceed))
    expect(result.current.unsavedOpen).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
    // 取消 → 不 proceed, 弹窗关
    act(() => result.current.onCancel())
    expect(result.current.unsavedOpen).toBe(false)
    expect(proceed).not.toHaveBeenCalled()
    // 再来一次 → 丢弃 → proceed
    rerender({ dirty: true })
    act(() => result.current.guardClose(proceed))
    act(() => result.current.onDiscard())
    expect(proceed).toHaveBeenCalledTimes(1)
  })

  test('保存成功 → proceed; 保存失败 → 不 proceed (留守)', async () => {
    const okProceed = vi.fn()
    const okSave = vi.fn().mockResolvedValue(undefined)
    const ok = renderHook(() => useComposeGuard({ dirty: true, saveDraft: okSave }))
    act(() => ok.result.current.guardClose(okProceed))
    await act(async () => {
      ok.result.current.onSaveDraft()
    })
    await waitFor(() => expect(okProceed).toHaveBeenCalledTimes(1))

    const failProceed = vi.fn()
    const failSave = vi.fn().mockRejectedValue(new Error('nope'))
    const fail = renderHook(() => useComposeGuard({ dirty: true, saveDraft: failSave }))
    act(() => fail.result.current.guardClose(failProceed))
    await act(async () => {
      fail.result.current.onSaveDraft()
    })
    await waitFor(() => expect(fail.result.current.unsavedOpen).toBe(false))
    expect(failProceed).not.toHaveBeenCalled()
  })
})

describe('ComposeNewModal 离开守卫 — scrim/× 经守卫桥', () => {
  beforeEach(() => {
    useComposeNewStore.setState({ open: false })
    mockEmailGet.mockResolvedValue({ internal_id: -1, attachments: [] })
  })
  afterEach(() => useComposeNewStore.setState({ open: false }))

  // new 模式空表单: 等 editor 就绪 (planApplied) → baseline 开放 → 编辑才算脏。
  async function openNewModalReady(): Promise<void> {
    act(() => useComposeNewStore.getState().openCompose())
    renderWithClient(<ComposeNewModal />)
    await waitFor(() => expect(screen.getByLabelText('关闭')).toBeTruthy())
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    // planApplied → baselineReady 的两跳 effect 落定。
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  test('未编辑 → 点关闭直接关 (store open=false), 无守卫弹窗', async () => {
    await openNewModalReady()
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(screen.queryByText('未保存的更改')).toBeNull()
    expect(useComposeNewStore.getState().open).toBe(false)
  })

  test('编辑主题 → 点关闭弹守卫 (不关), store 仍 open', async () => {
    await openNewModalReady()
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '新邮件主题' } })
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(await screen.findByText('未保存的更改')).toBeTruthy()
    expect(useComposeNewStore.getState().open).toBe(true)
  })
})
