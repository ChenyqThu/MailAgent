// @vitest-environment happy-dom
//
// 通讯录 WP4 —— 邮件详情头 PersonChip 集成：
//   · flag off → From/To/Cc 维持既有渲染（原始字符串），resolve 一次都不发；
//   · flag on + resolve 就绪 → 在库地址 = pill 按钮（可跳人物页），不在库 = 虚线
//     不可点（不建 stub）；一封邮件恰一次 resolve（归一去重排序的地址集）；
//   · 收件人 > 12 → 折叠为前 12 + 「+n more」展开钮。
// 脚手架照 EmailDetailPin.test.tsx（真 EmailDetail + mock useMailApi）；contacts
// hooks 与 router 另行 mock（NavPersonChip 只在 chips 激活时挂载 —— 无 router 的
// 既有 EmailDetail 测试因此不受影响，这里显式提供 mock）。

import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { emailGetSpy, resolveSpy, navigateSpy, contactsFlag } = vi.hoisted(() => ({
  emailGetSpy: vi.fn(),
  resolveSpy: vi.fn(),
  navigateSpy: vi.fn(),
  contactsFlag: { enabled: true }
}))

function makeEmail(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    internal_id: id,
    message_id: `<msg-${id}@example.com>`,
    thread_id: 'thread-A',
    subject: 'redis timeout',
    sender: 'Alice <alice@x.com>',
    sender_name: '',
    to_addr: 'Bob <bob@y.com>, carol@z.com',
    cc_addr: '',
    date_received: '2026-05-15T09:00:00+08:00',
    mailbox: '收件箱',
    is_read: true,
    is_flagged: false,
    is_important: false,
    sync_status: 'synced',
    notion_page_id: null,
    notion_url: null,
    body_html: '<p>hi</p>',
    body_text: 'hi',
    lang: 'en',
    attachments: [],
    ...overrides
  }
}

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      get: emailGetSpy,
      aiFields: vi.fn(async () => null),
      listByThread: vi.fn(async () => []),
      pin: vi.fn(async () => true),
      listPinnedIds: vi.fn(async () => [] as number[]),
      flag: vi.fn(async () => ({})),
      archive: vi.fn(async () => ({})),
      resync: vi.fn(async () => ({})),
      draft: vi.fn(async () => ({})),
      draftPlan: vi.fn(async () => ({}))
    },
    attachment: { list: vi.fn(async () => []), localPath: vi.fn() },
    ai: {
      translateBatch: vi.fn(),
      abortTranslate: vi.fn(),
      getCached: vi.fn(async () => null),
      deleteCached: vi.fn()
    },
    llm: { run: vi.fn(async () => ({})) },
    calendar: { emailLink: vi.fn(async () => null) }
  })
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateSpy }))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: contactsFlag.enabled, loading: false }),
  useContactsApi: () => ({ resolve: resolveSpy })
}))

import i18n from '@shared/i18n'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { EmailDetail } from '../../src/shared/components/email/EmailDetail'

await i18n.changeLanguage('zh-CN')

function renderDetail(internalId: number): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmailDetail internalId={internalId} />
    </QueryClientProvider>
  ).container
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  contactsFlag.enabled = true
  useContactNavigation.setState({ targetContactId: null })
  emailGetSpy.mockImplementation(async (id: number) => makeEmail(id))
  // 默认：alice 在库、bob/carol 不在库。
  resolveSpy.mockResolvedValue({
    items: {
      'alice@x.com': {
        id: 7,
        display_name: 'Alice Chen',
        formal_name: null,
        kind: 'person',
        primary_email: 'alice@x.com'
      },
      'bob@y.com': null,
      'carol@z.com': null
    }
  })
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: {} })
  }) as unknown as typeof fetch
})

describe('EmailDetail — 通讯录 WP4 互链入口', () => {
  test('flag off：resolve 一次不发，To 行维持原始字符串渲染', async () => {
    contactsFlag.enabled = false
    const c = renderDetail(101)
    await waitFor(() => expect(c.querySelector('[aria-label="inbox-main"]')).not.toBeNull())
    // 原始 ExpandableValue 路径：to_addr 整串直出。
    await waitFor(() => expect(screen.getByText('Bob <bob@y.com>, carol@z.com')).toBeTruthy())
    expect(resolveSpy).not.toHaveBeenCalled()
    expect(screen.queryByTitle('打开 Alice Chen 的人物页')).toBeNull()
  })

  test('flag on：一封一次 resolve（归一去重排序地址集），在库 pill / 不在库虚线', async () => {
    renderDetail(101)
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1))
    expect(resolveSpy).toHaveBeenCalledWith(['alice@x.com', 'bob@y.com', 'carol@z.com'])
    // 在库发件人 → pill 按钮（title = contacts.chip.open 插值）。
    const chip = await screen.findByTitle('打开 Alice Chen 的人物页')
    expect(chip.tagName).toBe('BUTTON')
    // 不在库收件人 → 虚线不可点（title 明说不建占位记录）。
    const dashed = screen.getAllByTitle('这个地址不在通讯录里（不为它建占位记录）')
    expect(dashed.length).toBe(2)
    for (const el of dashed) expect(el.tagName).toBe('SPAN')
  })

  test('点击在库 chip → navigation store 落 target + navigate(/contacts)', async () => {
    renderDetail(101)
    const chip = await screen.findByTitle('打开 Alice Chen 的人物页')
    fireEvent.click(chip)
    expect(useContactNavigation.getState().targetContactId).toBe(7)
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/contacts' })
  })

  test('收件人 > 12 → 折叠为前 12 + 「+n more」，点击展开全部', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `user${i}@x.com`).join(', ')
    emailGetSpy.mockImplementation(async (id: number) => makeEmail(id, { to_addr: many }))
    resolveSpy.mockResolvedValue({
      items: Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [`user${i}@x.com`, null])
      )
    })
    renderDetail(102)
    await waitFor(() => expect(resolveSpy).toHaveBeenCalled())
    await screen.findByText('user0@x.com')
    expect(screen.queryByText('user12@x.com')).toBeNull()
    const moreBtn = screen.getByRole('button', { name: `+2 ${i18n.t('emailDetail.more')}` })
    fireEvent.click(moreBtn)
    expect(screen.getByText('user13@x.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('emailDetail.less') })).toBeTruthy()
  })
})
