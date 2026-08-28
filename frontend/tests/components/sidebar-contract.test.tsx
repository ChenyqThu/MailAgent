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
//   5. 门控关（matters / contacts off）→ 对应导轨格消失
//   6. 逐格 / 逐行点击落到自己的目标（含 search 默认值）；点当前域的格 = 折叠面板
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
// the shell actually touches: settings.get + email.listMailboxes（rail 徽标）+
// report.getConfig（TeamNavPanel）。
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
    // TeamNavPanel（团队域二级栏）走 /agents 页同一份 useReportConfig 查询。
    report: {
      getConfig: vi.fn().mockResolvedValue([
        { id: 'a1', title: '跟进员', type: 'custom', enabled: true, description: '盯事项推进' },
        { id: 'a2', title: '搜索助手', type: 'search', enabled: true, description: null }
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
import {
  NAV_ENTRIES,
  navDomainLabel,
  navDomainPanelEntries,
  navLabel,
  navRailEntries,
  type NavDomain
} from '../../src/shared/navigation/registry'
import {
  __resetDomainLocations,
  recordRouteLocation
} from '../../src/shared/navigation/domain-location'
import { SETTINGS_TABS } from '../../src/shared/lib/settingsTabs'

/** 门控全开时的导轨格（自上而下 = 屏幕上的顺序），**手写**期望。08-27 批：对象域
 *  （邮件/事项）在前、页面域在后（两组之间有 .nav-rail-sep 分隔线），共十格。 */
const ALL_RAIL = ['邮件', '事项', '今日', '日历', '对话', '通讯录', '团队', '报告', '运维', '设置']
const BOTTOM_RAIL = ['运维', '设置']

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
    '/today',
    '/sessions',
    '/agents',
    '/reports',
    '/matters',
    '/contacts',
    // 「新标签页」搜索标签的承载路由（08-27 P2 补批 Lane S）。有意不进 registry ⇒
    // 不属于任何域，导轨在它上面不该有高亮格。
    '/search',
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
  // 每域落点记忆是模块级的；不清会让「回放」用例污染后面按缺省 entry 断言的用例。
  __resetDomainLocations()
  await i18n.changeLanguage('zh-CN')
})

describe('nav shell 结构契约', () => {
  afterEach(() => cleanup())

  test('exactly one [data-app-nav] root（rail + panel 收在单个 flex item）', async () => {
    // 08-27 批：mail 转 'page' 域（'/' 无 DomainPanel），用有面板的 today 域验结构。
    const { container } = await renderShell('/today')
    expect(container.querySelectorAll('[data-app-nav]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-nav-rail]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-nav-panel]')).toHaveLength(1)
    // StatusBar 退役后 sync 段的常驻落位（rail 底部状态点）。
    expect(container.querySelectorAll('[data-nav-rail] .nav-rail-sync')).toHaveLength(1)
    // 对象域（邮件/事项）与页面域之间的分隔线。
    expect(container.querySelectorAll('[data-nav-rail] .nav-rail-sep')).toHaveLength(1)
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
})

describe('IconRail ↔ nav registry 投影', () => {
  afterEach(() => cleanup())

  test('门控全开：10 格，顺序 = registry 的 rail.order（手写 + 投影两半）', async () => {
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

  test('选中格恰 1 且 = 当前路由归属域（/sessions 归对话格）', async () => {
    for (const [path, label] of [
      ['/', '邮件'],
      ['/sessions', '对话'],
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
    for (const label of [
      '邮件',
      '事项',
      '今日',
      '日历',
      '通讯录',
      '团队',
      '报告',
      '运维',
      '设置'
    ]) {
      clickCell(label)
      const last = navigate.mock.calls.at(-1)?.[0] as { to?: string; search?: unknown }
      calls.push(
        last?.search === undefined ? { to: last?.to } : { to: last?.to, search: last.search }
      )
    }
    // 手写期望：search 缺省值也在这里钉死。08-27 P3：报告拿到自己的路由，团队与
    // 报告不再共用 `/agents` + `?tab=`。
    expect(calls).toEqual([
      { to: '/', search: { view: 'inbox' } },
      { to: '/matters' },
      { to: '/today' },
      { to: '/admin/calendar', search: { view: 'week' } },
      { to: '/contacts' },
      { to: '/agents' },
      { to: '/reports' },
      { to: '/admin/kanban' },
      { to: '/settings', search: { tab: 'general' } }
    ])
    navigate.mockRestore()
  })

  // '/search' 不属于任何域（registry 有意不收它）⇒ 导轨没有高亮格，每一格都是切域。
  // 回落成 'mail' 会让邮件格亮着（误导），导轨的「当前域」判据必须容得下 null。
  test("'/search'：导轨无高亮格，且点任一格都正常切域", async () => {
    const { container, router } = await renderShell('/search')
    expect(container.querySelectorAll('[data-nav-rail] [data-selected="true"]')).toHaveLength(0)
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const mailCell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
      (c) => c.querySelector('.raillabel')?.textContent === '邮件'
    )!
    fireEvent.click(mailCell)
    expect(navigate.mock.calls.at(-1)?.[0]).toEqual({ to: '/', search: { view: 'inbox' } })
    navigate.mockRestore()
  })

  // 导轨是「回邮件域」最常走的路径。P2 补批 Lane R 之前它恒落这一格的缺省 entry ——
  // 在「已加星标」里切去事项域再点回邮件格，视图被重置成收件箱（dev 实测）。
  test('切域落该域上次的落点：在 flagged 切走，点邮件格回到 flagged 而不是 inbox', async () => {
    // 模拟「上次在邮件域停在 /?view=flagged」（真实链路里由 useTabRouteSync 的
    // route→tab 腿在每次路由变化时记下）。
    expect(recordRouteLocation('/', { view: 'flagged' })).toBe('mail')
    const { container, router } = await renderShell('/matters')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const mailCell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
      (c) => c.querySelector('.raillabel')?.textContent === '邮件'
    )!
    fireEvent.click(mailCell)
    expect(navigate.mock.calls.at(-1)?.[0]).toEqual({ to: '/', search: { view: 'flagged' } })
    navigate.mockRestore()
  })

  // 08-27 dogfood 修正批：二级栏不可收起了，「点当前域的格 = 折叠」这条短路取消 ——
  // 每一格恒是「回该域上次的落点」，包括当前域自己（回放的就是当前位置，等效无感）。
  test('点当前域的格 = 正常导航到该域落点，不再是折叠短路', async () => {
    for (const [path, label, expected] of [
      ['/', '邮件', { to: '/', search: { view: 'inbox' } }],
      ['/matters', '事项', { to: '/matters' }],
      ['/admin/calendar', '日历', { to: '/admin/calendar', search: { view: 'week' } }]
    ] as const) {
      const { container, router } = await renderShell(path)
      const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
      const cell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
        (c) => c.querySelector('.raillabel')?.textContent === label
      )!
      fireEvent.click(cell)
      expect(navigate.mock.calls.at(-1)?.[0], path).toEqual(expected)
      navigate.mockRestore()
      cleanup()
    }
  })

  // 🔴 当前域那一格也必须走 navigateToDomain：改成 handleEntryClick 的话它会落**这一格
  // 的缺省 entry**（收件箱），在「已加星标」里点一下邮件格就把视图重置了。
  test('点当前域的格：有落点记录时回放记录，不落该格的缺省 entry', async () => {
    expect(recordRouteLocation('/', { view: 'flagged' })).toBe('mail')
    const { container, router } = await renderShell('/?view=flagged')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    const mailCell = Array.from(container.querySelectorAll('[data-nav-rail] .nav-rail-cell')).find(
      (c) => c.querySelector('.raillabel')?.textContent === '邮件'
    )!
    fireEvent.click(mailCell)
    expect(navigate.mock.calls.at(-1)?.[0]).toEqual({ to: '/', search: { view: 'flagged' } })
    navigate.mockRestore()
  })
})

describe('DomainPanel ↔ nav registry 投影', () => {
  afterEach(() => cleanup())

  test('运维域：面板行 = registry 投影', async () => {
    const { container } = await renderShell('/admin/llm')
    expect(panelRowLabels(container)).toEqual(projectedPanel('ops'))
  })

  // 08-27 批：所有域恒有二级栏，差别只在 registry NAV_DOMAINS.second ——
  // 'nav' = DomainPanel；'page' = 页面清单列充当二级栏（无 DomainPanel）。
  // mail / chats P1 转 'page'（邮件列表 / 会话列表由页面自己出）；reports P3 转
  // 'page'（报告清单列就是它的二级栏）；team（agents）过渡期仍留 'nav'
  // （/agents 还是卡片网格，无自管左列）。
  test('page 域（邮件/事项/通讯录/对话/报告）：无 DomainPanel', async () => {
    for (const path of ['/', '/matters', '/contacts', '/sessions', '/reports'] as const) {
      const { container } = await renderShell(path)
      expect(container.querySelector('[data-nav-panel]'), path).toBeNull()
      cleanup()
    }
  })

  test('团队域（过渡档 nav）：面板 = 简版智能体清单，点行落 /agents', async () => {
    const { container, router } = await renderShell('/agents')
    expect(container.querySelector('[data-nav-panel] [data-team-nav]')).toBeTruthy()
    // 清单行 = useReportConfig 共享缓存里的 agent（名字进 .flex-1 主位）。
    await waitFor(() => {
      expect(panelRowLabels(container)).toEqual(['跟进员', '搜索助手'])
    })
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    fireEvent.click(container.querySelector('[data-team-nav] .row')!)
    expect(navigate.mock.calls.at(-1)?.[0]).toEqual({ to: '/agents' })
    navigate.mockRestore()
  })

  test('今日域：面板 = 当天五节跳转（TodayNavPanel）', async () => {
    const { container } = await renderShell('/today')
    expect(container.querySelector('[data-nav-panel] [data-today-nav]')).toBeTruthy()
    expect(panelRowLabels(container)).toEqual([
      '等你拍板',
      '今天的会',
      '待回邮件',
      '临期事项',
      '智能体产出'
    ])
  })

  test('日历域：面板 = 分组日历树（CalendarSourcePanel，三组各一个组头）', async () => {
    const { container } = await renderShell('/admin/calendar')
    const tree = container.querySelector('[data-nav-panel] [data-calendar-sources]')
    expect(tree).toBeTruthy()
    expect(tree!.querySelectorAll('.cal-srcgroup')).toHaveLength(3)
    expect(
      Array.from(tree!.querySelectorAll('.cal-src-row.is-group .cal-src-label')).map(
        (el) => el.textContent
      )
    ).toEqual([
      i18n.t('calendar.sources.mail'),
      i18n.t('calendar.sources.matter'),
      i18n.t('calendar.sources.agent')
    ])
  })

  test('设置域：面板行 = 12 个 tab 直达行（词表单源 SETTINGS_TABS）+ 版本 footer', async () => {
    const { container } = await renderShell('/settings')
    expect(panelRowLabels(container)).toEqual(
      SETTINGS_TABS.map((tab) => i18n.t(`settings.tabs.${tab}`))
    )
    expect(container.querySelector('[data-nav-panel]')!.textContent).toContain('version')
  })

  test('设置域 matters 门控关：matters tab 行消失', async () => {
    gates.matters = false
    const { container } = await renderShell('/settings')
    expect(panelRowLabels(container)).toEqual(
      SETTINGS_TABS.filter((tab) => tab !== 'matters').map((tab) => i18n.t(`settings.tabs.${tab}`))
    )
  })

  test('面板头 = 域名', async () => {
    const { container } = await renderShell('/today')
    expect(container.querySelector('[data-nav-panel] .nav-panel-header')!.textContent).toContain(
      '今日'
    )
    cleanup()
    const { container: c2 } = await renderShell('/admin/llm')
    expect(c2.querySelector('[data-nav-panel] .nav-panel-header')!.textContent).toContain('运维')
  })
})

// Ensure screen import isn't tree-shaken (some lint configs flag unused
// imports even when used implicitly through testing-library helpers).
void screen
