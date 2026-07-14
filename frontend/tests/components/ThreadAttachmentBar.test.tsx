// @vitest-environment happy-dom
//
// Thread-wide attachment strip. Pins the load-bearing behaviours:
//   - aggregates the active message's attachments + every sibling's (fetched
//     lazily via attachment.list), filtering inline + derived rows;
//   - renders incrementally — the active message's attachments show before a
//     slow sibling's list resolves;
//   - image originals ≤ 1 MB get a real thumbnail; larger images / non-images
//     fall back to a type icon (no data-URL read);
//   - returns null when the whole thread has no attachments;
//   - clicking a card jumps to that message (setActive navTarget).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockListByThread, mockAttList, mockReadDataUrl, mockDownload } = vi.hoisted(() => ({
  mockListByThread: vi.fn(),
  mockAttList: vi.fn(),
  mockReadDataUrl: vi.fn(),
  mockDownload: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { listByThread: mockListByThread },
    attachment: { list: mockAttList, readDataUrl: mockReadDataUrl, download: mockDownload }
  })
}))

import i18n from '@shared/i18n'
import { useActiveEmail } from '@shared/state/active-email'
import { ThreadAttachmentBar } from '../../src/shared/components/email/ThreadAttachmentBar'

await i18n.changeLanguage('en-US')

const DATA_URL = 'data:image/png;base64,QUJD'

function member(internal_id: number, name: string): Record<string, unknown> {
  return {
    internal_id,
    thread_id: 'T',
    subject: `msg ${internal_id}`,
    sender: `${name} <${name.toLowerCase()}@x.test>`,
    sender_name: name,
    date_received: '2026-07-01T00:00:00Z',
    mailbox: '收件箱',
    is_read: true,
    is_flagged: false
  }
}

// Minimal attachment rows; only the fields the strip reads matter.
function att(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 0,
    internal_id: 2,
    filename: 'file.bin',
    size_bytes: 100,
    content_type: 'application/octet-stream',
    is_inline: false,
    derived_from: null,
    ...over
  }
}

function renderBar(props: Record<string, unknown>): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ThreadAttachmentBar {...(props as any)} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useActiveEmail.setState({ activeInternalId: 1, navTargetId: null })
  mockReadDataUrl.mockResolvedValue(DATA_URL)
})

afterEach(() => {
  cleanup()
})

describe('ThreadAttachmentBar', () => {
  test('aggregates the whole thread, filters inline + derived, thumbnails small images', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' }),
      att({ id: 21, filename: 'signature.png', is_inline: true, content_type: 'image/png' }),
      att({ id: 22, filename: 'sheet.csv', derived_from: 20, content_type: 'text/csv' })
    ])

    renderBar({
      threadId: 'T',
      activeInternalId: 1,
      activeSenderName: 'Alice',
      activeSender: 'Alice <alice@x.test>',
      activeDate: '2026-07-02T00:00:00Z',
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    // Active attachment + sibling's real attachment both surface.
    expect(await screen.findByText('active.pdf')).toBeTruthy()
    expect(await screen.findByText('reply.png')).toBeTruthy()
    // Inline + derived rows are filtered out.
    expect(screen.queryByText('signature.png')).toBeNull()
    expect(screen.queryByText('sheet.csv')).toBeNull()

    // The ≤1MB image renders a real thumbnail <img> with the data URL.
    await waitFor(() => {
      const img = document.querySelector('img')
      expect(img?.getAttribute('src')).toBe(DATA_URL)
    })
    // Only the small image was thumbnailed.
    expect(mockReadDataUrl).toHaveBeenCalledWith(20)
    expect(mockReadDataUrl).not.toHaveBeenCalledWith(10)
  })

  test('renders the active attachment before a slow sibling list resolves', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    // Sibling list never settles this render.
    mockAttList.mockReturnValue(new Promise(() => {}))

    renderBar({
      threadId: 'T',
      activeInternalId: 1,
      activeSenderName: 'Alice',
      activeSender: 'Alice <alice@x.test>',
      activeDate: '2026-07-02T00:00:00Z',
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    expect(await screen.findByText('active.pdf')).toBeTruthy()
  })

  test('large image falls back to a type icon (no thumbnail read)', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 30, filename: 'huge.png', size_bytes: 3_000_000, content_type: 'image/png' })
    ])

    renderBar({
      threadId: 'T',
      activeInternalId: 1,
      activeSenderName: 'Alice',
      activeSender: 'Alice <alice@x.test>',
      activeDate: '2026-07-02T00:00:00Z',
      activeAttachments: []
    })

    expect(await screen.findByText('huge.png')).toBeTruthy()
    // Above the cap → no data-URL read, no <img> thumbnail.
    expect(mockReadDataUrl).not.toHaveBeenCalled()
    expect(document.querySelector('img')).toBeNull()
  })

  test('returns null when the whole thread has no attachments', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([])

    const { container } = renderBar({
      threadId: 'T',
      activeInternalId: 1,
      activeSenderName: 'Alice',
      activeSender: 'Alice <alice@x.test>',
      activeDate: '2026-07-02T00:00:00Z',
      activeAttachments: []
    })

    await waitFor(() => expect(mockAttList).toHaveBeenCalled())
    expect(container.querySelector('section[aria-label="thread-attachments"]')).toBeNull()
  })

  test('clicking a card jumps to that message via setActive(navTarget)', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' })
    ])

    renderBar({
      threadId: 'T',
      activeInternalId: 1,
      activeSenderName: 'Alice',
      activeSender: 'Alice <alice@x.test>',
      activeDate: '2026-07-02T00:00:00Z',
      activeAttachments: []
    })

    const card = await screen.findByTitle('reply.png')
    fireEvent.click(card)
    expect(useActiveEmail.getState().activeInternalId).toBe(2)
    // navTarget exempts the jump from EmailList's active-reset.
    expect(useActiveEmail.getState().navTargetId).toBe(2)
  })
})
