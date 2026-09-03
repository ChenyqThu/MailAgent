// @vitest-environment happy-dom
//
// Sprint 4 M-3 (REVIEW-LOG carry-forward) — EmailDetail switch-email abort
// regression suite.
//
// Sprint 3 wired translation cancellation in two places (useEffect cleanup
// on internalId change, and the explicit dismiss / toggle helpers). The
// `useEffect(..., [internalId, mailApi])` form is what protects against
// stale streaming responses bleeding into the next email's render — a
// future refactor that drops the dep array or moves the cleanup to a
// componentWillUnmount lifecycle would silently regress that. This file
// pins the contract: switching `internalId` MUST fire abortTranslate with
// the prior id exactly once.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockGet, mockBody, mockSettingsGet, mockAiFields, mockTranslate, mockAbortTranslate } =
  vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockBody: vi.fn(),
    mockSettingsGet: vi.fn(),
    mockAiFields: vi.fn(),
    mockTranslate: vi.fn(),
    mockAbortTranslate: vi.fn()
  }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      list: vi.fn(),
      listEnriched: vi.fn(),
      listMailboxes: vi.fn(),
      listByThread: vi.fn().mockResolvedValue([]),
      get: mockGet,
      body: mockBody,
      aiFields: mockAiFields,
      search: vi.fn(),
      resync: vi.fn(),
      draft: vi.fn(),
      send: vi.fn(),
      deleteDraft: vi.fn()
    },
    attachment: { list: vi.fn().mockResolvedValue([]), localPath: vi.fn() },
    ai: { translate: mockTranslate, abortTranslate: mockAbortTranslate },
    settings: { get: mockSettingsGet }
  })
}))

import i18n from '@shared/i18n'
import { EmailDetail } from '../../src/shared/components/email/EmailDetail'
await i18n.changeLanguage('zh-CN')

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  // retry: false so the get-returns-null shell renders synchronously instead
  // of looping; gcTime: 0 to keep query state from leaking across tests.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: every email resolves to null. The renderer then shows the
  // empty shell — the abort-cleanup path doesn't depend on detail data.
  mockGet.mockResolvedValue(null)
  mockBody.mockResolvedValue({ content: '', format: 'html' })
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockAiFields.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
})

describe('EmailDetail — switch-email translation abort (REVIEW-LOG M-3)', () => {
  test('switching internalId from 101 to 102 fires abortTranslate(101) exactly once', async () => {
    const { rerender } = renderWithClient(<EmailDetail internalId={101} />)
    // Mount itself must not fire abort — the user hasn't gone anywhere yet.
    expect(mockAbortTranslate).not.toHaveBeenCalled()

    // Switch active email. The effect cleanup runs synchronously inside the
    // commit phase of the re-render that follows React's diff.
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <EmailDetail internalId={102} />
      </QueryClientProvider>
    )

    expect(mockAbortTranslate).toHaveBeenCalledTimes(1)
    expect(mockAbortTranslate).toHaveBeenCalledWith(101)
  })

  test('unmount fires abortTranslate(current) exactly once', () => {
    const { unmount } = renderWithClient(<EmailDetail internalId={101} />)
    expect(mockAbortTranslate).not.toHaveBeenCalled()

    unmount()

    expect(mockAbortTranslate).toHaveBeenCalledTimes(1)
    expect(mockAbortTranslate).toHaveBeenCalledWith(101)
  })

  test('initial mount with internalId=null does NOT fire abortTranslate', () => {
    renderWithClient(<EmailDetail internalId={null} />)
    expect(mockAbortTranslate).not.toHaveBeenCalled()
  })

  test('switching from null → 101 does not fire abort (no prior to cancel)', () => {
    const { rerender } = renderWithClient(<EmailDetail internalId={null} />)
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <EmailDetail internalId={101} />
      </QueryClientProvider>
    )
    expect(mockAbortTranslate).not.toHaveBeenCalled()
  })

  test('switching from 101 → null fires abortTranslate(101) (closing the pane mid-translation)', () => {
    const { rerender } = renderWithClient(<EmailDetail internalId={101} />)
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <EmailDetail internalId={null} />
      </QueryClientProvider>
    )
    expect(mockAbortTranslate).toHaveBeenCalledTimes(1)
    expect(mockAbortTranslate).toHaveBeenCalledWith(101)
  })

  test('rapid switch 101 → 102 → 103 fires abort(101) then abort(102) — no skipped cleanups', () => {
    const { rerender } = renderWithClient(<EmailDetail internalId={101} />)
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <EmailDetail internalId={102} />
      </QueryClientProvider>
    )
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <EmailDetail internalId={103} />
      </QueryClientProvider>
    )
    expect(mockAbortTranslate).toHaveBeenCalledTimes(2)
    expect(mockAbortTranslate).toHaveBeenNthCalledWith(1, 101)
    expect(mockAbortTranslate).toHaveBeenNthCalledWith(2, 102)
  })
})

describe('EmailDetail — 未选中邮件的空态 (0903 dogfood E1)', () => {
  test('图标与文案的容器带 text-center（EmptyShell 只负责外层居中，行内对齐要自己声明）', async () => {
    const { screen } = await import('@testing-library/react')
    renderWithClient(<EmailDetail internalId={null} />)
    // 文案节点的父级 = 图标与文案共处的那个容器；居中类掉了这里就左对齐。
    const box = screen.getByText(i18n.t('empty.state')).parentElement
    expect(box).toBeTruthy()
    expect(box?.className.split(/\s+/)).toContain('text-center')
    // 图标与文案同容器 —— 否则「居中类在文案上」也能骗过上面那条。
    expect(box?.querySelector('svg')).toBeTruthy()
  })
})

describe('EmailDetail — draft-edit 在 replace 删行后的存活 (task 08-20 draft-save)', () => {
  const DRAFT_ROW = {
    internal_id: 99,
    subject: 'D',
    sender: 'me@acme.com',
    to_addr: 'a@x.com',
    cc_addr: '',
    mailbox: '草稿箱',
    is_read: true,
    is_important: false,
    attachments: []
  }

  test('detail 重取 404 (replace 已删旧行) 但缓存仍是草稿行 → 不换错误壳, composer 保持挂载', async () => {
    const { act, screen } = await import('@testing-library/react')
    mockGet.mockResolvedValue(DRAFT_ROW)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <EmailDetail internalId={99} />
      </QueryClientProvider>
    )
    await screen.findByLabelText('compose-panel')
    // C-1 replace: 保存后服务端删掉行 99 → email.synced 失效 → detail 重取 404
    mockGet.mockRejectedValue(Object.assign(new Error('not found'), { code: 'E_NOT_FOUND' }))
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['email', 99] })
    })
    // 编辑器不被 unmount (换错误壳 = 编辑增量随之丢失)
    expect(screen.getByLabelText('compose-panel')).toBeTruthy()
  })
})
