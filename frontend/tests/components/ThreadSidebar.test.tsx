// @vitest-environment happy-dom
//
// Sprint 3 §2.3 — ThreadSidebar component coverage.
// Three states the user actually sees:
//   1. thread_id = null → render nothing (silent)
//   2. thread_id with multiple siblings → list rendered, current highlighted,
//      click on another sibling calls setActive
//   3. listByThread throws → error UI surfaces "线程加载失败"

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockListByThread, mockSetActive } = vi.hoisted(() => ({
  mockListByThread: vi.fn(),
  mockSetActive: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      listByThread: mockListByThread,
      list: vi.fn(),
      listEnriched: vi.fn(),
      listMailboxes: vi.fn(),
      get: vi.fn(),
      body: vi.fn(),
      aiFields: vi.fn(),
      search: vi.fn(),
      resync: vi.fn()
    },
    attachment: { list: vi.fn(), localPath: vi.fn() },
    ai: { translate: vi.fn(), abortTranslate: vi.fn() }
  })
}))

vi.mock('@shared/state/active-email', () => {
  type AnyState = { activeInternalId: number | null; setActive: (id: number | null) => void }
  const state: AnyState = { activeInternalId: 101, setActive: mockSetActive }
  function useActiveEmail<T = AnyState>(selector?: (s: AnyState) => T): T {
    return selector ? selector(state) : (state as unknown as T)
  }
  useActiveEmail.getState = (): AnyState => state
  return { useActiveEmail }
})

import i18n from '@shared/i18n'
import { ThreadSidebar } from '../../src/shared/components/email/ThreadSidebar'
await i18n.changeLanguage('zh-CN')

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('ThreadSidebar', () => {
  test('returns null when threadId is empty (no query fires)', () => {
    const { container } = renderWithClient(
      <ThreadSidebar threadId={null} currentInternalId={101} />
    )
    expect(container.firstChild).toBeNull()
    expect(mockListByThread).not.toHaveBeenCalled()
  })

  test('renders sibling list ascending; current row is aria-current and not clickable', async () => {
    mockListByThread.mockResolvedValue([
      {
        internal_id: 100,
        message_id: '<a>',
        thread_id: 'thread-A',
        subject: 'first',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        date_received: '2026-05-15T07:00:00+08:00',
        mailbox: '收件箱',
        is_read: true,
        is_flagged: false,
        sync_status: 'synced',
        notion_page_id: null,
        notion_url: null
      },
      {
        internal_id: 101,
        message_id: '<b>',
        thread_id: 'thread-A',
        subject: 'second',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        date_received: '2026-05-15T09:00:00+08:00',
        mailbox: '收件箱',
        is_read: false,
        is_flagged: true,
        sync_status: 'synced',
        notion_page_id: null,
        notion_url: null
      }
    ])
    const { container } = renderWithClient(
      <ThreadSidebar threadId="thread-A" currentInternalId={101} />
    )
    // Wait for the data-loaded render — aria-current marks the current row,
    // which only appears after listByThread resolves.
    await waitFor(() => expect(container.querySelector('[aria-current="true"]')).toBeTruthy())
    const rows = container.querySelectorAll('button[disabled]')
    // 1 disabled button = the current row + 0 the header (header is role=button but not <button>)
    expect(rows.length).toBe(1)
    expect(rows[0].getAttribute('aria-current')).toBe('true')

    // Click the non-current sibling → setActive(100)
    const enabled = Array.from(container.querySelectorAll('button')).filter(
      (b) => !b.hasAttribute('disabled') && b.getAttribute('aria-current') !== 'true'
    )
    // The enabled set includes the collapsible header AND the non-current row.
    // Click the row (the one with a per-message senderName text).
    const siblingRow = enabled.find((b) => b.textContent?.includes('Alice'))
    expect(siblingRow).toBeTruthy()
    fireEvent.click(siblingRow!)
    expect(mockSetActive).toHaveBeenCalledWith(100)
  })

  test('listByThread error → 加载失败 UI', async () => {
    mockListByThread.mockRejectedValue(new Error('db unavailable'))
    const { container } = renderWithClient(
      <ThreadSidebar threadId="thread-A" currentInternalId={101} />
    )
    await waitFor(() => expect(container.textContent).toContain('线程加载失败'))
  })
})
