// @vitest-environment happy-dom
//
// WP5 —— mode='new' 的 initialTo / initialCc 预填回归：cc 预填后 ccVisible 自动
// 展开（chip 可见），且预填**不标脏**（guard.attemptClose 直接关、不弹确认）。
// mock 形态照 ComposePanel.test.tsx（useMailApi + EmailBodyFrame stub）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRef } from 'react'

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
      get: mockEmailGet
    },
    settings: { get: mockSettingsGet }
  })
}))

vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({
  EmailBodyFrame: () => null
}))

import i18n from '@shared/i18n'
import { ComposePanelInner } from '../../src/shared/components/email/compose/ComposePanel'
import type { ComposeGuardHandle } from '../../src/shared/components/email/compose/useComposeGuard'

await i18n.changeLanguage('zh-CN')

function Harness({
  onGuard,
  initialCc
}: {
  onGuard: (handle: ComposeGuardHandle | null) => void
  initialCc?: readonly string[]
}): React.ReactElement {
  const guardRef = useRef<ComposeGuardHandle | null>(null)
  return (
    <ComposePanelInner
      internalId={-1}
      mode="new"
      variant="modal"
      onClose={() => {}}
      guardRef={{
        get current() {
          return guardRef.current
        },
        set current(value) {
          guardRef.current = value
          onGuard(value)
        }
      }}
      initialTo={['alice@x.com']}
      initialCc={initialCc}
    />
  )
}

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com' })
})

afterEach(() => cleanup())

describe('ComposePanelInner mode=new — initialTo/initialCc 预填', () => {
  test('initialCc 预填 → cc 行自动展开、chip 可见；initialTo 照旧', async () => {
    renderWithClient(<Harness onGuard={() => {}} initialCc={['boss@x.com']} />)
    await waitFor(() => expect(screen.getByText('alice@x.com')).toBeTruthy())
    // ccVisible 翻转：cc chip 渲染（未展开时 chip 根本不在 DOM）
    expect(screen.getByText('boss@x.com')).toBeTruthy()
  })

  test('不传 initialCc → cc 行维持收起（字节级现状）', async () => {
    renderWithClient(<Harness onGuard={() => {}} />)
    await waitFor(() => expect(screen.getByText('alice@x.com')).toBeTruthy())
    expect(screen.queryByText('boss@x.com')).toBeNull()
    // 收起态的 cc 是「Cc」展开钮而不是输入行
    expect(screen.getByRole('button', { name: 'Cc' })).toBeTruthy()
  })

  test('预填不标脏：guard.attemptClose 直接关、不弹未保存确认', async () => {
    let handle: ComposeGuardHandle | null = null
    renderWithClient(
      <Harness
        onGuard={(value) => {
          handle = value
        }}
        initialCc={['boss@x.com']}
      />
    )
    await waitFor(() => expect(screen.getByText('boss@x.com')).toBeTruthy())
    const close = vi.fn()
    expect(handle).not.toBeNull()
    fireEvent.click(document.body) // 无关交互，确保没有隐式 focus 改动
    handle!.attemptClose(close)
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/未保存/)).toBeNull()
  })
})
