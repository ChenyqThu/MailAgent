// @vitest-environment happy-dom
//
// 通讯录 WP4 —— ⌘K「人」组 + 「打开通讯录」导航命令 + contact scope：
//   · flag gate：off 时 jump 行 / 人组 / contact scope chip 全不渲染、list 零请求；
//   · hasQuery gate：空 query 不发 contacts.list；
//   · 数据路径：view='all' + limit=16 + 客户端滤 hidden + 展示 8 条 + 「另有 n 人」；
//   · 激活：点击行 = 关面板 + navigation store 落 target + navigate('/contacts')；
//   · scope：'contact' 档只看人组（Email 组隐藏）。
// mock 形状照 CommandPalette.test.tsx；contacts/matters hooks 另行钉住。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useCommandPalette } from '@shared/state/command-palette'

const {
  mockSearch,
  mockListMailboxes,
  mockContactsList,
  mockNavigate,
  contactsFlag
} = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockListMailboxes: vi.fn(),
  mockContactsList: vi.fn(),
  mockNavigate: vi.fn(),
  contactsFlag: { enabled: true }
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      search: mockSearch,
      listMailboxes: mockListMailboxes,
      flag: vi.fn(),
      nlToDsl: vi.fn(),
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
    llm: { run: vi.fn(), stats: vi.fn(), selftest: vi.fn() },
    attachment: { list: vi.fn(), localPath: vi.fn(), readDataUrl: vi.fn() },
    ai: { translate: vi.fn(), abortTranslate: vi.fn() },
    chat: {}
  })
}))

vi.mock('@shared/assistant/searchAgentClient', () => ({
  runGatewaySearchAgent: vi.fn(async () => ({ ok: true, hits: [], summary: null }))
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({
    list: vi.fn(async () => ({ items: [] })),
    lookupResourceLinks: vi.fn(async () => ({ results: {} }))
  }),
  useMattersEnabled: () => false
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: contactsFlag.enabled, loading: false }),
  useContactsApi: () => ({ list: mockContactsList })
}))

import i18n from '@shared/i18n'
import { useContactNavigation } from '@shared/components/contacts/navigation'
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

function contactRow(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    display_name: name,
    name_en: null,
    organization: 'ACME',
    department: null,
    role_title: null,
    function: null,
    seniority: null,
    kind: 'person',
    hidden_at: null,
    is_self: false,
    mail_count: 10,
    sent_to_count: 3,
    first_seen_at: null,
    last_seen_at: null,
    email_count: 1,
    primary_email: `p${id}@x.com`,
    profile_summary: null,
    ...overrides
  }
}

async function typeQuery(value: string): Promise<void> {
  const input = await screen.findByRole('combobox')
  fireEvent.change(input, { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  contactsFlag.enabled = true
  useCommandPalette.getState().setOpen(false)
  useContactNavigation.setState({ targetContactId: null })
  mockListMailboxes.mockResolvedValue([
    { mailbox: '收件箱', total: 100, unread: 5, flagged: 2, failed: 0 }
  ])
  mockSearch.mockResolvedValue({ items: [], total_indexed: 1247 })
  mockContactsList.mockResolvedValue({ items: [contactRow(3, 'Alice Chen')], total: 1 })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useCommandPalette.getState().setOpen(false)
})

describe('CommandPalette — 通讯录 WP4「人」组', () => {
  test('输入 query → contacts.list(view=all, limit=16)，人组渲染命中行', async () => {
    openPalette()
    renderPalette()
    await typeQuery('ali')
    await waitFor(() =>
      expect(mockContactsList).toHaveBeenCalledWith({
        view: 'all',
        q: 'ali',
        sort: 'density',
        limit: 16
      })
    )
    // 命中词高亮会把名字拆成 <mark>Ali</mark>ce Chen（accessible name 变成
    // "Ali ce Chen"）—— 行定位一律用**不参与高亮**的副行文本（org · 主邮箱）。
    await screen.findByText('ACME · p3@x.com')
  })

  test('空 query 不发 contacts.list（hasQuery gate）', async () => {
    openPalette()
    renderPalette()
    await screen.findByRole('combobox')
    await waitFor(() => expect(mockListMailboxes).toHaveBeenCalled())
    expect(mockContactsList).not.toHaveBeenCalled()
  })

  test('hidden 行客户端滤除，且计入「另有 n 人」overflow', async () => {
    mockContactsList.mockResolvedValue({
      items: [contactRow(3, 'Alice Chen'), contactRow(4, 'Ghost Hu', { hidden_at: 123 })],
      total: 2
    })
    openPalette()
    renderPalette()
    await typeQuery('team')
    await screen.findByText('ACME · p3@x.com')
    expect(screen.queryByText('ACME · p4@x.com')).toBeNull()
    // total=2，展示 1 → 另有 1 人命中。
    expect(screen.getByText('另有 1 人命中')).toBeTruthy()
  })

  test('点击命中行 → 关面板 + navigation store 落 target + navigate(/contacts)', async () => {
    openPalette()
    renderPalette()
    await typeQuery('ali')
    const sub = await screen.findByText('ACME · p3@x.com')
    const row = sub.closest('li')
    expect(row).not.toBeNull()
    fireEvent.click(row as HTMLElement)
    expect(useContactNavigation.getState().targetContactId).toBe(3)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/contacts' })
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test('jump 组有「打开通讯录」静态行，点击直达 /contacts', async () => {
    openPalette()
    renderPalette()
    const row = await screen.findByText('打开通讯录')
    fireEvent.click(row.closest('li') ?? row)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/contacts' })
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test("scope 'contact'：只看人组，Email 组隐藏", async () => {
    openPalette()
    renderPalette()
    await typeQuery('ali')
    await screen.findByText('ACME · p3@x.com')
    // Email 组头此时在（空态 tile 也有组头）。
    expect(screen.getByText('Email')).toBeTruthy()
    const chip = screen.getByRole('button', { name: /联系人/ })
    fireEvent.click(chip)
    await waitFor(() => expect(screen.queryByText('Email')).toBeNull())
    expect(screen.getByText('ACME · p3@x.com')).toBeTruthy()
  })

  test('flag off：jump 行 / 人组 / contact scope chip 全不渲染，list 零请求', async () => {
    contactsFlag.enabled = false
    openPalette()
    renderPalette()
    await typeQuery('ali')
    // Email 组照常出现（等 debounce + search settle）。
    await waitFor(() => expect(screen.getByText('Email')).toBeTruthy())
    expect(mockContactsList).not.toHaveBeenCalled()
    expect(screen.queryByText('打开通讯录')).toBeNull()
    expect(screen.queryByText('ACME · p3@x.com')).toBeNull()
    // matters off + contacts off → scope chips 行整个不渲染（回改动前形状）。
    expect(screen.queryByRole('button', { name: /联系人/ })).toBeNull()
  })
})
