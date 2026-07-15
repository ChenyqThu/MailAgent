// @vitest-environment happy-dom
//
// T6 Bug C 拦截点① — EmailDetail 切邮件时的 compose 离开守卫。
//   - overlay (reply/forward) 有未保存更改 → 切邮件不静默丢: overlay 钉住 + 弹守卫。
//   - overlay 无更改 → 切邮件静默关闭 (原行为, 清 stale store, 防灰白蒙版)。
// 详情列子组件非本用例关注点 → stub, 只保留 compose overlay。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const {
  mockGet,
  mockAiFields,
  mockGetCached,
  mockAbortTranslate,
  mockDraftPlan,
  mockDraft,
  mockSend,
  mockSettingsGet
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockAiFields: vi.fn(),
  mockGetCached: vi.fn(),
  mockAbortTranslate: vi.fn(),
  mockDraftPlan: vi.fn(),
  mockDraft: vi.fn(),
  mockSend: vi.fn(),
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
      body: vi.fn()
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
  mockGet.mockImplementation((id: number) => Promise.resolve(id === 43 ? EMAIL_43 : EMAIL_42))
  mockAiFields.mockResolvedValue(null)
  mockGetCached.mockResolvedValue(null)
  mockDraftPlan.mockResolvedValue(PLAN)
  mockDraft.mockResolvedValue({ success: true })
  mockSend.mockResolvedValue({ sent: true })
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
})

afterEach(() => {
  cleanup()
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
})

describe('EmailDetail 切邮件 — compose 离开守卫 (T6 拦截点①)', () => {
  test('overlay dirty → 切邮件不静默丢: 弹守卫 + overlay 保持 + store 仍 open', async () => {
    const { rerender } = render(view(42))
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    // 编辑主题 → dirty
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '改了主题' } })
    // 切到邮件 43
    rerender(view(43))
    // 守卫弹窗出现 (没有静默 closeCompose)
    expect(await screen.findByText('未保存的更改')).toBeTruthy()
    // overlay composer 仍挂载 (钉住)
    expect(document.querySelector('[aria-label="compose-panel"]')).toBeTruthy()
    // store 仍 open (没被清)
    expect(useComposeStore.getState().open).toBe(true)
  })

  test('overlay clean → 切邮件静默关闭: 无守卫弹窗 + store 清空', async () => {
    const { rerender } = render(view(42))
    act(() => useComposeStore.getState().openCompose(42, 'reply'))
    await waitFor(() => expect(screen.getByText('alice@acme.com')).toBeTruthy())
    // 不编辑 → clean → 切邮件
    rerender(view(43))
    await waitFor(() => expect(useComposeStore.getState().open).toBe(false))
    expect(screen.queryByText('未保存的更改')).toBeNull()
  })
})
