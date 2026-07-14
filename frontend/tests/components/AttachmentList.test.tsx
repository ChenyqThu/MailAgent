// @vitest-environment happy-dom
//
// Per-message attachment grid. Pins the discoverability upgrades + the codex
// review hardening:
//   - image originals ≤ 1 MB render a real thumbnail; larger images / non-image
//     files keep the type icon (no data-URL read);
//   - the download control is persistent (not hover-only) and downloads;
//   - the preview control opens the shared image lightbox;
//   - [H2] oversized / unknown-size images do NOT read full bytes — preview
//     shows a "too large, download instead" notice, no lightbox;
//   - [M4] a thumbnail that fails to decode blocks preview (no broken lightbox);
//   - [M5] readDataUrl → null is a retryable error, not a stuck success; the
//     tile falls back to its type icon and doesn't crash;
//   - [M6] the tile is a non-interactive <div>; preview / download / derived
//     controls are real, non-nested <button>s;
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
const MB = 1024 * 1024

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
      att({ id: 2, filename: 'huge.png', size_bytes: 3 * MB, content_type: 'image/png' })
    ])

    expect(await screen.findByText('huge.png')).toBeTruthy()
    expect(mockReadDataUrl).not.toHaveBeenCalled()
    expect(document.querySelector('img')).toBeNull()
  })

  test('persistent download control downloads the attachment', async () => {
    renderList([att({ id: 3, filename: 'doc.pdf', content_type: 'application/pdf' })])

    const btn = await screen.findByRole('button', { name: 'Download' })
    fireEvent.click(btn)
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith(3))
  })

  test('preview control opens the image lightbox', async () => {
    renderList([att({ id: 4, filename: 'shot.png', size_bytes: 400, content_type: 'image/png' })])

    const preview = await screen.findByRole('button', { name: 'Preview' })
    fireEvent.click(preview)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  test('[H2] oversized image: preview shows a too-large notice, no lightbox / read', async () => {
    renderList([
      att({ id: 5, filename: 'raw.png', size_bytes: 30 * MB, content_type: 'image/png' })
    ])

    const preview = await screen.findByRole('button', { name: 'Preview' })
    fireEvent.click(preview)

    expect(await screen.findByText('File too large to preview — download instead.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    // No full-file read was ever issued for the huge image.
    expect(mockReadDataUrl).not.toHaveBeenCalled()
  })

  test('[M4] a thumbnail that fails to decode blocks preview', async () => {
    renderList([att({ id: 6, filename: 'bad.png', size_bytes: 400, content_type: 'image/png' })])

    // Decorative thumbnails use alt="" (role presentation), so query the DOM.
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    fireEvent.error(document.querySelector('img') as HTMLImageElement)

    const preview = await screen.findByRole('button', { name: 'Preview' })
    fireEvent.click(preview)

    expect(await screen.findByText("Couldn't load preview.")).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('[M3] caps eager thumbnail reads at the render limit', async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      att({ id: 100 + i, filename: `img${i}.png`, size_bytes: 400, content_type: 'image/png' })
    )
    renderList(many)

    expect(await screen.findByText('img14.png')).toBeTruthy()
    // All 15 tiles render, but only the first THUMBNAIL_RENDER_LIMIT (12) are
    // read eagerly — the rest keep the icon until the user previews them.
    await waitFor(() => expect(mockReadDataUrl.mock.calls.length).toBeGreaterThanOrEqual(12))
    expect(mockReadDataUrl.mock.calls.length).toBe(12)
  })

  test('[M4] lightbox surfaces a dismissable error when the image fails to decode', async () => {
    renderList([att({ id: 11, filename: 'shot.png', size_bytes: 400, content_type: 'image/png' })])

    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog')
    const lightboxImg = dialog.querySelector('img') as HTMLImageElement
    expect(lightboxImg).not.toBeNull()

    fireEvent.error(lightboxImg)
    expect(await screen.findByText("Couldn't load image.")).toBeTruthy()
  })

  test('[M5] readDataUrl null falls back to the icon without crashing', async () => {
    mockReadDataUrl.mockResolvedValue(null)
    renderList([att({ id: 7, filename: 'ghost.png', size_bytes: 400, content_type: 'image/png' })])

    expect(await screen.findByText('ghost.png')).toBeTruthy()
    await waitFor(() => expect(mockReadDataUrl).toHaveBeenCalledWith(7))
    // Null read → no thumbnail, type icon instead. No broken <img>.
    expect(document.querySelector('img')).toBeNull()
  })

  test('[M6] tile is a non-interactive div; actions are real buttons', async () => {
    renderList([att({ id: 8, filename: 'plan.pdf', content_type: 'application/pdf' })])

    const filename = await screen.findByText('plan.pdf')
    // The filename text is NOT inside a button — no whole-card click / no nested
    // interactive elements.
    expect(filename.closest('button')).toBeNull()
    // Download is a real, standalone button.
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  test('filters inline + derived rows out of the visible tiles', () => {
    const { container } = renderList([
      att({ id: 9, filename: 'logo.png', is_inline: true, content_type: 'image/png' }),
      att({ id: 10, filename: 'sheet.csv', derived_from: 9, content_type: 'text/csv' })
    ])

    expect(screen.queryByText('logo.png')).toBeNull()
    expect(screen.queryByText('sheet.csv')).toBeNull()
    expect(container.querySelector('section[aria-label="attachments"]')).toBeNull()
  })
})
