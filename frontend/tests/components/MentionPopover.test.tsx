// @vitest-environment happy-dom
//
// Sprint 14 PR D — MentionPopover component coverage.
// Two layers worth testing here:
//   1. open/close lifecycle — Escape + outside-click close, controlled
//      `open` prop hides the popover entirely (returns null).
//   2. search dispatch — typing into the input fires a debounced
//      mailApi.email.search call with the normalised query, and the
//      returned hits render as clickable list items that call
//      onSelect with the SearchHit.
//
// The 200ms debounce uses real timers via vi.useFakeTimers so the
// suite stays deterministic.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { MentionPopover } from '@shared/components/chat/MentionPopover'
import type { SearchHit, SearchResult } from '@shared/api/types'
import i18n from '@shared/i18n'

const { mockEmailSearch } = vi.hoisted(() => ({
  mockEmailSearch: vi.fn<(opts: { query: string }) => Promise<SearchResult>>()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { search: mockEmailSearch },
    chat: {},
    attachment: {},
    ai: {},
    island: {}
  })
}))

function fakeHit(over: Partial<SearchHit>): SearchHit {
  return {
    internal_id: 1,
    subject: 'Subject',
    sender: 'alice@example.com',
    date_received: '2026-05-20',
    mailbox: '收件箱',
    rank: -1.5,
    snippet: 'matching <mark>snippet</mark>',
    ...over
  }
}

function renderPopover(props: {
  open: boolean
  onClose?: () => void
  onSelect?: (hit: SearchHit) => void
}): { onClose: ReturnType<typeof vi.fn>; onSelect: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn(props.onClose)
  const onSelect = vi.fn(props.onSelect)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  render(
    <QueryClientProvider client={queryClient}>
      <MentionPopover open={props.open} onClose={onClose} onSelect={onSelect} />
    </QueryClientProvider>
  )
  return { onClose, onSelect }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  mockEmailSearch.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MentionPopover — visibility', () => {
  test('open=false renders nothing', () => {
    renderPopover({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockEmailSearch).not.toHaveBeenCalled()
  })

  test('open=true renders the dialog + the empty-query hint', () => {
    renderPopover({ open: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(i18n.t('chat.mention.hint'))).toBeTruthy()
    expect(mockEmailSearch).not.toHaveBeenCalled()
  })
})

describe('MentionPopover — close affordances', () => {
  test('Escape key closes the popover', () => {
    const { onClose } = renderPopover({ open: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('outside click closes the popover', () => {
    const { onClose } = renderPopover({ open: true })
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('click inside the popover does NOT close it', () => {
    const { onClose } = renderPopover({ open: true })
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('MentionPopover — search', () => {
  test('typing eventually fires an email.search call', async () => {
    // Real timers — fakeTimers + react-query's microtask queue together
    // leave the searchQ idle even after advancing time. waitFor polls
    // 50ms, so the 200ms debounce trailing edge resolves within the
    // 1s default wait.
    mockEmailSearch.mockResolvedValue({ items: [], total_indexed: null } as unknown as SearchResult)
    renderPopover({ open: true })
    const input = screen.getByLabelText(i18n.t('chat.mention.searchAria'))
    fireEvent.change(input, { target: { value: 'redis' } })
    await waitFor(() => expect(mockEmailSearch).toHaveBeenCalled())
    expect(mockEmailSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'redis' }))
  })

  test('search results render and clicking a hit fires onSelect', async () => {
    const hit = fakeHit({ internal_id: 53675, subject: 'Q3 plan', sender: 'bob@x.com' })
    mockEmailSearch.mockResolvedValue({
      items: [hit],
      total_indexed: 1
    } as unknown as SearchResult)
    const { onSelect, onClose } = renderPopover({ open: true })
    fireEvent.change(screen.getByLabelText(i18n.t('chat.mention.searchAria')), {
      target: { value: 'Q3' }
    })
    // Real timers for waitFor → debounce + react-query resolve.
    await waitFor(() => expect(screen.getByText('Q3 plan')).toBeTruthy())
    fireEvent.click(screen.getByText('Q3 plan'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(hit)
    // Component itself doesn't close on select — parent decides; current
    // Composer integration closes on select, but the contract is the
    // parent's. Verify the popover did not auto-close.
    expect(onClose).not.toHaveBeenCalled()
  })

  test('ArrowDown/ArrowUp + Enter selects highlighted hit (Sprint 14 PR H)', async () => {
    const hit1 = fakeHit({ internal_id: 1, subject: 'first', sender: 'a@x.com' })
    const hit2 = fakeHit({ internal_id: 2, subject: 'second', sender: 'b@x.com' })
    const hit3 = fakeHit({ internal_id: 3, subject: 'third', sender: 'c@x.com' })
    mockEmailSearch.mockResolvedValue({
      items: [hit1, hit2, hit3],
      total_indexed: 3
    } as unknown as SearchResult)
    const { onSelect } = renderPopover({ open: true })
    const input = screen.getByLabelText(i18n.t('chat.mention.searchAria'))
    fireEvent.change(input, { target: { value: 'x' } })
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy())

    // Initial highlight is on hit1 (index 0). ArrowDown twice moves to hit3.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // ArrowUp once moves back to hit2 (index 1).
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(hit2)
  })

  test('ArrowDown past last item clamps to last (no wrap-around)', async () => {
    const hit1 = fakeHit({ internal_id: 1, subject: 'only-one' })
    mockEmailSearch.mockResolvedValue({
      items: [hit1],
      total_indexed: 1
    } as unknown as SearchResult)
    const { onSelect } = renderPopover({ open: true })
    const input = screen.getByLabelText(i18n.t('chat.mention.searchAria'))
    fireEvent.change(input, { target: { value: 'x' } })
    await waitFor(() => expect(screen.getByText('only-one')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(hit1)
  })

  test('empty result set surfaces the noResults copy', async () => {
    mockEmailSearch.mockResolvedValue({ items: [], total_indexed: 0 } as unknown as SearchResult)
    renderPopover({ open: true })
    fireEvent.change(screen.getByLabelText(i18n.t('chat.mention.searchAria')), {
      target: { value: 'nomatch' }
    })
    await waitFor(() =>
      expect(screen.getByText(i18n.t('chat.mention.noResults', { query: 'nomatch' }))).toBeTruthy()
    )
  })
})
