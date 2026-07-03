// @vitest-environment happy-dom
//
// D6 compose 附件 UI — ComposePanelInner mode='new' (无预填 query, 附件面最小外壳):
//   - 文件选择 → uploadComposeAttachment(File bytes) → chip (文件名+大小) + stage_id 落地
//   - 超 20MB 前端先拦, 不发上传
//   - 上传中禁发送; 完成后 send payload 带 attachments: [{stage_id}]
//   - chip 删除只移除本地引用 (payload 不再带)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockSend, mockSettingsGet, mockUpload, mockDraftPlan, mockEmailGet, mockToastError } =
  vi.hoisted(() => ({
    mockSend: vi.fn(),
    mockSettingsGet: vi.fn(),
    mockUpload: vi.fn(),
    mockDraftPlan: vi.fn(),
    mockEmailGet: vi.fn(),
    mockToastError: vi.fn()
  }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      send: mockSend,
      uploadComposeAttachment: mockUpload,
      // forward 权威列表补齐: 发送时经 ensureQueryData(['email', id]) 补拉原邮件附件。
      draftPlan: mockDraftPlan,
      get: mockEmailGet
    },
    settings: { get: mockSettingsGet }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastError: mockToastError,
  toastSuccess: vi.fn()
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

function makeFile(name: string, bytes: number[], type = 'application/pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** happy-dom 下真造 21MB Blob 慢; 用小文件 + 实例级 size 覆写模拟超限。 */
function makeOversizeFile(name: string): File {
  const f = makeFile(name, [1])
  Object.defineProperty(f, 'size', { value: 21 * 1024 * 1024 })
  return f
}

async function addRecipient(addr: string): Promise<void> {
  const input = screen.getByLabelText('收件人') as HTMLInputElement
  fireEvent.change(input, { target: { value: addr } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText(addr)).toBeTruthy())
}

function pickFiles(...files: File[]): void {
  const input = screen.getByLabelText('附件', { selector: 'input' }) as HTMLInputElement
  fireEvent.change(input, { target: { files } })
}

// forward 预填 plan (含收件人, 否则缺收件人会挡住发送) + 原邮件 detail 附件列表:
// 101 常规 / 102 inline (应排除) / 103 derived (只滤 is_inline → 仍带上)。
const FORWARD_PLAN = {
  internal_id: 42,
  mode: 'forward' as const,
  to: ['fwd@acme.com'],
  cc: [],
  bcc: [],
  subject: 'Fwd: 合同',
  reply_html: '',
  forward_intro_html: '',
  attachments: 2,
  warnings: []
}
const FORWARD_DETAIL = {
  internal_id: 42,
  attachments: [
    { id: 101, filename: 'orig1.pdf', size_bytes: 100, is_inline: false, derived_from: null },
    { id: 102, filename: 'inline.png', size_bytes: 50, is_inline: true, derived_from: null },
    { id: 103, filename: 'orig2.csv', size_bytes: 200, is_inline: false, derived_from: 5 }
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockSend.mockResolvedValue({ sent: true })
  mockUpload.mockResolvedValue({
    stage_id: 'st-1',
    filename: 'report.pdf',
    size: 3,
    mime: 'application/pdf'
  })
  mockDraftPlan.mockResolvedValue(FORWARD_PLAN)
  mockEmailGet.mockResolvedValue(FORWARD_DETAIL)
})

afterEach(() => cleanup())

describe('ComposePanel — D6 附件面 (mode=new)', () => {
  test('选择文件 → 上传 → chip 展示文件名+大小', async () => {
    renderWithClient(<ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />)
    pickFiles(makeFile('report.pdf', [1, 2, 3]))
    await waitFor(() =>
      expect(mockUpload).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'report.pdf', mime: 'application/pdf' })
      )
    )
    // bytes 是 File 内容的 ArrayBuffer
    const arg = mockUpload.mock.calls[0][0]
    expect(new Uint8Array(arg.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    // chip 出现 (上传完成态)
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    expect(screen.getByLabelText('移除 report.pdf')).toBeTruthy()
  })

  test('超 20MB 前端先拦: 不上传、无 chip', async () => {
    renderWithClient(<ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />)
    pickFiles(makeOversizeFile('huge.zip'))
    // 拦截在上传之前 — 等一拍确认没发出去
    await new Promise((r) => setTimeout(r, 20))
    expect(mockUpload).not.toHaveBeenCalled()
    expect(screen.queryByText('huge.zip')).toBeNull()
  })

  test('上传中发送按钮禁用; 完成后 send payload 带 attachments refs', async () => {
    let resolveUpload: (v: unknown) => void = () => {}
    mockUpload.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve
        })
    )
    renderWithClient(<ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />)
    await addRecipient('alice@acme.com')
    pickFiles(makeFile('report.pdf', [9]))
    // 上传挂起 → 发送禁用
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    const sendBtn = screen.getByRole('button', { name: /^发送$/ }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
    // 回执落地 → 可发送, payload 带 {stage_id}
    resolveUpload({ stage_id: 'st-9', filename: 'report.pdf', size: 1, mime: null })
    await waitFor(() => expect(sendBtn.disabled).toBe(false))
    fireEvent.click(sendBtn)
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toEqual([{ stage_id: 'st-9' }])
  })

  test('删除 chip → payload 不再带 attachments 字段', async () => {
    renderWithClient(<ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />)
    await addRecipient('alice@acme.com')
    pickFiles(makeFile('report.pdf', [1]))
    await waitFor(() => expect(screen.getByLabelText('移除 report.pdf')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('移除 report.pdf'))
    expect(screen.queryByText('report.pdf')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toBeUndefined()
  })
})

describe('ComposePanel — forward 附件权威列表 (契约缝修复)', () => {
  // forward 预填走 draftPlan → 等主题落地表示表单就绪。
  async function renderForwardAndWait(): Promise<void> {
    renderWithClient(<ComposePanelInner internalId={42} mode="forward" onClose={() => {}} />)
    await waitFor(() =>
      expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('Fwd: 合同')
    )
  }

  async function confirmSend(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
  }

  test('① forward + 新增附件 → payload 前置原邮件非 inline 附件 (含 derived) + staged', async () => {
    await renderForwardAndWait()
    pickFiles(makeFile('extra.pdf', [7]))
    await waitFor(() => expect(screen.getByText('extra.pdf')).toBeTruthy())
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    // 101 常规 + 103 derived (只滤 is_inline, 与服务端 _collect_forward_attachments 同口径),
    // inline 102 排除; 用户新上传 staged st-1 追加在后。
    expect(mockSend.mock.calls[0][0].attachments).toEqual([
      { attachment_id: 101 },
      { attachment_id: 103 },
      { stage_id: 'st-1' }
    ])
  })

  test('② forward 无新增附件 → 不带 attachments 键 (服务端自动收集), 不补拉', async () => {
    await renderForwardAndWait()
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toBeUndefined()
    expect(mockEmailGet).not.toHaveBeenCalled()
  })

  test('③ 原邮件 detail 未加载 (引用块未展开) → 发送时补拉一次', async () => {
    await renderForwardAndWait()
    pickFiles(makeFile('extra.pdf', [7]))
    await waitFor(() => expect(screen.getByText('extra.pdf')).toBeTruthy())
    // 引用块从未展开 → 预填阶段不拉 detail。
    expect(mockEmailGet).not.toHaveBeenCalled()
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockEmailGet).toHaveBeenCalledTimes(1)
  })

  test('④ detail 补拉失败 → 阻断发送 + 报错, 绝不静默丢原附件', async () => {
    mockEmailGet.mockRejectedValue(new Error('network down'))
    await renderForwardAndWait()
    pickFiles(makeFile('extra.pdf', [7]))
    await waitFor(() => expect(screen.getByText('extra.pdf')).toBeTruthy())
    await confirmSend()
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockSend).not.toHaveBeenCalled()
  })
})
