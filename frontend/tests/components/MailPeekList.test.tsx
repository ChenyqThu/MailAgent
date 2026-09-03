// @vitest-environment happy-dom
//
// 折叠二级栏后 hover 邮件图标浮出的邮箱列表（`layout/peek/MailPeekList`）。
//
// 0903 dogfood E3 复核：owner 要的「自定义文件夹也和收件箱一样显未读数」在这一面
// **已经实现**（行尾走 `folderUnreadCount`），此前看不到数字只是库里恰好零未读。
// 这里把它钉成断言，免得下次「看不见」时又去重做一遍。
//
// 口径本身的五档断言在 `FolderMenu.test.tsx`（同一个 lib/mailboxCounts）；这里只验
// 「浮窗这一面真把计数渲染出来了」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'

import i18n from '../../src/shared/i18n'
import type { FolderInfo, MailboxSummary } from '../../src/shared/api/types'

await i18n.changeLanguage('zh-CN')

const mockGetWhitelist = vi.fn()
const mockDiscover = vi.fn()
const mockGetPrefs = vi.fn()
const mockListMailboxes = vi.fn()
const stableApi = {
  folder: { getWhitelist: mockGetWhitelist, discover: mockDiscover, getPrefs: mockGetPrefs },
  email: { listMailboxes: mockListMailboxes }
}

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableApi
}))

vi.mock('@shared/hooks/usePollingFallback', () => ({
  usePollingFallback: () => false
}))

import MailPeekList from '../../src/shared/components/layout/peek/MailPeekList'

function fi(imap: string, display: string): FolderInfo {
  return {
    imap_name: imap,
    display_name: display,
    delimiter: '/',
    special_use: null,
    is_system: false,
    has_children: false,
    parent: null,
    message_count: null
  }
}

function mb(mailbox: string, counts: { total?: number; unread?: number }): MailboxSummary {
  return {
    mailbox,
    total: counts.total ?? 0,
    unread: counts.unread ?? 0,
    flagged: 0,
    failed: 0
  }
}

function renderPeek(): HTMLElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <MailPeekList onNavigate={() => {}} />
        <Outlet />
      </I18nextProvider>
    )
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] })
  })
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return container
}

/** 某一行行尾的计数文本；该行没有计数时返回 null。 */
function countOf(container: HTMLElement, label: string): string | null {
  const row = Array.from(container.querySelectorAll('button.row')).find(
    (b) => b.querySelector('span.flex-1')?.textContent === label
  )
  if (!row) throw new Error(`row not found: ${label}`)
  return row.querySelector('span.tabular-nums')?.textContent ?? null
}

beforeEach(() => {
  mockGetWhitelist.mockReset()
  mockDiscover.mockReset()
  mockGetPrefs.mockReset()
  mockListMailboxes.mockReset()
  mockGetPrefs.mockResolvedValue({ prefs: [] })
  mockGetWhitelist.mockResolvedValue({ folders: ['Jira', 'Quiet'] })
  mockDiscover.mockResolvedValue({
    folders: [fi('Jira', 'Jira'), fi('Quiet', 'Quiet')].map((f) => ({ ...f, is_synced: true })),
    tree: [],
    whitelist: ['Jira', 'Quiet']
  })
  mockListMailboxes.mockResolvedValue([
    mb('收件箱', { total: 100, unread: 7 }),
    mb('Jira', { total: 80, unread: 9 }),
    mb('Quiet', { total: 12, unread: 0 })
  ])
})
afterEach(() => cleanup())

describe('邮件 peek 浮窗 — 行尾未读数', () => {
  test('自定义文件夹有未读 → 行尾出数字（与收件箱同一面）', async () => {
    const container = renderPeek()
    await waitFor(() => expect(countOf(container, 'Jira')).toBe('9'))
    expect(countOf(container, '收件箱')).toBe('7')
  })

  test('自定义文件夹零未读 → 不画计数（总数 12 不顶上来）', async () => {
    const container = renderPeek()
    // 先等有未读的那行到位，「没有数字」才不是恒绿装饰。
    await waitFor(() => expect(countOf(container, 'Jira')).toBe('9'))
    expect(countOf(container, 'Quiet')).toBeNull()
  })
})
