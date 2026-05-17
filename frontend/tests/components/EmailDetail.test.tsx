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

const { mockGet, mockAiFields, mockTranslate, mockAbortTranslate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
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
      body: vi.fn(),
      aiFields: mockAiFields,
      search: vi.fn(),
      resync: vi.fn()
    },
    attachment: { list: vi.fn().mockResolvedValue([]), localPath: vi.fn() },
    ai: { translate: mockTranslate, abortTranslate: mockAbortTranslate }
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
