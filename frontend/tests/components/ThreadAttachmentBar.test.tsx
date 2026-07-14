// @vitest-environment happy-dom
//
// Thread-wide attachment strip. Pins the load-bearing behaviours + the codex
// review hardening:
//   - aggregates the active message's attachments + every sibling's (fetched
//     lazily via attachment.list), filtering inline + derived rows;
//   - renders incrementally — the active message's attachments show before a
//     slow sibling's list resolves;
//   - image originals ≤ 1 MB get a real thumbnail; larger images / non-images
//     fall back to a type icon (no data-URL read);
//   - returns null when the whole thread has no attachments;
//   - clicking a card jumps to that message (setActive navTarget);
//   - [H1] "Download all" is disabled until every sibling list settles, then
//     downloads the COMPLETE set (not the click-moment snapshot); a failed
//     sibling list surfaces an explicit partial warning;
//   - [H2] oversized images warn instead of an unbounded full-file read;
//   - [M4] a failed thumbnail blocks preview; [M5] a null read falls to icon.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockListByThread, mockAttList, mockReadDataUrl, mockDownload, mockToastError } = vi.hoisted(
  () => ({
    mockListByThread: vi.fn(),
    mockAttList: vi.fn(),
    mockReadDataUrl: vi.fn(),
    mockDownload: vi.fn(),
    mockToastError: vi.fn()
  })
)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { listByThread: mockListByThread },
    attachment: { list: mockAttList, readDataUrl: mockReadDataUrl, download: mockDownload }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastError: mockToastError,
  toastSuccess: vi.fn()
}))

import i18n from '@shared/i18n'
import { useActiveEmail } from '@shared/state/active-email'
import { ThreadAttachmentBar } from '../../src/shared/components/email/ThreadAttachmentBar'

await i18n.changeLanguage('en-US')

const DATA_URL = 'data:image/png;base64,QUJD'
const MB = 1024 * 1024

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

const baseProps = {
  threadId: 'T',
  activeInternalId: 1,
  activeSenderName: 'Alice',
  activeSender: 'Alice <alice@x.test>',
  activeDate: '2026-07-02T00:00:00Z'
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

// The "Download all" control has no aria-label (its accessible name comes from
// the label text, which flips between "Download all" and "Loading…"). Grab it
// by text so the query is stable across states.
function downloadAllButton(): HTMLButtonElement {
  const btn = screen
    .getAllByRole('button')
    .find((b) => /Download all|Loading/.test(b.textContent ?? ''))
  return btn as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  useActiveEmail.setState({ activeInternalId: 1, navTargetId: null })
  mockReadDataUrl.mockResolvedValue(DATA_URL)
  mockDownload.mockResolvedValue('/Users/me/Downloads/f')
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
      ...baseProps,
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    expect(await screen.findByText('active.pdf')).toBeTruthy()
    expect(await screen.findByText('reply.png')).toBeTruthy()
    expect(screen.queryByText('signature.png')).toBeNull()
    expect(screen.queryByText('sheet.csv')).toBeNull()

    await waitFor(() => {
      const img = document.querySelector('img')
      expect(img?.getAttribute('src')).toBe(DATA_URL)
    })
    expect(mockReadDataUrl).toHaveBeenCalledWith(20)
    expect(mockReadDataUrl).not.toHaveBeenCalledWith(10)
  })

  test('renders the active attachment before a slow sibling list resolves', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockReturnValue(new Promise(() => {}))

    renderBar({
      ...baseProps,
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    expect(await screen.findByText('active.pdf')).toBeTruthy()
  })

  test('large image falls back to a type icon (no thumbnail read)', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 30, filename: 'huge.png', size_bytes: 3 * MB, content_type: 'image/png' })
    ])

    renderBar({ ...baseProps, activeAttachments: [] })

    expect(await screen.findByText('huge.png')).toBeTruthy()
    expect(mockReadDataUrl).not.toHaveBeenCalled()
    expect(document.querySelector('img')).toBeNull()
  })

  test('returns null when the whole thread has no attachments', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([])

    const { container } = renderBar({ ...baseProps, activeAttachments: [] })

    await waitFor(() => expect(mockAttList).toHaveBeenCalled())
    expect(container.querySelector('section[aria-label="thread-attachments"]')).toBeNull()
  })

  test('clicking a card jumps to that message via setActive(navTarget)', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' })
    ])

    renderBar({ ...baseProps, activeAttachments: [] })

    const card = await screen.findByTitle('reply.png')
    fireEvent.click(card)
    expect(useActiveEmail.getState().activeInternalId).toBe(2)
    expect(useActiveEmail.getState().navTargetId).toBe(2)
  })

  test('[H1] download-all stays disabled until every sibling list settles', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockReturnValue(new Promise(() => {})) // never settles

    renderBar({
      ...baseProps,
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    await screen.findByText('active.pdf')
    expect(downloadAllButton().disabled).toBe(true)
  })

  test('[H1] download-all downloads active + every sibling attachment', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' })
    ])

    renderBar({
      ...baseProps,
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    await screen.findByText('reply.png')
    await waitFor(() => expect(downloadAllButton().disabled).toBe(false))
    fireEvent.click(downloadAllButton())

    await waitFor(() => {
      expect(mockDownload).toHaveBeenCalledWith(10)
      expect(mockDownload).toHaveBeenCalledWith(20)
    })
  })

  test('[H1] a failed sibling list surfaces a partial warning', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockRejectedValue(new Error('boom'))

    renderBar({
      ...baseProps,
      activeAttachments: [
        att({ id: 10, internal_id: 1, filename: 'active.pdf', content_type: 'application/pdf' })
      ]
    })

    await screen.findByText('active.pdf')
    await waitFor(() => expect(downloadAllButton().disabled).toBe(false))
    fireEvent.click(downloadAllButton())

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Some attachments couldn't be loaded.")
    )
    // Active attachment still downloaded — incomplete isn't dropped silently.
    expect(mockDownload).toHaveBeenCalledWith(10)
  })

  test('[H2] preview of an oversized image warns instead of reading it', async () => {
    renderBar({
      ...baseProps,
      threadId: null,
      activeAttachments: [
        att({
          id: 10,
          internal_id: 1,
          filename: 'raw.png',
          size_bytes: 30 * MB,
          content_type: 'image/png'
        })
      ]
    })

    const preview = await screen.findByRole('button', { name: 'Preview' })
    fireEvent.click(preview)

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('File too large to preview — download instead.')
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockReadDataUrl).not.toHaveBeenCalled()
  })

  test('[M4] a thumbnail that fails to decode blocks preview', async () => {
    renderBar({
      ...baseProps,
      threadId: null,
      activeAttachments: [
        att({
          id: 10,
          internal_id: 1,
          filename: 'bad.png',
          size_bytes: 400,
          content_type: 'image/png'
        })
      ]
    })

    // Decorative thumbnails use alt="" (role presentation), so query the DOM.
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    fireEvent.error(document.querySelector('img') as HTMLImageElement)

    const preview = await screen.findByRole('button', { name: 'Preview' })
    fireEvent.click(preview)

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Couldn't load preview."))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('[M5] readDataUrl null falls back to the icon without crashing', async () => {
    mockReadDataUrl.mockResolvedValue(null)
    renderBar({
      ...baseProps,
      threadId: null,
      activeAttachments: [
        att({
          id: 10,
          internal_id: 1,
          filename: 'ghost.png',
          size_bytes: 400,
          content_type: 'image/png'
        })
      ]
    })

    expect(await screen.findByText('ghost.png')).toBeTruthy()
    await waitFor(() => expect(mockReadDataUrl).toHaveBeenCalledWith(10))
    expect(document.querySelector('img')).toBeNull()
  })
})
