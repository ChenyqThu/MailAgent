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
      // forward 权威列表 (codex F1): 打开即经 ensureQueryData(['email', id]) 补拉
      // 原邮件附件 hydrate 成可移除 chips。
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

describe('ComposePanel — forward 附件权威列表 (codex F1)', () => {
  // forward 预填走 draftPlan → 等主题落地表示表单就绪; 打开即 hydrate 原附件 chips。
  async function renderForwardAndWait(): Promise<void> {
    renderWithClient(<ComposePanelInner internalId={42} mode="forward" onClose={() => {}} />)
    await waitFor(() =>
      expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('Fwd: 合同')
    )
  }

  async function waitForHydrated(): Promise<void> {
    await waitFor(() => expect(screen.getByText('orig1.pdf')).toBeTruthy())
  }

  async function confirmSend(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认发送/ }))
  }

  test('① 打开即 hydrate: 原邮件非 inline 附件 (含 derived) 成可移除 chips', async () => {
    await renderForwardAndWait()
    await waitForHydrated()
    // 101 常规 + 103 derived (只滤 is_inline, 与服务端 _collect_forward_attachments
    // 同口径), inline 102 排除; 打开阶段即补拉一次 detail。
    expect(screen.getByText('orig2.csv')).toBeTruthy()
    expect(screen.queryByText('inline.png')).toBeNull()
    expect(mockEmailGet).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('移除 orig1.pdf')).toBeTruthy()
    expect(screen.getByLabelText('移除 orig2.csv')).toBeTruthy()
  })

  test('② 无操作发送 → 恒发显式全量列表 (不再省略键交给服务端 auto-collect)', async () => {
    await renderForwardAndWait()
    await waitForHydrated()
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toEqual([
      { attachment_id: 101 },
      { attachment_id: 103 }
    ])
  })

  test('③ 移除单个原附件 → 权威列表不含它', async () => {
    await renderForwardAndWait()
    await waitForHydrated()
    fireEvent.click(screen.getByLabelText('移除 orig1.pdf'))
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toEqual([{ attachment_id: 103 }])
  })

  test('④ 全移除后发送 → 显式空数组 [] (旧实现省略键 → auto-collect 静默恢复全部)', async () => {
    await renderForwardAndWait()
    await waitForHydrated()
    fireEvent.click(screen.getByLabelText('移除 orig1.pdf'))
    fireEvent.click(screen.getByLabelText('移除 orig2.csv'))
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toEqual([])
  })

  test('⑤ 新增 staged → 原附件前置 + staged 追加 (权威全量列表)', async () => {
    await renderForwardAndWait()
    await waitForHydrated()
    pickFiles(makeFile('extra.pdf', [7]))
    await waitFor(() => expect(screen.getByText('extra.pdf')).toBeTruthy())
    await confirmSend()
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend.mock.calls[0][0].attachments).toEqual([
      { attachment_id: 101 },
      { attachment_id: 103 },
      { stage_id: 'st-1' }
    ])
  })

  test('⑥ hydrate 失败 → 错误条 + 发送硬阻断; 重试成功后恢复', async () => {
    mockEmailGet.mockRejectedValueOnce(new Error('network down'))
    await renderForwardAndWait()
    await waitFor(() =>
      expect(screen.getByText('原邮件附件加载失败，重试成功前无法发送')).toBeTruthy()
    )
    // 发送/保存草稿按钮均禁用 (硬阻断, 绝不静默丢原附件)。
    const sendBtn = screen.getByRole('button', { name: /^发送$/ }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
    expect((screen.getByRole('button', { name: /保存草稿/ }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(mockSend).not.toHaveBeenCalled()
    // 重试 → hydrate 成功 → chips 出现, 发送恢复可用。
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    await waitForHydrated()
    await waitFor(() => expect(sendBtn.disabled).toBe(false))
  })
})
