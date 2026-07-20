// @vitest-environment happy-dom
//
// Thread attachment strip. Pins the product semantics + the codex review
// hardening:
//   - [collapse] collapsed by default — the count row shows (discoverability),
//     the cards don't, and NO thumbnail read is issued until expanded; the whole
//     header row toggles; switching message re-collapses;
//   - [scope] aggregates the OPEN message + every thread member dated at or
//     before it; a later reply's attachments never appear (and are never even
//     fetched). Unknown-date edges: active date null → keep all (fallback);
//     sibling date null → excluded;
//   - [order] cards run newest message first → oldest last, attachment id
//     ascending within one message;
//   - [marker] the open message's own cards are visually distinguished; past
//     cards keep the neutral treatment;
//   - renders incrementally — the active message's attachments show before a
//     slow sibling's list resolves;
//   - image originals ≤ 1 MB get a real thumbnail; larger images / non-images
//     fall back to a type icon (no data-URL read);
//   - returns null when nothing is in scope;
//   - clicking a card jumps to that message (setActive navTarget);
//   - [H1] "Download all" is disabled until every sibling list settles, then
//     downloads the COMPLETE in-scope set (not the click-moment snapshot); a
//     failed sibling list surfaces an explicit partial warning;
//   - [H2] oversized images warn instead of an unbounded full-file read;
//   - [M4] a failed thumbnail blocks preview; [M5] a null read falls to icon.
//
// NB: the strip is collapsed by default, so any test asserting card content must
// `await expandBar()` first — do NOT flip the default to make tests pass.

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

function member(
  internal_id: number,
  name: string,
  date: string | null = '2026-07-01T00:00:00Z'
): Record<string, unknown> {
  return {
    internal_id,
    thread_id: 'T',
    subject: `msg ${internal_id}`,
    sender: `${name} <${name.toLowerCase()}@x.test>`,
    sender_name: name,
    date_received: date,
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

// baseProps' activeDate is LATER than member()'s default date, so the default
// fixture's siblings are all "past" (in scope).
const baseProps = {
  threadId: 'T',
  activeInternalId: 1,
  activeSenderName: 'Alice',
  activeSender: 'Alice <alice@x.test>',
  activeDate: '2026-07-02T00:00:00Z'
}

const ACTIVE_PDF = att({
  id: 10,
  internal_id: 1,
  filename: 'active.pdf',
  content_type: 'application/pdf'
})

// ── owner's dogfood thread (KL1PR04MB7243… "Omada app 官网 landing page 更新") ──
// Opening 52030 (Karol, 4/23, no attachments of its own) must surface exactly
// the 7 that already existed — 51003's 3 then 49179's 4 — and never the 9 from
// the two later replies.
const REAL_THREAD = [
  { id: 49179, name: 'Lexie', date: '2026-03-19T02:21:00Z', count: 4 },
  { id: 51003, name: 'Lexie', date: '2026-04-10T02:42:00Z', count: 3 },
  { id: 52030, name: 'Karol', date: '2026-04-23T06:09:00Z', count: 0 },
  { id: 53038, name: 'Lexie', date: '2026-05-09T06:11:00Z', count: 4 },
  { id: 54052, name: 'Lexie', date: '2026-05-21T06:31:00Z', count: 5 }
]

function realMembers(): Record<string, unknown>[] {
  return REAL_THREAD.map((m) => member(m.id, m.name, m.date))
}

function realAttsFor(id: number): Record<string, unknown>[] {
  const row = REAL_THREAD.find((m) => m.id === id)
  if (!row) return []
  return Array.from({ length: row.count }, (_, i) =>
    att({
      id: id * 100 + i,
      internal_id: id,
      filename: `m${id}-a${i}.pdf`,
      content_type: 'application/pdf'
    })
  )
}

const OPEN_52030 = {
  threadId: 'T',
  activeInternalId: 52030,
  activeSenderName: 'Karol',
  activeSender: 'Karol <karol@x.test>',
  activeDate: '2026-04-23T06:09:00Z',
  activeAttachments: []
}

function wrap(props: Record<string, unknown>, qc: QueryClient): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ThreadAttachmentBar {...(props as any)} />
    </QueryClientProvider>
  )
}

function renderBar(props: Record<string, unknown>): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(wrap(props, qc))
}

// The header toggle is the only control carrying aria-expanded, so role+expanded
// finds it regardless of the label text / count.
function toggleButton(expanded: boolean): HTMLButtonElement {
  return screen.getByRole('button', { expanded }) as HTMLButtonElement
}

// Collapsed by default — open the strip before asserting card content.
async function expandBar(): Promise<void> {
  const toggle = await screen.findByRole('button', { expanded: false })
  fireEvent.click(toggle)
}

// 2026-07-20：折叠区改走 @shared/components/ui/collapsible 的统一原语（grid-rows
// 高度过渡），正文因此**恒挂载** —— 卸载的子树没法做退场动画。所以「已折叠」的
// 断言口径从「卡片不在 DOM 里」（实现细节）改成「区域被 inert 关掉」：inert 同时
// 管焦点、点击和辅助技术树，是真正的用户可见不变量。
//
// 🔴 折叠必须省下 IPC 而不只是像素 —— 这条不变量**没变**，仍由
// `mockReadDataUrl` / `mockAttList` 的断言各自独立守着，别把它跟这里混为一谈。
function collapsibleRegion(): HTMLElement {
  const id = toggleButton(false).getAttribute('aria-controls')
  const el = id ? document.getElementById(id) : null
  if (!el) throw new Error('collapsible region not found (aria-controls broken?)')
  return el
}

function expectCollapsed(): void {
  const region = collapsibleRegion()
  expect(region.hasAttribute('inert')).toBe(true)
  expect(region.className).toContain('grid-rows-[0fr]')
}

// Card jump buttons carry title={filename}; the two action buttons carry the
// localized Preview / Download labels. Filter those out to read card DOM order.
function cardTitlesInOrder(): string[] {
  return Array.from(document.querySelectorAll('button[title]'))
    .map((b) => b.getAttribute('title') ?? '')
    .filter((tt) => tt !== 'Preview' && tt !== 'Download')
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

describe('ThreadAttachmentBar — collapse', () => {
  test('[collapse] defaults to collapsed: count row shows, cards do not, no thumbnail read', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' })
    ])

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })

    // The count survives collapse — that IS the discoverability signal. It also
    // proves attachment.list still runs while collapsed (1 active + 1 sibling).
    await waitFor(() => expect(toggleButton(false).textContent).toContain('· 2'))
    expect(toggleButton(false).textContent).toContain('Thread attachments')
    expect(mockAttList).toHaveBeenCalledWith(2)

    // 卡片区被 inert 关掉，"Download all" 仍是条件渲染（不在折叠区里）。
    expectCollapsed()
    expect(downloadAllButton()).toBeUndefined()

    // Collapsed must save the IPC, not just the pixels: reply.png is a 500-byte
    // image that WOULD be thumbnailed if expanded.
    expect(mockReadDataUrl).not.toHaveBeenCalled()
  })

  test('[collapse] clicking the header row expands, and only then reads thumbnails', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' })
    ])

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })

    await waitFor(() => expect(toggleButton(false).textContent).toContain('· 2'))
    expect(mockReadDataUrl).not.toHaveBeenCalled()

    await expandBar()

    expect(await screen.findByText('active.pdf')).toBeTruthy()
    expect(await screen.findByText('reply.png')).toBeTruthy()
    expect(toggleButton(true)).toBeTruthy()
    // "Download all" only appears once expanded.
    expect(downloadAllButton()).toBeTruthy()
    await waitFor(() => expect(mockReadDataUrl).toHaveBeenCalledWith(20))
  })

  test('[collapse] collapsing again hides the cards', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([])

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })

    await expandBar()
    expect(await screen.findByText('active.pdf')).toBeTruthy()

    fireEvent.click(toggleButton(true))
    expectCollapsed()
  })

  test('[collapse] switching to another message resets to collapsed', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([])

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const { rerender } = render(wrap({ ...baseProps, activeAttachments: [ACTIVE_PDF] }, qc))

    await expandBar()
    expect(await screen.findByText('active.pdf')).toBeTruthy()

    // Move to another message in the thread — it has its own attachment, so the
    // strip still renders; it must come back collapsed.
    rerender(
      wrap(
        {
          ...baseProps,
          activeInternalId: 2,
          activeDate: '2026-07-03T00:00:00Z',
          activeAttachments: [
            att({ id: 30, internal_id: 2, filename: 'second.pdf', content_type: 'application/pdf' })
          ]
        },
        qc
      )
    )

    expect(toggleButton(false)).toBeTruthy()
    expectCollapsed()
    // 新消息的卡片已换过来（恒挂载），但整区是关的 —— 证明重置的是折叠态,
    // 不是「上一封的 DOM 恰好还没换」。
    expect(cardTitlesInOrder()).toEqual(['second.pdf'])
  })
})

describe('ThreadAttachmentBar — scope + order', () => {
  test('[scope+order] opening a mid-thread message shows only its own + earlier attachments, newest first', async () => {
    mockListByThread.mockResolvedValue(realMembers())
    mockAttList.mockImplementation((id: number) => Promise.resolve(realAttsFor(id)))

    renderBar(OPEN_52030)
    await expandBar()

    // 51003's 3 + 49179's 4 = 7 — NOT 16. The two later replies contribute none.
    await waitFor(() => expect(cardTitlesInOrder()).toHaveLength(7))
    // Newest in-scope message (4/10) leftmost, oldest (3/19) rightmost; within a
    // message, attachment id ascending.
    expect(cardTitlesInOrder()).toEqual([
      'm51003-a0.pdf',
      'm51003-a1.pdf',
      'm51003-a2.pdf',
      'm49179-a0.pdf',
      'm49179-a1.pdf',
      'm49179-a2.pdf',
      'm49179-a3.pdf'
    ])
    // Future replies are filtered at the id level — never even probed.
    expect(mockAttList).not.toHaveBeenCalledWith(53038)
    expect(mockAttList).not.toHaveBeenCalledWith(54052)
  })

  test('[scope] download-all saves only the open message + earlier attachments', async () => {
    mockListByThread.mockResolvedValue(realMembers())
    mockAttList.mockImplementation((id: number) => Promise.resolve(realAttsFor(id)))

    renderBar(OPEN_52030)
    await expandBar()

    await waitFor(() => expect(cardTitlesInOrder()).toHaveLength(7))
    await waitFor(() => expect(downloadAllButton().disabled).toBe(false))
    fireEvent.click(downloadAllButton())

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(7))
    const saved = (mockDownload.mock.calls.map((c) => c[0]) as number[]).sort((a, b) => a - b)
    // 49179's 4 + 51003's 3 only — nothing from 53038 / 54052.
    expect(saved).toEqual([4917900, 4917901, 4917902, 4917903, 5100300, 5100301, 5100302])
  })

  test('[scope] a sibling with no date is excluded (cannot be placed in time)', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob', null)])
    mockAttList.mockResolvedValue([att({ id: 20, filename: 'undated.pdf' })])

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })
    await expandBar()

    await screen.findByText('active.pdf')
    expect(screen.queryByText('undated.pdf')).toBeNull()
    expect(mockAttList).not.toHaveBeenCalledWith(2)
  })

  test('[scope] unknown active date keeps every sibling (fallback)', async () => {
    // Bob is dated far in the future; with no active date we cannot order the
    // thread at all, so we keep everything rather than blank the strip.
    mockListByThread.mockResolvedValue([
      member(1, 'Alice'),
      member(2, 'Bob', '2027-01-01T00:00:00Z')
    ])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'future.pdf', content_type: 'application/pdf' })
    ])

    renderBar({ ...baseProps, activeDate: null, activeAttachments: [] })
    await expandBar()

    expect(await screen.findByText('future.pdf')).toBeTruthy()
  })

  test("[marker] the open message's own cards are distinguished; past cards are not", async () => {
    mockListByThread.mockResolvedValue([
      member(1, 'Alice', '2026-04-23T06:09:00Z'),
      member(2, 'Bob', '2026-03-19T02:21:00Z')
    ])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'old.pdf', content_type: 'application/pdf' })
    ])

    renderBar({
      ...baseProps,
      activeDate: '2026-04-23T06:09:00Z',
      activeAttachments: [ACTIVE_PDF]
    })
    await expandBar()

    const mine = await screen.findByTitle('active.pdf')
    const old = await screen.findByTitle('old.pdf')

    // Marker label rides only the open message's card.
    expect(screen.getAllByText('This message')).toHaveLength(1)
    // Accent border only on the open message's card; past card keeps neutral.
    expect(mine.parentElement?.className).toContain('border-coral')
    expect(old.parentElement?.className).not.toContain('border-coral')
    expect(old.parentElement?.className).toContain('border-ink-border')
    // The past card still labels its own source.
    expect(screen.getByText(/Bob/)).toBeTruthy()
  })
})

describe('ThreadAttachmentBar', () => {
  test('aggregates the open message + earlier replies, filters inline + derived, thumbnails small images', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' }),
      att({ id: 21, filename: 'signature.png', is_inline: true, content_type: 'image/png' }),
      att({ id: 22, filename: 'sheet.csv', derived_from: 20, content_type: 'text/csv' })
    ])

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })
    await expandBar()

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

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })
    await expandBar()

    expect(await screen.findByText('active.pdf')).toBeTruthy()
  })

  test('large image falls back to a type icon (no thumbnail read)', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 30, filename: 'huge.png', size_bytes: 3 * MB, content_type: 'image/png' })
    ])

    renderBar({ ...baseProps, activeAttachments: [] })
    await expandBar()

    expect(await screen.findByText('huge.png')).toBeTruthy()
    expect(mockReadDataUrl).not.toHaveBeenCalled()
    expect(document.querySelector('img')).toBeNull()
  })

  test('returns null when nothing is in scope', async () => {
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
    await expandBar()

    const card = await screen.findByTitle('reply.png')
    fireEvent.click(card)
    expect(useActiveEmail.getState().activeInternalId).toBe(2)
    expect(useActiveEmail.getState().navTargetId).toBe(2)
  })

  test('[H1] download-all stays disabled until every sibling list settles', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockReturnValue(new Promise(() => {})) // never settles

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })
    await expandBar()

    await screen.findByText('active.pdf')
    expect(downloadAllButton().disabled).toBe(true)
  })

  test('[H1] download-all downloads active + every in-scope sibling attachment', async () => {
    mockListByThread.mockResolvedValue([member(1, 'Alice'), member(2, 'Bob')])
    mockAttList.mockResolvedValue([
      att({ id: 20, filename: 'reply.png', size_bytes: 500, content_type: 'image/png' })
    ])

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })
    await expandBar()

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

    renderBar({ ...baseProps, activeAttachments: [ACTIVE_PDF] })
    await expandBar()

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
    await expandBar()

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
    await expandBar()

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
    await expandBar()

    expect(await screen.findByText('ghost.png')).toBeTruthy()
    await waitFor(() => expect(mockReadDataUrl).toHaveBeenCalledWith(10))
    expect(document.querySelector('img')).toBeNull()
  })
})
