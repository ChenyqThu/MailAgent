// @vitest-environment happy-dom
//
// Per-message attachment grid. Pins the discoverability upgrades:
//   - image originals ≤ 1 MB render a real thumbnail; larger images / non-image
//     files keep the type icon (no data-URL read);
//   - the download control is persistent (not hover-only) and downloads;
//   - the preview control opens the shared image lightbox;
//   - inline + derived rows stay filtered out of the visible tiles.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockReadDataUrl, mockDownload } = vi.hoisted(() => ({
  mockReadDataUrl: vi.fn(),
  mockDownload: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    attachment: { readDataUrl: mockReadDataUrl, download: mockDownload }
  })
}))

import i18n from '@shared/i18n'
import { AttachmentList } from '../../src/shared/components/email/AttachmentList'

await i18n.changeLanguage('en-US')

const DATA_URL = 'data:image/png;base64,QUJD'

function att(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 0,
    filename: 'file.bin',
    size_bytes: 100,
    content_type: 'application/octet-stream',
    is_inline: false,
    derived_from: null,
    ...over
  }
}

function renderList(attachments: Array<Record<string, unknown>>): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <AttachmentList attachments={attachments as any} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadDataUrl.mockResolvedValue(DATA_URL)
  mockDownload.mockResolvedValue('/Users/me/Downloads/pic.png')
})

afterEach(() => {
  cleanup()
})

describe('AttachmentList', () => {
  test('renders a thumbnail for a small image original', async () => {
    renderList([att({ id: 1, filename: 'pic.png', size_bytes: 500, content_type: 'image/png' })])

    expect(await screen.findByText('pic.png')).toBeTruthy()
    await waitFor(() => {
      const img = document.querySelector('img')
      expect(img?.getAttribute('src')).toBe(DATA_URL)
    })
    expect(mockReadDataUrl).toHaveBeenCalledWith(1)
  })

  test('keeps the type icon for an oversized image (no thumbnail read)', async () => {
    renderList([
      att({ id: 2, filename: 'huge.png', size_bytes: 3_000_000, content_type: 'image/png' })
    ])

    expect(await screen.findByText('huge.png')).toBeTruthy()
    expect(mockReadDataUrl).not.toHaveBeenCalled()
    expect(document.querySelector('img')).toBeNull()
  })

  test('persistent download control downloads the attachment', async () => {
    renderList([att({ id: 3, filename: 'doc.pdf', content_type: 'application/pdf' })])

    const btn = await screen.findByRole('button', { name: 'Download attachment' })
    fireEvent.click(btn)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith(3))
  })

  test('preview control opens the image lightbox', async () => {
    renderList([att({ id: 4, filename: 'shot.png', size_bytes: 400, content_type: 'image/png' })])

    const preview = await screen.findByRole('button', { name: 'Preview attachment' })
    fireEvent.click(preview)
    // The shared ImageLightbox renders a modal dialog.
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  test('filters inline + derived rows out of the visible tiles', () => {
    const { container } = renderList([
      att({ id: 5, filename: 'logo.png', is_inline: true, content_type: 'image/png' }),
      att({ id: 6, filename: 'sheet.csv', derived_from: 5, content_type: 'text/csv' })
    ])

    expect(screen.queryByText('logo.png')).toBeNull()
    expect(screen.queryByText('sheet.csv')).toBeNull()
    // Nothing visible → the section bails to null.
    expect(container.querySelector('section[aria-label="attachments"]')).toBeNull()
  })
})
