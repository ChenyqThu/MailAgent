// @vitest-environment happy-dom
//
// Search-module 1:1 mockup-search.html — CommandPalette integration TDD.
//
// The palette is the sole search entry point (mockup-search.html §design
// intent) so the test surface has to cover:
//   1. Rendering — 3 group headers (Jump / Email / AI Actions) appear in
//      the right shape; empty / loading variants land on the right
//      empty-tile copy.
//   2. Query path — raw query passed to backend verbatim (CJK transform unified server-side, T3);
//      FTS5 operators bypass wildcard injection.
//   3. Keyboard nav — ↑↓ flat-index, Tab/Shift-Tab group hop, Enter run,
//      Esc dismiss.
//   4. Wired AI actions — markAllRead fires `mailApi.email.flag` batch;
//      reRunAi fires `mailApi.llm.run` for each hit; summarize is
//      disabled with a Soon pill.
//   5. Open behaviour — query starts empty on each open (no prefill).
//
// Everything is mocked; the real palette mounts inside a QueryClient host
// + a RouterProvider stub (useNavigate is the only router API we touch).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useCommandPalette } from '@shared/state/command-palette'

const {
  mockSearch,
  mockListMailboxes,
  mockFlag,
  mockLlmRun,
  mockSetActive,
  mockSetMailbox,
  mockNavigate
} = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockListMailboxes: vi.fn(),
  mockFlag: vi.fn(),
  mockLlmRun: vi.fn(),
  mockSetActive: vi.fn(),
  mockSetMailbox: vi.fn(),
  mockNavigate: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      search: mockSearch,
      listMailboxes: mockListMailboxes,
      flag: mockFlag,
      list: vi.fn(),
      listEnriched: vi.fn(),
      listByThread: vi.fn(),
      get: vi.fn(),
      body: vi.fn(),
      aiFields: vi.fn(),
      resync: vi.fn(),
      createDraft: vi.fn(),
      pin: vi.fn(),
      listPinnedIds: vi.fn()
    },
    llm: { run: mockLlmRun, stats: vi.fn(), selftest: vi.fn() },
    attachment: { list: vi.fn(), localPath: vi.fn(), readDataUrl: vi.fn() },
    ai: { translate: vi.fn(), abortTranslate: vi.fn() }
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

vi.mock('@shared/state/mailbox', async () => {
  type AnyState = { active: string; setActive: (next: string) => void }
  const state: AnyState = { active: '收件箱', setActive: mockSetMailbox }
  function useMailbox<T = AnyState>(selector?: (s: AnyState) => T): T {
    if (selector) return selector(state)
    return state as unknown as T
  }
  useMailbox.getState = (): AnyState => state
  return { useMailbox }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

import i18n from '@shared/i18n'
import { CommandPalette } from '@shared/components/command/CommandPalette'

await i18n.changeLanguage('zh-CN')

function renderPalette(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <CommandPalette />
    </QueryClientProvider>
  )
}

function openPalette(): void {
  useCommandPalette.getState().setOpen(true)
}

const SAMPLE_HITS = [
  {
    internal_id: 101,
    subject: 'redis timeout debug session',
    sender: 'Alice <alice@example.com>',
    date_received: '2026-05-15T09:00:00+08:00',
    mailbox: '收件箱',
    rank: -1.8,
    snippet: 'Hey, the <mark>redis</mark> client keeps timing out after 5s.',
    notion_page_id: null,
    notion_url: null,
    ai_priority: 'critical' as const,
    lang: 'en' as const
  },
  {
    internal_id: 102,
    subject: '本周产品评审',
    sender: 'Lucien <ge@chenge.ink>',
    date_received: '2026-05-13T10:00:00+08:00',
    mailbox: '收件箱',
    rank: -1.2,
    snippet: '本周 <mark>产品</mark> 评审排期…',
    notion_page_id: null,
    notion_url: null,
    ai_priority: 'important' as const,
    lang: 'zh' as const
  }
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  try {
    localStorage.clear()
  } catch {
    /* noop */
  }
  useCommandPalette.getState().setOpen(false)
  mockListMailboxes.mockResolvedValue([
    { mailbox: '收件箱', total: 100, unread: 5, flagged: 2, failed: 0 },
    { mailbox: '发件箱', total: 50, unread: 0, flagged: 0, failed: 0 }
  ])
  // Default — empty results so blank-state tests see no hits / no actions.
  mockSearch.mockResolvedValue({ items: [], total_indexed: 1247 })
})

afterEach(() => {
  cleanup()
  useCommandPalette.getState().setOpen(false)
})

describe('CommandPalette — rendering', () => {
  test('open=false renders nothing', () => {
    const { container } = renderPalette()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  test('open=true renders dialog with input + Jump group', async () => {
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('dialog'))
    expect(screen.getByRole('combobox')).toBeTruthy()
    // Jump group header (ASCII per DESIGN.md §14 — mono CJK ban).
    await waitFor(() => screen.getByText('Jump'))
    // Mailbox row appears (mailboxes resolved by mocked listMailboxes).
    await waitFor(() => screen.getByText('收件箱'))
  })

  test('blank query renders Jump only (no Email / AI Actions groups)', async () => {
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByText('Jump'))
    expect(screen.queryByText('Email')).toBeNull()
    expect(screen.queryByText('AI Actions')).toBeNull()
  })
})

describe('CommandPalette — query normalisation', () => {
  test('English query passes through verbatim', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'redis' }))
    )
  })

  test('CJK query is passed through verbatim (backend unifies transform, T3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '产品' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '产品' }))
    )
  })

  test('FTS5 operators bypass the wildcard injection', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis AND 产品' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'redis AND 产品' }))
    )
  })
})

describe('CommandPalette — email hits + AI Actions', () => {
  test('hits render priority chip + lang-pip + Email group header', async () => {
    // `shouldAdvanceTime: true` is the right pattern — it advances both
    // mocked timeouts AND background ticks so React-query microtasks
    // resolve. Pure real-timers stalls on the debounce; pure fake-timers
    // stalls on the promise queue.
    mockSearch.mockResolvedValue({ items: SAMPLE_HITS, total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('Email'))
    // Subject "redis timeout debug session" is wrapped by highlightTerms
    // into `<mark>redis</mark> timeout debug session` — text nodes split
    // by <mark>. Match the suffix that lands in a single text node.
    await waitFor(() => screen.getByText(/timeout debug session/))
    expect(screen.getByText('CRITICAL')).toBeTruthy()
    expect(screen.getByText('IMPORTANT')).toBeTruthy()
    // lang-pip — only the English hit shows it (per EmailRow / mockup convention).
    expect(screen.getAllByText('EN').length).toBeGreaterThan(0)
    // Snippet <mark> survives the DOMPurify pass.
    expect(document.querySelector('mark')).toBeTruthy()
  })

  test('attachment-source hit renders paperclip badge + filename (P1b)', async () => {
    const attachmentHit = {
      internal_id: 201,
      subject: 'Contract bundle',
      sender: 'Bob <bob@example.com>',
      date_received: '2026-05-14T09:00:00+08:00',
      mailbox: '收件箱',
      rank: -0.5,
      snippet: 'the <mark>contract</mark> clause lives in the appendix',
      notion_page_id: null,
      notion_url: null,
      ai_priority: null,
      lang: null,
      source: 'attachment' as const,
      filename: 'evidence.txt'
    }
    mockSearch.mockResolvedValue({ items: [attachmentHit], total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'contract' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('Email'))
    // 附件徽标显示文件名 — source='attachment' 时才渲染。
    expect(screen.getByText('evidence.txt')).toBeTruthy()
    // 徽标容器本身渲染 (aria-label = i18n palette.email.fromAttachment, zh-CN):
    // 证明的是「附件来源徽标」而非任意文本碰巧含文件名。回形针 <svg> 在内。
    const badge = screen.getByLabelText('命中附件 evidence.txt')
    expect(badge).toBeTruthy()
    expect(badge.querySelector('svg')).toBeTruthy()
  })

  test('body-source hit does NOT render an attachment filename badge (P1b)', async () => {
    mockSearch.mockResolvedValue({ items: SAMPLE_HITS, total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText(/timeout debug session/))
    // SAMPLE_HITS 都是 body 命中 (无 source 字段) → 无附件名徽标。
    expect(screen.queryByText('evidence.txt')).toBeNull()
  })

  test('renders many hits (>8) inside a scrollable listbox (P1b: more results + scroll)', async () => {
    // P1b 把 MAX_EMAIL_HITS 8→50。验证: 30 条命中全部进 DOM (旧上限 8 会截断),
    // 且结果容器是 overflow-y-auto (多结果在列表内滚动而非撑爆 pane)。
    const many = Array.from({ length: 30 }, (_, i) => ({
      internal_id: 1000 + i,
      subject: `bulk match row ${i}`,
      sender: `User${i} <user${i}@example.com>`,
      date_received: '2026-05-15T09:00:00+08:00',
      mailbox: '收件箱',
      rank: -1 - i * 0.01,
      snippet: `row ${i} <mark>bulk</mark> body`,
      notion_page_id: null,
      notion_url: null,
      ai_priority: null,
      lang: null
    }))
    mockSearch.mockResolvedValue({ items: many, total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bulk' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('Email'))
    // subject 经 highlightTerms 把 query 词 `bulk` 包成 <mark>, 文本节点被拆分;
    // 匹配后缀 `match row N` (落在单个文本节点) 而非整串。第 1 与第 30 条都在
    // DOM → 没有被旧的 8 条上限截断。
    await waitFor(() => screen.getByText(/match row 0$/))
    expect(screen.getByText(/match row 29$/)).toBeTruthy()
    // 结果列表是可滚动容器。
    const listbox = document.getElementById('palette-listbox')
    expect(listbox?.className).toContain('overflow-y-auto')
    // 邮件命中行数 = 30 (data-flat-idx 行里属于 email 组的)。
    const emailRows = Array.from(
      document.querySelectorAll('[role="option"][data-flat-idx]')
    ).filter((r) => /match row \d/.test(r.textContent ?? ''))
    expect(emailRows.length).toBe(30)
  })

  test('0 hits → empty tile + AI Actions hidden', async () => {
    mockSearch.mockResolvedValue({ items: [], total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'nothingmatches' }
    })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('未找到匹配的邮件'))
    expect(screen.queryByText('AI Actions')).toBeNull()
  })

  test('AI Actions render only when hits.length > 0; summarize is disabled with Soon pill', async () => {
    mockSearch.mockResolvedValue({ items: SAMPLE_HITS, total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('AI Actions'))
    expect(screen.getByText('全部标为已读')).toBeTruthy()
    expect(screen.getByText('重跑 AI 分类')).toBeTruthy()
    expect(screen.getByText('为本结果集起草摘要')).toBeTruthy()
    expect(screen.getByText('即将上线')).toBeTruthy()
  })
})

describe('CommandPalette — interactions', () => {
  test('Enter on email hit → setActive + navigate("/") + closes', async () => {
    mockSearch.mockResolvedValue({ items: SAMPLE_HITS, total_indexed: 1247 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    // Hit row text is split by `<mark>` — query the snippet suffix instead.
    await waitFor(() => screen.getByText(/timeout debug session/))
    // Click the option element (the whole row) rather than the subject
    // text node so the click handler on the <li role=option> fires.
    const rows = document.querySelectorAll('[role="option"][data-flat-idx]')
    const emailRow = Array.from(rows).find((r) =>
      r.textContent?.includes('timeout debug session')
    ) as HTMLElement | undefined
    expect(emailRow).toBeTruthy()
    fireEvent.click(emailRow!)
    // navTarget:true — 搜索跳转标记导航目标, EmailList active-reset 据此豁免,
    // 让目标即使不在当前列表也能打开(Bug#2 修复)。
    expect(mockSetActive).toHaveBeenCalledWith(101, { navTarget: true })
    // navigate now carries the inferred view so EmailList lands on the
    // mailbox that contains the hit (mockup row 101 is in '收件箱' → 'inbox').
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/', search: { view: 'inbox' } })
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test('Click mailbox jump → setMailbox + navigate("/") + closes', async () => {
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByText('收件箱'))
    fireEvent.click(screen.getByText('收件箱'))
    expect(mockSetMailbox).toHaveBeenCalledWith('收件箱')
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test('Click "全部标为已读" fires mailApi.email.flag batch with hit ids', async () => {
    mockSearch.mockResolvedValue({ items: SAMPLE_HITS, total_indexed: 1247 })
    mockFlag.mockResolvedValue({})
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('全部标为已读'))
    fireEvent.click(screen.getByText('全部标为已读'))
    await waitFor(() =>
      expect(mockFlag).toHaveBeenCalledWith(null, {
        ids: [101, 102],
        isRead: true,
        allowConcurrent: true
      })
    )
  })

  test('Click "重跑 AI 分类" fires mailApi.llm.run per hit with force=true', async () => {
    mockSearch.mockResolvedValue({ items: SAMPLE_HITS, total_indexed: 1247 })
    mockLlmRun.mockResolvedValue({})
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openPalette()
    renderPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'redis' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => screen.getByText('重跑 AI 分类'))
    fireEvent.click(screen.getByText('重跑 AI 分类'))
    await waitFor(() => {
      expect(mockLlmRun).toHaveBeenCalledTimes(2)
      expect(mockLlmRun).toHaveBeenNthCalledWith(1, 101, { force: true })
      expect(mockLlmRun).toHaveBeenNthCalledWith(2, 102, { force: true })
    })
  })

  test('Veil click closes the palette', async () => {
    openPalette()
    const { container } = renderPalette()
    await waitFor(() => screen.getByRole('dialog'))
    const veil = container.parentElement?.querySelector('.palette-veil')
    expect(veil).toBeTruthy()
    fireEvent.click(veil as Element)
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test('Escape closes the palette', async () => {
    openPalette()
    renderPalette()
    const dialog = await waitFor(() => screen.getByRole('dialog'))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(useCommandPalette.getState().open).toBe(false)
  })
})

describe('CommandPalette — open behaviour', () => {
  test('query starts empty on open (no last-session prefill)', async () => {
    // Even if a stale last-session value lingers in localStorage, each open
    // must start from an empty query — the palette is a fresh search every
    // time. (Pre-seeding is best-effort; some happy-dom setups stub
    // localStorage differently. The component never reads it anyway.)
    try {
      window.localStorage.setItem('mailagent.search.lastQuery', 'project')
    } catch {
      /* storage not available in this env — irrelevant, component never reads it */
    }

    openPalette()
    renderPalette()
    await waitFor(() => {
      const input = screen.getByRole('combobox') as HTMLInputElement
      expect(input.value).toBe('')
    })
  })
})
