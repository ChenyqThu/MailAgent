// @vitest-environment happy-dom
//
// 侧栏契约闸。task 08-24-l4-nav-shell Step B 起形态 = 方案 B（IconRail 56px 导轨 +
// DomainPanel 232px 域面板），断言面换成**registry ↔ 导轨投影 ↔ 域面板投影**三方一致：
//
//   1. 恰好一个 [data-app-nav] 根（rail + panel 收在单个 flex item 里，AppShell 红线）
//   2. 导轨格 = registry 里门控通过、有 rail 落位的条目 —— **逐格逐序**（手写清单 +
//      registry 投影两半互相补位）；底部沉「运维」「设置」
//   3. 域面板行 = registry 里该域门控通过、有 panel 落位的条目（每个域各断一次）；
//      邮件域另有 compose CTA，agents 域另有「报告 / Chats」轻量 tab 行
//   4. shell 内 .row-selected ≤ 1；导轨选中格恰 1 且 = 当前路由归属域
//   5. gate:'never' 的预留位（今日）永远不上导轨、不进面板
//   6. 门控关（matters / contacts off）→ 对应导轨格消失
//   7. 逐格 / 逐行点击落到自己的目标（含 search 默认值）；点当前域的格 = 折叠面板
//
// 🔴 手写期望清单**不是**从 registry 反推的，所以「registry 改了但 UI 没跟上」
// 「UI 手塞了一格 registry 里没有的」两个方向都会红；投影断言那半从 registry 推，
// 防手写清单自己烂掉。

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
// the shell actually touches: settings.get + email.listMailboxes + folder.*
// (SidebarFolderTree; whitelist 空 = 不渲染 FOLDERS 段)。
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
    },
    folder: {
      getWhitelist: vi.fn().mockResolvedValue({ folders: [] }),
      discover: vi.fn().mockResolvedValue({ folders: [], tree: [], whitelist: [] }),
      getPrefs: vi.fn().mockResolvedValue({ prefs: [] })
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
import {
  NAV_ENTRIES,
  navDomainLabel,
  navDomainPanelEntries,
  navLabel,
  navRailEntries,
  type NavDomain
} from '../../src/shared/navigation/registry'
import { useNavCollapsed } from '../../src/shared/state/nav-shell'

/** 门控全开时的导轨格（自上而下 = 屏幕上的顺序），**手写**期望。 */
const ALL_RAIL = ['邮件', '日历', '事项', '通讯录', 'Agents', '运维', '设置']
const BOTTOM_RAIL = ['运维', '设置']

/** 邮件域面板五行（手写）。 */
const MAIL_ROWS = ['收件箱', '发件箱', '草稿箱', '已标旗', '所有邮件']

function makeWrappedRouter(initialPath: string): ReturnType<typeof createRouter> {
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <Sidebar />
        <Outlet />
      </I18nextProvider>
    )
  })
  // 空组件路由树：只为让各域路由「存在」，面板/导轨的选中态与域推导有落点。
  const paths = [
    '/',
    '/sessions',
    '/agents',
    '/matters',
    '/contacts',
    '/settings',
    '/admin/llm',
    '/admin/kanban',
    '/admin/calendar'
  ]
  return createRouter({
    routeTree: rootRoute.addChildren(
      paths.map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
      )
    ),
    history: createMemoryHistory({ initialEntries: [initialPath] })
  })
}

async function renderShell(initialPath = '/'): Promise<{
  container: HTMLElement
  router: ReturnType<typeof createRouter>
}> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const router = makeWrappedRouter(initialPath)
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

function railLabels(container: HTMLElement, scope = '[data-nav-rail]'): string[] {
  return Array.from(container.querySelectorAll(`${scope} .nav-rail-cell .raillabel`)).map(
    (el) => el.textContent?.trim() ?? ''
  )
}

/** 面板行的可见文案（NavRow 的 label span 是 .flex-1.truncate 那个）。 */
function panelRowLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-nav-panel] .row')).map(
    (row) => (row.querySelector('span.flex-1') as HTMLElement | null)?.textContent?.trim() ?? ''
  )
}

/** registry 投影出的导轨格标签（门控全开）。 */
function projectedRail(): string[] {
  return navRailEntries(NAV_ENTRIES.filter((e) => e.gate !== 'never')).map((e) =>
    navDomainLabel(e.domain, i18n.t)
  )
}

function projectedPanel(domain: NavDomain): string[] {
  return navDomainPanelEntries(
    NAV_ENTRIES.filter((e) => e.gate !== 'never'),
    domain
  ).map((e) => navLabel(e, i18n.t))
}

beforeEach(async () => {
  gates.matters = true
  gates.contacts = true
  useNavCollapsed.setState({ collapsed: false })
  await i18n.changeLanguage('zh-CN')
})

describe('nav shell 结构契约', () => {
  afterEach(() => cleanup())

  test('exactly one [data-app-nav] root（rail + panel 收在单个 flex item）', async () => {
    const { container } = await renderShell()
    expect(container.querySelectorAll('[data-app-nav]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-nav-rail]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-nav-panel]')).toHaveLength(1)
  })

  test('at most 1 .row-selected inside the shell', async () => {
    const { container } = await renderShell()
    const shell = container.querySelector('[data-app-nav]')
    expect(shell).toBeTruthy()
    expect(shell!.querySelectorAll('.row-selected').length).toBeLessThanOrEqual(1)
  })

  test('无 disabled 行（Sprint 18 review — AI 会话历史不再灰禁）', async () => {
    const { container } = await renderShell()
    expect(container.querySelectorAll('[data-disabled="true"]')).toHaveLength(0)
  })

  // 🔴 导轨 icon 的 19px/18px 尺寸由 authored CSS `.railbtn > svg` 给（!important 压
  // lucide 的 width 属性）。图标外面多包一层（哪怕 <span>）→ 选择器落空、格里的图标
  // 静默缩回默认 15px，不报错、测试也照绿。Provider 是 zero-DOM 的前提就钉在这里。
  test('导轨每格的 icon svg 是 .railbtn 的直接子节点（CSS size-swap 的前提）', async () => {
    const { container } = await renderShell()
    const btns = Array.from(container.querySelectorAll('[data-nav-rail] .railbtn'))
    expect(btns.length).toBeGreaterThan(0)
    for (const btn of btns) {
      expect(btn.querySelector(':scope > svg'), btn.parentElement?.textContent ?? '').toBeTruthy()
    }
  })

  test('折叠 = data-collapsed 翻面（面板仍在 DOM，由 authored CSS 隐藏）', async () => {
    const { container } = await renderShell()
    expect(container.querySelector('[data-app-nav]')!.getAttribute('data-collapsed')).toBe('false')
    useNavCollapsed.setState({ collapsed: true })
    await waitFor(() => {
      expect(container.querySelector('[data-app-nav]')!.getAttribute('data-collapsed')).toBe('true')
    })
    expect(container.querySelector('[data-nav-panel]')).toBeTruthy()
  })
})

describe('IconRail ↔ nav registry 投影', () => {
  afterEach(() => cleanup())

  test('门控全开：7 格，顺序 = registry 的 rail.order（手写 + 投影两半）', async () => {
    const { container } = await renderShell()
    expect(railLabels(container)).toEqual(ALL_RAIL)
    expect(railLabels(container)).toEqual(projectedRail())
  })

  test('运维 / 设置沉底（.nav-rail-bottom）', async () => {
    const { container } = await renderShell()
    expect(railLabels(container, '[data-nav-rail] .nav-rail-bottom')).toEqual(BOTTOM_RAIL)
  })

  test('门控全关（matters / contacts off）：对应格消失', async () => {
    gates.matters = false
    gates.contacts = false
    const { container } = await renderShell()
    expect(railLabels(container)).toEqual(ALL_RAIL.filter((l) => l !== '事项' && l !== '通讯录'))
  })

  test("gate:'never' 的预留位（今日）：不上导轨、不进任何面板", async () => {
    const reserved = NAV_ENTRIES.filter((e) => e.gate === 'never')
    expect(reserved.length).toBeGreaterThan(0)
    const { container } = await renderShell()
    for (const entry of reserved) {
      expect(entry.to).toBeUndefined()
      expect(entry.panel).toBeUndefined()
      expect(railLabels(container)).not.toContain(navDomainLabel(entry.domain, i18n.t))
    }
  })

  test('选中格恰 1 且 = 当前路由归属域（/sessions 归 agents 格）', async () => {
    for (const [path, label] of [
      ['/', '邮件'],
      ['/sessions', 'Agents'],
      ['/admin/llm', '运维'],
      ['/admin/calendar', '日历']
    ] as const) {
      const { container } = await renderShell(path)
      const selected = container.querySelectorAll('[data-nav-rail] [data-selected="true"]')
      expect(selected, path).toHaveLength(1)
      expect(selected[0].querySelector('.raillabel')?.textContent).toBe(label)
      cleanup()
    }
  })

  test('导轨未读角标：收件箱未读挂邮件格', async () => {
    const { container } = await renderShell('/matters')
    const mailCell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
      (c) => c.querySelector('.raillabel')?.textContent === '邮件'
    )!
    await waitFor(() => {
      expect(mailCell.querySelector('.railbadge')?.textContent).toBe('3')
    })
  })

  test('逐格点击：切域 = 落到该格 entry 的目标（含 search 默认值）', async () => {
    // 从 /sessions 起手 —— agents 域激活，其余六格都是「切域」路径。
    const { container, router } = await renderShell('/sessions')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const clickCell = (label: string): void => {
      const cell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
        (c) => c.querySelector('.raillabel')?.textContent === label
      )!
      fireEvent.click(cell)
    }
    const calls: unknown[] = []
    for (const label of ['邮件', '日历', '事项', '通讯录', '运维', '设置']) {
      clickCell(label)
      const last = navigate.mock.calls.at(-1)?.[0] as { to?: string; search?: unknown }
      calls.push(
        last?.search === undefined ? { to: last?.to } : { to: last?.to, search: last.search }
      )
    }
    // 手写期望：search 缺省值也在这里钉死。
    expect(calls).toEqual([
      { to: '/', search: { view: 'inbox' } },
      { to: '/admin/calendar', search: { view: 'week' } },
      { to: '/matters' },
      { to: '/contacts' },
      { to: '/admin/kanban' },
      { to: '/settings', search: { tab: 'general' } }
    ])
    navigate.mockRestore()
  })

  test('点当前域的格 = 折叠/展开面板，不导航', async () => {
    const { container, router } = await renderShell('/matters')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const cell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
      (c) => c.querySelector('.raillabel')?.textContent === '事项'
    )!
    expect(useNavCollapsed.getState().collapsed).toBe(false)
    fireEvent.click(cell)
    expect(useNavCollapsed.getState().collapsed).toBe(true)
    fireEvent.click(cell)
    expect(useNavCollapsed.getState().collapsed).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    navigate.mockRestore()
  })
})

describe('DomainPanel ↔ nav registry 投影', () => {
  afterEach(() => cleanup())

  test('邮件域：MAILBOXES 五行，顺序 = registry 投影 + 手写清单', async () => {
    const { container } = await renderShell('/')
    expect(panelRowLabels(container)).toEqual(MAIL_ROWS)
    expect(panelRowLabels(container)).toEqual(projectedPanel('mail'))
    // compose CTA 在场（域头下、行区上）。
    expect(container.querySelector('[data-nav-panel] .app-nav-compose-btn')).toBeTruthy()
  })

  test('agents 域：registry 两行 + 报告 / Chats 轻量 tab 行', async () => {
    const { container } = await renderShell('/agents')
    expect(panelRowLabels(container)).toEqual([...projectedPanel('agents'), '报告', 'Chats'])
    expect(panelRowLabels(container)).toEqual(['MailAgent', 'Custom Agent', '报告', 'Chats'])
  })

  test('其余各域：面板行 = registry 该域投影（逐域）', async () => {
    for (const [path, domain] of [
      ['/matters', 'matters'],
      ['/contacts', 'contacts'],
      ['/admin/calendar', 'calendar'],
      ['/admin/llm', 'ops'],
      ['/settings', 'settings']
    ] as const) {
      const { container } = await renderShell(path)
      expect(panelRowLabels(container), path).toEqual(projectedPanel(domain))
      cleanup()
    }
  })

  test('面板头 = 域名；邮件域头带账号位', async () => {
    const { container } = await renderShell('/')
    const header = container.querySelector('[data-nav-panel] .nav-panel-header')!
    expect(header.textContent).toContain('邮件')
    await waitFor(() => {
      expect(header.textContent).toContain('lucien.chen')
    })
    cleanup()
    const { container: c2 } = await renderShell('/admin/llm')
    expect(c2.querySelector('[data-nav-panel] .nav-panel-header')!.textContent).toContain('运维')
  })

  test('邮件域逐行点击都落到自己的 view（search 钉死）', async () => {
    const { container, router } = await renderShell('/')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const calls: unknown[] = []
    for (const row of Array.from(container.querySelectorAll('[data-nav-panel] .row'))) {
      fireEvent.click(row)
      const last = navigate.mock.calls.at(-1)?.[0] as { to?: string; search?: unknown }
      calls.push({ to: last?.to, search: last?.search })
    }
    expect(calls).toEqual([
      { to: '/', search: { view: 'inbox' } },
      { to: '/', search: { view: 'outbox' } },
      { to: '/', search: { view: 'drafts' } },
      { to: '/', search: { view: 'flagged' } },
      { to: '/', search: { view: 'all' } }
    ])
    navigate.mockRestore()
  })
})

// Ensure screen import isn't tree-shaken (some lint configs flag unused
// imports even when used implicitly through testing-library helpers).
void screen
