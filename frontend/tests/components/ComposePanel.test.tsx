// @vitest-environment happy-dom
//
// Compose UI — ComposePanel pre-fill + send-confirm flow + RecipientField
// chip entry. Mocks useMailApi so the panel exercises draftPlan → pre-fill,
// the send-confirm dialog gate, and the email.send dispatch without forking
// the real CLI.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockDraftPlan, mockDraft, mockSend, mockSettingsGet, mockEmailGet } = vi.hoisted(() => ({
  mockDraftPlan: vi.fn(),
  mockDraft: vi.fn(),
  mockSend: vi.fn(),
  mockSettingsGet: vi.fn(),
  mockEmailGet: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      draftPlan: mockDraftPlan,
      draft: mockDraft,
      send: mockSend,
      // 引用块默认展开 → detailQ 拉 email.get 取 attachments (供 EmailBodyFrame 内联图)。
      get: mockEmailGet
    },
    settings: { get: mockSettingsGet }
  })
}))

// 引用块用 EmailBodyFrame (sandbox iframe + 自身 IPC) 渲染原文 —— compose 单测不测它
// (XSS/渲染由 dompurify_xss.test 覆盖), stub 成空避免真挂载触发 IPC。
vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({
  EmailBodyFrame: () => null
}))

import i18n from '@shared/i18n'
import { ComposePanel } from '../../src/shared/components/email/compose/ComposePanel'
import { RecipientField } from '../../src/shared/components/email/compose/RecipientField'
import { useComposeStore } from '../../src/shared/state/compose'

await i18n.changeLanguage('zh-CN')

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

// draftPlan 返回值 = DraftPlanResult, 字段是 snake_case (对齐 CLI JSON 输出)。
// 早期 mock 误用 camelCase (replyHtml/forwardIntroHtml) 掩盖了 Bug A: 真实后端
// 返回 snake_case, 但 ComposePanel 读 camelCase → 正文永远填不上。
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
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com' })
  mockEmailGet.mockResolvedValue({ internal_id: 42, attachments: [] })
  // Reset the singleton store between tests.
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
})

afterEach(() => {
  cleanup()
})

describe('ComposePanel — pre-fill + send flow', () => {
  test('closed store → renders nothing', () => {
    const { container } = renderWithClient(<ComposePanel />)
    expect(container.querySelector('[aria-label="compose-panel"]')).toBeNull()
  })

  test('open → draftPlan fetched + recipients/subject pre-filled', async () => {
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    renderWithClient(<ComposePanel />)
    await waitFor(() =>
      expect(mockDraftPlan).toHaveBeenCalledWith({ internalId: 42, mode: 'reply' })
    )
    // pre-filled subject lands in the Subject input
    await waitFor(() => {
      const subj = screen.getByLabelText('主题') as HTMLInputElement
      expect(subj.value).toBe('Re: 合同审阅')
    })
    // pre-filled To chip rendered
    expect(screen.getByText('alice@acme.com')).toBeTruthy()
  })

  test('发送 opens confirm dialog, not an immediate send', async () => {
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    renderWithClient(<ComposePanel />)
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    // dialog up; send not yet dispatched
    expect(mockSend).not.toHaveBeenCalled()
    expect(screen.getByText(/确认发送给/)).toBeTruthy()
  })

  test('confirm send dispatches email.send with edited recipients', async () => {
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    renderWithClient(<ComposePanel />)
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const arg = mockSend.mock.calls[0][0]
    expect(arg).toMatchObject({ internalId: 42, mode: 'reply' })
    expect(arg.to).toEqual(['alice@acme.com'])
    expect(typeof arg.bodyHtml).toBe('string')
    // plan.reply_html 必须真正预填进 editor → 出现在发送正文里 (Bug A 回归守护)。
    expect(arg.bodyHtml).toContain('你好')
  })

  test('保存草稿 dispatches email.draft', async () => {
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    renderWithClient(<ComposePanel />)
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^保存草稿$/ }))
    await waitFor(() => expect(mockDraft).toHaveBeenCalledTimes(1))
    expect(mockDraft.mock.calls[0][0]).toMatchObject({ internalId: 42, mode: 'reply' })
  })

  test('quote_html: 引用块折叠 toggle 渲染 + 发送正文拼回引用 (不灌进编辑器)', async () => {
    // 大邮件引用块从 TipTap 分离: 编辑器只载 reply_html (建议), 引用块折叠展示 + 发送时
    // 拼回 → bodyHtml 同时含建议与引用。默认收起 → EmailBodyFrame 不挂载 (无需 mock get)。
    mockDraftPlan.mockResolvedValue({ ...PLAN, quote_html: '<blockquote>原文引用XYZ</blockquote>' })
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    renderWithClient(<ComposePanel />)
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    // 折叠 toggle 出现 (引用块没有灌进编辑器)
    expect(screen.getByText('引用原文')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    const body = mockSend.mock.calls[0][0].bodyHtml as string
    expect(body).toContain('你好') // 建议 (编辑器)
    expect(body).toContain('原文引用XYZ') // 引用块 (发送时拼回)
  })

  test('forward with no recipient blocks send (no dialog)', async () => {
    mockDraftPlan.mockResolvedValue({ ...PLAN, mode: 'forward', to: [], subject: 'Fwd: 合同审阅' })
    act(() => useComposeStore.getState().openCompose(42, 'forward'))
    renderWithClient(<ComposePanel />)
    await waitFor(() =>
      expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('Fwd: 合同审阅')
    )
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    expect(mockSend).not.toHaveBeenCalled()
    expect(screen.queryByText(/确认发送给/)).toBeNull()
  })
})

describe('RecipientField — chip entry', () => {
  test('Enter commits a chip; × removes it; self email is filtered out', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <RecipientField
        label="To"
        values={[]}
        placeholder="add"
        onChange={onChange}
        selfEmail="me@acme.com"
      />
    )
    const input = screen.getByLabelText('To') as HTMLInputElement

    // commit a new chip via Enter
    fireEvent.change(input, { target: { value: 'bob@acme.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['bob@acme.com'])

    // self email is filtered out (no onChange with the self address)
    onChange.mockClear()
    fireEvent.change(input, { target: { value: 'me@acme.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()

    // remove an existing chip
    onChange.mockClear()
    rerender(
      <RecipientField
        label="To"
        values={['bob@acme.com']}
        placeholder="add"
        onChange={onChange}
        selfEmail="me@acme.com"
      />
    )
    fireEvent.click(screen.getByLabelText('remove bob@acme.com'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  test('comma-separated paste splits into multiple chips', () => {
    const onChange = vi.fn()
    render(<RecipientField label="Cc" values={[]} placeholder="cc" onChange={onChange} />)
    const input = screen.getByLabelText('Cc') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a@x.com, b@y.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['a@x.com', 'b@y.com'])
  })
})
