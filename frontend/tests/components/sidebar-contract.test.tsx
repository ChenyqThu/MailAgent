// @vitest-environment happy-dom
//
// Sprint 11 V1.4 — Sidebar contract test enforces DESIGN.md §2.11 lint
// rules at render time. Cheaper + safer than a custom ESLint AST rule:
//
//   1. exactly one [data-app-nav] root
//   2. exactly three .app-nav-section-header elements
//   3. at most one .row-selected inside the shell
//   4. no <a href="#"> inside .app-nav-bottom
//   5. exactly 12 nav rows (4 MAILBOXES + 3 AI AGENTS + 3 VIEW + 2 bottom)
//      P6: removed archive + drafts rows (old folder_email viewer deleted)
//   6. AI 会话历史 row renders as a disabled <div> (DESIGN.md §9.4)

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

// `useMailApi` ships a real ElectronApi by default — that talks to
// window.electron which doesn't exist under happy-dom. Stub the surface
// the Sidebar actually touches: settings.get + email.listMailboxes.
// Must use the @shared alias here — Vitest resolves the import string
// before applying tsconfig paths, so a relative path silently fails to
// match the import in Sidebar.tsx.
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: {
      get: vi.fn().mockResolvedValue({
        dbPath: null,
        attachmentDir: null,
        pollIntervalSec: 5,
        notionAgentPageId: 'agent-page-id',
        notionAgentName: 'lucien.chen@tp-link.com',
        customApiEndpoint: null
      })
    },
    email: {
      listMailboxes: vi.fn().mockResolvedValue([
        { mailbox: '收件箱', total: 12, unread: 3, flagged: 1, failed: 0 },
        { mailbox: '发件箱', total: 4, unread: 0, flagged: 0, failed: 0 }
      ])
    }
  })
}))

// Importing after the mock is registered.
import { Sidebar } from '../../src/shared/components/layout/Sidebar'

function makeWrappedRouter(): ReturnType<typeof createRouter> {
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <Sidebar />
        <Outlet />
      </I18nextProvider>
    )
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null
  })
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] })
  })
}

async function renderSidebar(): Promise<HTMLElement> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const router = makeWrappedRouter()
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  // RouterProvider has an async initial-render dance; wait for the shell
  // to mount before any DOM assertion runs.
  await waitFor(() => {
    expect(container.querySelector('[data-app-nav]')).toBeTruthy()
  })
  return container
}

describe('Sidebar §2.11 contract', () => {
  afterEach(() => cleanup())

  test('exactly one [data-app-nav] root', async () => {
    const container = await renderSidebar()
    expect(container.querySelectorAll('[data-app-nav]')).toHaveLength(1)
  })

  test('exactly 3 .app-nav-section-header elements (MAILBOXES / AI AGENTS / VIEW)', async () => {
    const container = await renderSidebar()
    expect(container.querySelectorAll('.app-nav-section-header')).toHaveLength(3)
  })

  test('at most 1 .row-selected inside the shell', async () => {
    const container = await renderSidebar()
    const shell = container.querySelector('[data-app-nav]')
    expect(shell).toBeTruthy()
    expect(shell!.querySelectorAll('.row-selected').length).toBeLessThanOrEqual(1)
  })

  test('app-nav-bottom contains no <a href="#"> dead anchors', async () => {
    const container = await renderSidebar()
    const bottomDeadAnchors = container.querySelectorAll('.app-nav-bottom a[href="#"]')
    expect(bottomDeadAnchors).toHaveLength(0)
  })

  test('exactly 12 nav rows (4 + 3 + 3 + 2)', async () => {
    // MAILBOXES: 收件箱, 发件箱, 已标旗, 所有邮件 (4)
    // AI AGENTS: 3; VIEW: 3; bottom: 2
    const container = await renderSidebar()
    const allRows = container.querySelectorAll('[data-app-nav] .row')
    expect(allRows).toHaveLength(12)
  })

  test('AI 会话历史 row renders enabled (Sprint 18 review — 不再灰禁)', async () => {
    // DESIGN.md §9.4 原设计该 row disabled; Sprint 18 用户反馈改成视觉可用态
    // (onClick noop, 等会话历史 ship 再接跳转), 见 Sidebar.tsx AI 会话历史 NavRow
    // 注释. 实现是当前真实意图 → sidebar 不再有任何 data-disabled row.
    const container = await renderSidebar()
    const disabledRows = container.querySelectorAll('[data-disabled="true"]')
    expect(disabledRows.length).toBe(0)
    // AI 会话历史 row 仍渲染 (enabled NavRow), 12 row 总数契约在上面 test 守.
  })
})

// Ensure screen import isn't tree-shaken (some lint configs flag unused
// imports even when used implicitly through testing-library helpers).
void screen
