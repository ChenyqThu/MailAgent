// @vitest-environment happy-dom
//
// 侧栏契约闸。DESIGN.md §2.11 的渲染期 lint（比自写 ESLint AST 规则便宜且安全）+
// task 08-24-l4-nav-shell Step R 起的**registry ↔ 渲染投影一致性**：
//
//   1. 恰好一个 [data-app-nav] 根
//   2. 恰好三个 .app-nav-section-header（MAILBOXES / AI AGENTS / VIEW）
//   3. shell 内 .row-selected ≤ 1
//   4. .app-nav-bottom 里没有 <a href="#"> 死锚点
//   5. 渲染出来的行 = registry 里门控通过、且有 panel 落位的条目 —— **逐行逐序**
//      （门控全关 11 行 / 门控全开 13 行；顺序 = panel.order）
//   6. 没有 data-disabled 行（Sprint 18 起「AI 会话历史」不再灰禁）
//   7. gate:'never' 的预留位（今日）永远不渲染
//
// 🔴 第 5 条的期望清单是**手写**的（不是从 registry 反推），所以「registry 改了但 UI 没跟
// 上」「UI 手塞了一行 registry 里没有的」两个方向都会红。第 5 条另有一半是从 registry
// **投影**出来的顺序断言 —— 两半互相补位。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// 门控开关（gate 求值走这两个 hook + 平台判定）。默认全开，用例里按需关。
const { gates } = vi.hoisted(() => ({ gates: { matters: true, contacts: true } }))

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

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersEnabled: () => gates.matters,
  useGlobalAttention: () => ({ data: { items: [] } })
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: gates.contacts, loading: false })
}))

// Importing after the mocks are registered.
import { Sidebar } from '../../src/shared/components/layout/Sidebar'
import { NAV_ENTRIES, navLabel, navPanelSection } from '../../src/shared/navigation/registry'

/** 门控全开时的侧栏行，**手写**的期望（自上而下 = 屏幕上的顺序）。 */
const ALL_ROWS = [
  '收件箱',
  '发件箱',
  '草稿箱',
  '已标旗',
  '所有邮件',
  '事项',
  'MailAgent',
  'Custom Agent',
  'LLM Dashboard',
  '看板 Admin',
  '日历',
  '通讯录',
  '设置'
]

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

async function renderSidebarWithRouter(): Promise<{
  container: HTMLElement
  router: ReturnType<typeof createRouter>
}> {
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
  return { container, router }
}

async function renderSidebar(): Promise<HTMLElement> {
  return (await renderSidebarWithRouter()).container
}

/** 行的可见文案（NavRow 的 label span 是 .flex-1.truncate 那个）。 */
function rowLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-app-nav] .row')).map(
    (row) => (row.querySelector('span.flex-1') as HTMLElement | null)?.textContent?.trim() ?? ''
  )
}

beforeEach(async () => {
  gates.matters = true
  gates.contacts = true
  await i18n.changeLanguage('zh-CN')
})

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

  test('无 disabled 行（Sprint 18 review — AI 会话历史不再灰禁）', async () => {
    const container = await renderSidebar()
    expect(container.querySelectorAll('[data-disabled="true"]')).toHaveLength(0)
  })
})

describe('Sidebar ↔ nav registry 投影', () => {
  afterEach(() => cleanup())

  test('门控全开：13 行，顺序 = registry 的 panel.order', async () => {
    const container = await renderSidebar()
    expect(rowLabels(container)).toEqual(ALL_ROWS)
  })

  test('门控全关（matters / contacts off）：11 行 = 5 + 2 + 3 + 1', async () => {
    gates.matters = false
    gates.contacts = false
    const container = await renderSidebar()
    expect(rowLabels(container)).toEqual(ALL_ROWS.filter((l) => l !== '事项' && l !== '通讯录'))
    expect(container.querySelectorAll('[data-app-nav] .row')).toHaveLength(11)
  })

  test('渲染顺序逐段等于 registry 投影（多一行 / 少一行 / 换序都会红）', async () => {
    const container = await renderSidebar()
    const expected = (['mailboxes', 'agents', 'view', 'bottom'] as const).flatMap((section) =>
      navPanelSection(
        NAV_ENTRIES.filter((e) => e.gate !== 'never'),
        section
      ).map((e) => navLabel(e, i18n.t))
    )
    expect(rowLabels(container)).toEqual(expected)
  })

  test('逐行点击都落到自己的目标（含 search 默认值）', async () => {
    const { container, router } = await renderSidebarWithRouter()
    // 测试路由树里只有 '/'，真跳会报「路由不存在」——这里只关心「navigate 收到什么」。
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const calls: unknown[] = []
    for (const row of Array.from(container.querySelectorAll('[data-app-nav] .row'))) {
      fireEvent.click(row)
      const last = navigate.mock.calls.at(-1)?.[0] as { to?: string; search?: unknown }
      calls.push(
        last?.search === undefined ? { to: last?.to } : { to: last?.to, search: last.search }
      )
    }
    // 手写期望：行序同 ALL_ROWS。search 缺省值也在这里钉死（少一个 tab/view =
    // TanStack validateSearch 会把用户丢到别的 tab 上）。
    expect(calls).toEqual([
      { to: '/', search: { view: 'inbox' } },
      { to: '/', search: { view: 'outbox' } },
      { to: '/', search: { view: 'drafts' } },
      { to: '/', search: { view: 'flagged' } },
      { to: '/', search: { view: 'all' } },
      { to: '/matters' },
      { to: '/sessions' },
      { to: '/agents', search: { tab: 'agents' } },
      { to: '/admin/llm' },
      { to: '/admin/kanban' },
      { to: '/admin/calendar', search: { view: 'week' } },
      { to: '/contacts' },
      { to: '/settings', search: { tab: 'general' } }
    ])
    navigate.mockRestore()
  })

  test("gate:'never' 的预留位（今日）：无路由、不占位、不渲染", async () => {
    const reserved = NAV_ENTRIES.filter((e) => e.gate === 'never')
    expect(reserved.length).toBeGreaterThan(0)
    const container = await renderSidebar()
    const labels = rowLabels(container)
    for (const entry of reserved) {
      // prd v2 N2：预留位不建占位路由、也不在二级栏占一行 —— 批次 2 落地时才翻开。
      expect(entry.to).toBeUndefined()
      expect(entry.panel).toBeUndefined()
      expect(labels).not.toContain(navLabel(entry, i18n.t))
    }
  })
})

// Ensure screen import isn't tree-shaken (some lint configs flag unused
// imports even when used implicitly through testing-library helpers).
void screen
