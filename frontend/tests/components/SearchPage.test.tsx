// @vitest-environment happy-dom
//
// Sprint 3 §2.1 — SearchPage TDD.
//
// Test surface:
//   1. blank state when query is empty (no search call)
//   2. English query passes through verbatim after debounce
//   3. bare CJK gets `*` suffix (FTS5 unicode61 quirk per CLAUDE.md "Phase 3")
//   4. CJK already ending in `*` is not double-wildcarded
//   5. FTS5 operators (AND/OR/NOT/"...") are not touched
//   6. mailbox filter narrows the call
//   7. since=7d filter adds an ISO date
//   8. 0 hits surfaces the noResults message
//   9. snippet renders <mark> + click jumps back to inbox with setActive
//
// Mocks: useMailApi (search + listMailboxes), useActiveEmail.setActive,
// @tanstack/react-router useNavigate. No real DOM router — the page is
// rendered standalone with a TanStack Query host.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// vi.mock factories are hoisted to module top — `vi.hoisted` lets them
// capture mock fns that the test body uses for assertions.
const { mockSearch, mockListMailboxes, mockSetActive, mockNavigate } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockListMailboxes: vi.fn(),
  mockSetActive: vi.fn(),
  mockNavigate: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      search: mockSearch,
      listMailboxes: mockListMailboxes,
      list: vi.fn(),
      listEnriched: vi.fn(),
      get: vi.fn(),
      body: vi.fn(),
      aiFields: vi.fn(),
      listByThread: vi.fn(),
      resync: vi.fn()
    },
    attachment: { list: vi.fn(), localPath: vi.fn() },
    ai: { translate: vi.fn() }
  })
}))

vi.mock('@shared/state/active-email', async () => {
  type AnyState = { activeInternalId: number | null; setActive: (id: number | null) => void }
  const state: AnyState = { activeInternalId: null, setActive: mockSetActive }
  function useActiveEmail<T = AnyState>(selector?: (s: AnyState) => T): T {
    if (selector) return selector(state)
    return state as unknown as T
  }
  useActiveEmail.getState = (): AnyState => state
  return { useActiveEmail }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

import i18n from '@shared/i18n'
import { SearchPage } from '../../src/shared/components/search/SearchPage'

// happy-dom navigator.language → 'en-US' so the LanguageDetector picks
// en-US; force zh-CN here so the assertions match the user-default locale.
await i18n.changeLanguage('zh-CN')

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListMailboxes.mockResolvedValue([
    { mailbox: '收件箱', total: 100, unread: 5 },
    { mailbox: '发件箱', total: 50, unread: 0 }
  ])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SearchPage — query normalisation', () => {
  test('blank state when query is empty (no search call fired)', async () => {
    mockSearch.mockResolvedValue([])
    renderWithClient(<SearchPage />)
    // blank-state prompt visible
    expect(screen.getByText('输入关键词开始搜索')).toBeTruthy()
    // Give debounce a chance to misfire — it shouldn't.
    await new Promise((r) => setTimeout(r, 50))
    expect(mockSearch).not.toHaveBeenCalled()
  })

  test('English query passes through verbatim after debounce', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'redis' } })
    vi.advanceTimersByTime(250)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'redis' }))
    )
  })

  test('bare CJK gets `*` suffix on last token (FTS5 unicode61 quirk)', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '产品' } })
    vi.advanceTimersByTime(250)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '产品*' }))
    )
  })

  test('CJK already ending in `*` is not double-wildcarded', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '产品*' } })
    vi.advanceTimersByTime(250)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '产品*' }))
    )
  })

  test('FTS5 operators (AND/OR/NOT/quoted phrase) bypass CJK wildcard', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'redis AND 产品' } })
    vi.advanceTimersByTime(250)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'redis AND 产品' })
      )
    )
  })
})

describe('SearchPage — filters', () => {
  test('mailbox filter narrows the call', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    // Wait for mailboxes to load + chip to render
    await waitFor(() => screen.getByRole('button', { name: '收件箱' }))
    fireEvent.click(screen.getByRole('button', { name: '收件箱' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'redis' } })
    vi.advanceTimersByTime(250)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'redis', mailbox: '收件箱' })
      )
    )
  })

  test('since=7d filter sets ISO date 7 days ago', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ now: new Date('2026-05-17T12:00:00Z'), shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.click(screen.getByRole('button', { name: /近 7 天/ }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'redis' } })
    vi.advanceTimersByTime(250)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'redis', since: '2026-05-10' })
      )
    )
  })
})

describe('SearchPage — result rendering + interaction', () => {
  test('0 hits → noResults message', async () => {
    mockSearch.mockResolvedValue([])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothingmatches' } })
    vi.advanceTimersByTime(250)
    await waitFor(() => expect(screen.getByText('未找到匹配的邮件')).toBeTruthy())
  })

  test('snippet renders <mark> highlight + click → setActive + navigate /', async () => {
    mockSearch.mockResolvedValue([
      {
        internal_id: 101,
        subject: 'redis timeout debug session',
        sender: 'alice@example.com',
        date_received: '2026-05-15T09:00:00+08:00',
        mailbox: '收件箱',
        rank: -1.76,
        snippet: 'Hey, the <mark>redis</mark> client keeps timing out after 5s.',
        notion_page_id: null,
        notion_url: null
      }
    ])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithClient(<SearchPage />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'redis' } })
    vi.advanceTimersByTime(250)
    await waitFor(() => screen.getByText('redis timeout debug session'))

    const mark = document.querySelector('mark')
    expect(mark?.textContent).toBe('redis')

    fireEvent.click(screen.getByText('redis timeout debug session'))
    expect(mockSetActive).toHaveBeenCalledWith(101)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
  })
})
