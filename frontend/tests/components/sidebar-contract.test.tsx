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
// signals：09-01 侧栏批两个无数字状态点的数据源（事项进行中派发 / 群聊未读），用例里按需拨。
// spies：需要跨 render 稳定引用的那几枚（mock 工厂每次调用都新建对象，断言调用次数要用它）。
const { gates, signals, spies } = vi.hoisted(() => ({
  gates: { matters: true, contacts: true },
  signals: { dispatches: 0, groupUnread: 0 },
  spies: { listEnriched: vi.fn().mockResolvedValue([]) }
}))

// `useMailApi` ships a real ElectronApi by default — that talks to
// window.electron which doesn't exist under happy-dom. Stub the surface
// the shell actually touches: settings.get + email.listMailboxes（rail 徽标）+
// report.getConfig（见下方注释）。
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
      ]),
      // 0902 dogfood 轮 1 后邮件 peek 是**邮箱列表**，不再投影邮件行 —— 这枚 spy 留作
      // 反向探针（下面的用例断言它零调用），别删。
      listEnriched: spies.listEnriched
    },
    // 0902 dogfood 轮 1：邮件 peek 的 FOLDERS 段与列表头下拉同一份数据链
    // （whitelist × discover × folder_pref）。🔴 数组序 = 用户自定义显示顺序。
    folder: {
      getWhitelist: vi.fn().mockResolvedValue({ folders: ['Projects', 'Projects/2026'] }),
      discover: vi.fn().mockResolvedValue({
        folders: [
          {
            imap_name: 'Projects',
            display_name: '项目',
            delimiter: '/',
            special_use: null,
            is_system: false,
            has_children: true,
            parent: null,
            message_count: null
          },
          {
            imap_name: 'Projects/2026',
            display_name: '项目/2026',
            delimiter: '/',
            special_use: null,
            is_system: false,
            has_children: false,
            parent: 'Projects',
            message_count: null
          }
        ]
      }),
      getPrefs: vi.fn().mockResolvedValue({ prefs: [] })
    },
    // 09-01 侧栏批：对话格「群聊有未读」dot 的数据源（origin='group'）。
    chat: {
      listAllSessions: vi
        .fn()
        .mockImplementation(async (opts: { origin?: string }) =>
          opts.origin === 'group' && signals.groupUnread > 0
            ? [{ id: 900, updated_at: 2_000, last_read_at: 1_000, archived: false, title: 'g' }]
            : []
        )
    },
    // 历史上供 TeamNavPanel（P1 过渡二级栏）消费；P4a 团队域转 'page' 后 shell 侧
    // 已无消费点，留着作无害兜底（避免未来 shell 侧新增 report 读面时 mock 缺腿）。
    // P4c 起 TodayNavPanel 真的要用 report.list / listRuns（二级栏计数与主区同源，
    // 走同一个 useTodaySections）。
    report: {
      getConfig: vi.fn().mockResolvedValue([
        { id: 'a1', title: '跟进员', type: 'custom', enabled: true, description: '盯事项推进' },
        { id: 'a2', title: '搜索助手', type: 'search', enabled: true, description: null }
      ]),
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listRuns: vi.fn().mockResolvedValue({ items: [], total: 0 })
    },
    today: { get: vi.fn().mockResolvedValue({ reply: [], nextHardPoint: null }) }
  })
}))

// P4c — 今日二级栏的计数走 useTodaySections（与主区同源），它会拉日历 agenda。
vi.mock('@shared/components/calendar/hooks/useCalendarAgenda', () => ({
  localOlsonTz: () => 'Asia/Shanghai',
  useCalendarAgenda: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn()
  })
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersEnabled: () => gates.matters,
  useGlobalAttention: () => ({ data: { items: [] } }),
  // P4c — TodayNavPanel 经 useTodaySections → useTodayData 拉这两条（例外面的四源之二）。
  usePendingMatterUpdates: () => ({ data: { items: [] }, isPending: false, isError: false }),
  // 09-01 侧栏批：事项格「进行中」dot 读它（关注计数为 0 时才画）。
  useLiveItemDispatches: () => ({
    data: { items: Array.from({ length: signals.dispatches }, (_, i) => ({ id: i })) },
    isPending: false,
    isError: false
  })
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: gates.contacts, loading: false })
}))

// Importing after the mocks are registered.
import { Sidebar } from '../../src/shared/components/layout/Sidebar'
import { GlobalShortcuts } from '../../src/shared/components/keyboard/GlobalShortcuts'
import {
  __resetNavShellForTest,
  domainPref,
  NAV_SHELL_STORAGE_KEY,
  useNavShell
} from '../../src/shared/state/nav-shell'
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
import { useEmailFilter } from '../../src/shared/state/email-filter'
import { SETTINGS_TABS } from '../../src/shared/lib/settingsTabs'

/** 门控全开时的导轨格（自上而下 = 屏幕上的顺序），**手写**期望。08-27 批：对象域
 *  （邮件/事项）在前、页面域在后（两组之间有 .nav-rail-sep 分隔线），共十格。 */
const ALL_RAIL = ['邮件', '事项', '今日', '日历', '对话', '通讯录', '团队', '报告', '运维', '设置']
const BOTTOM_RAIL = ['运维', '设置']

function makeWrappedRouter(
  initialPath: string,
  withShortcuts = false
): ReturnType<typeof createRouter> {
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        {withShortcuts && <GlobalShortcuts />}
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

async function renderShell(
  initialPath = '/',
  opts: { withShortcuts?: boolean } = {}
): Promise<{
  container: HTMLElement
  router: ReturnType<typeof createRouter>
}> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const router = makeWrappedRouter(initialPath, opts.withShortcuts === true)
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
  signals.dispatches = 0
  signals.groupUnread = 0
  // 每域落点记忆是模块级的；不清会让「回放」用例污染后面按缺省 entry 断言的用例。
  __resetDomainLocations()
  // 每域折叠 / 宽度记忆同理（localStorage + store）。
  __resetNavShellForTest()
  // 邮件 peek 的点行会写 view（模块级 store），复位免得污染后面的用例。
  useEmailFilter.setState({ view: 'inbox', customMailbox: null, customMailboxPath: [] })
  spies.listEnriched.mockClear()
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

  // 08-27 dogfood 修正批：「点当前域的格 = 折叠」这条短路取消 —— 每一格恒是「回该域
  // 上次的落点」，包括当前域自己（回放的就是当前位置，等效无感）。09-01 侧栏批把折叠
  // 按域带回来了，但入口只有开合钮 / 面板头钮 / `[`，导轨格**仍然只导航不折叠**。
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
  // 'page'（报告清单列就是它的二级栏）；team（agents）P4a 转 'page'
  // （TeamWorkspace 自管清单列，过渡的 TeamNavPanel 退役）。
  test('page 域（邮件/事项/通讯录/对话/团队/报告）：无 DomainPanel', async () => {
    for (const path of [
      '/',
      '/matters',
      '/contacts',
      '/sessions',
      '/agents',
      '/reports'
    ] as const) {
      const { container } = await renderShell(path)
      expect(container.querySelector('[data-nav-panel]'), path).toBeNull()
      cleanup()
    }
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

// ── 09-01 侧栏批：按域折叠 / 全域 peek / 拖宽 / 快捷键 / 状态点 ────────────────────────
//
// 覆盖 design.md §5 列的六条新断言：每域独立持久化与回放、peek 只在折叠态、页面域 peek
// 有真内容、拖宽夹取、`[` 在输入框内不触发、状态点形状按 registry 单源。
// happy-dom 量不到布局与动效（220ms 变量过渡 / 浮层几何），那些在实测清单里。

function railCell(container: HTMLElement, domain: string): HTMLElement {
  const cell = container.querySelector(`[data-nav-rail] .nav-rail-cell[data-domain="${domain}"]`)
  if (!(cell instanceof HTMLElement)) throw new Error(`导轨没有 ${domain} 格`)
  return cell
}

function shell(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-app-nav]')
  if (!(el instanceof HTMLElement)) throw new Error('shell 根不在')
  return el
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 邮件 peek 里的行（NavRow：label 在 span.flex-1 上），两段按 DOM 序拼在一起。 */
function peekMailRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-nav-peek-list="mail"] .row'))
}

function peekMailRowLabels(container: HTMLElement): string[] {
  return peekMailRows(container).map(
    (row) => (row.querySelector('span.flex-1') as HTMLElement | null)?.textContent?.trim() ?? ''
  )
}

function peekMailRow(container: HTMLElement, label: string): HTMLElement {
  const rows = peekMailRows(container)
  const hit = rows.find(
    (row) => (row.querySelector('span.flex-1') as HTMLElement | null)?.textContent?.trim() === label
  )
  if (hit === undefined) throw new Error(`邮件 peek 里没有「${label}」行`)
  return hit
}

describe('按域折叠（09-01 侧栏批）', () => {
  afterEach(() => cleanup())

  test('rail 底部开合钮：aria-expanded 跟折叠态；点它只折叠当前域', async () => {
    const { container } = await renderShell('/today')
    const toggle = container.querySelector('[data-nav-toggle]')
    expect(toggle).toBeTruthy()
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(shell(container).getAttribute('data-collapsed')).toBe('false')
    fireEvent.click(toggle as HTMLElement)
    expect(shell(container).getAttribute('data-collapsed')).toBe('true')
    expect(container.querySelector('[data-nav-toggle]')?.getAttribute('aria-expanded')).toBe(
      'false'
    )
    const { prefs } = useNavShell.getState()
    expect(domainPref(prefs, 'today').collapsed).toBe(true)
    expect(domainPref(prefs, 'ops').collapsed).toBe(false)
    // 变量由 store 唯一写入：折叠 = 56 / 0。
    expect(document.documentElement.style.getPropertyValue('--app-nav-w')).toBe('56px')
    expect(document.documentElement.style.getPropertyValue('--app-second-w')).toBe('0px')
  })

  test('面板头折叠钮 → 折叠并持久化到新键；重新渲染同域回放，别的域不受影响', async () => {
    const { container } = await renderShell('/today')
    fireEvent.click(container.querySelector('[data-nav-panel-collapse]') as HTMLElement)
    expect(shell(container).getAttribute('data-collapsed')).toBe('true')
    expect(JSON.parse(window.localStorage.getItem(NAV_SHELL_STORAGE_KEY) ?? '{}')).toEqual({
      today: { collapsed: true, width: 336 }
    })
    cleanup()
    const { container: again } = await renderShell('/today')
    expect(shell(again).getAttribute('data-collapsed')).toBe('true')
    // 折叠态没有拖宽手柄；面板本体仍挂载（不卸载）。
    expect(again.querySelector('[data-nav-resize]')).toBeNull()
    expect(again.querySelector('[data-nav-panel]')).toBeTruthy()
    cleanup()
    const { container: ops } = await renderShell('/admin/llm')
    expect(shell(ops).getAttribute('data-collapsed')).toBe('false')
    expect(ops.querySelector('[data-nav-resize]')).toBeTruthy()
  })

  test('拖宽夹取：+60 → 396；−200 → 280 夹住；+300 → 420 夹住；双击复位 336', async () => {
    const { container } = await renderShell('/admin/llm')
    const handle = container.querySelector('[data-nav-resize]') as HTMLElement
    const drag = (from: number, to: number): void => {
      fireEvent.pointerDown(handle, { clientX: from, button: 0, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: to, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientX: to, pointerId: 1 })
    }
    const widthOf = (): number => domainPref(useNavShell.getState().prefs, 'ops').width
    drag(400, 460)
    expect(widthOf()).toBe(396)
    expect(document.documentElement.style.getPropertyValue('--app-second-w')).toBe('396px')
    drag(400, 200)
    expect(widthOf()).toBe(280)
    drag(400, 700)
    expect(widthOf()).toBe(420)
    fireEvent.doubleClick(handle)
    expect(widthOf()).toBe(336)
    // 只动了 ops，别的域仍是默认。
    expect(domainPref(useNavShell.getState().prefs, 'today').width).toBe(336)
    expect(document.documentElement.hasAttribute('data-nav-dragging')).toBe(false)
  })

  test('`[` 翻当前域折叠；焦点在 <input> 里时 `[` 不触发', async () => {
    const { container } = await renderShell('/today', { withShortcuts: true })
    fireEvent.keyDown(document.body, { key: '[' })
    expect(shell(container).getAttribute('data-collapsed')).toBe('true')
    fireEvent.keyDown(document.body, { key: '[' })
    expect(shell(container).getAttribute('data-collapsed')).toBe('false')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: '[' })
    expect(shell(container).getAttribute('data-collapsed')).toBe('false')
    input.remove()
  })
})

describe('全域 peek（09-01 侧栏批）', () => {
  afterEach(() => cleanup())

  test('展开态 hover / 聚焦导轨格不 peek', async () => {
    const { container } = await renderShell('/today')
    fireEvent.focus(railCell(container, 'mail'))
    await sleep(400)
    expect(container.querySelector('[data-nav-peek]')).toBeNull()
  })

  test('折叠态聚焦今日格 → 150ms 后 peek 浮出（内容 = 五节）；Esc 关', async () => {
    useNavShell.getState().setCollapsed('today', true)
    const { container } = await renderShell('/today')
    expect(shell(container).getAttribute('data-collapsed')).toBe('true')
    fireEvent.focus(railCell(container, 'today'))
    // 150ms 之内还没有（延时进入）。
    expect(container.querySelector('[data-nav-peek]')).toBeNull()
    await waitFor(() => expect(container.querySelector('[data-nav-peek="today"]')).toBeTruthy(), {
      timeout: 1500
    })
    // peek 里的是 DomainPanel 的 peek 变体（不是契约闸认的常驻那份）。
    expect(container.querySelectorAll('[data-nav-panel]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-nav-panel-peek]')).toHaveLength(1)
    expect(
      Array.from(container.querySelectorAll('[data-nav-panel-peek] .row')).map((row) =>
        (row.querySelector('span.flex-1') as HTMLElement | null)?.textContent?.trim()
      )
    ).toEqual(['等你拍板', '今天的会', '待回邮件', '临期事项', '智能体产出'])
    // 左列边界不动：浮层脱流。
    expect(document.documentElement.style.getPropertyValue('--app-nav-w')).toBe('56px')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(container.querySelector('[data-nav-peek]')).toBeNull())
  })

  // 0902 dogfood 轮 1：owner 要的邮件 peek 是「切邮箱」的那份清单（demo 同款），不是把
  // 邮件行再画一遍 —— 邮件行在右边的主列表里本来就有。
  test('折叠态聚焦邮件格 → peek 是邮箱列表两段（五视图 + 已同步文件夹）；点行切视图并关', async () => {
    useNavShell.getState().setCollapsed('today', true)
    const { container, router } = await renderShell('/today')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    fireEvent.focus(railCell(container, 'mail'))
    await waitFor(() => expect(container.querySelector('[data-nav-peek="mail"]')).toBeTruthy(), {
      timeout: 1500
    })
    // lazy chunk + 两条查询：MAILBOXES = registry 五视图（序 = panel.order）；
    // FOLDERS = whitelist × discover（🔴 数组序，父在前子紧随）。
    await waitFor(
      () =>
        expect(peekMailRowLabels(container)).toEqual([
          '收件箱',
          '发件箱',
          '草稿箱',
          '已标旗',
          '所有邮件',
          '项目',
          '2026'
        ]),
      { timeout: 4000 }
    )
    // 行尾计数与 rail 徽标同一条数据链（收件箱 = 未读 3）。
    expect(peekMailRow(container, '收件箱').textContent).toContain('3')
    // 🔴 反向探针：邮箱列表不该再拉邮件行。
    expect(spies.listEnriched).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-nav-peek-list="mail"] .email-row')).toHaveLength(0)
    // 点内建视图行 = 列表头下拉同一套动作（useSelectMailbox）：setView + `?view=` 导航。
    fireEvent.click(peekMailRow(container, '已标旗'))
    expect(navigate.mock.calls.at(-1)?.[0]).toEqual({ to: '/', search: { view: 'flagged' } })
    expect(useEmailFilter.getState().view).toBe('flagged')
    await waitFor(() => expect(container.querySelector('[data-nav-peek]')).toBeNull())
    navigate.mockRestore()
  })

  test('邮件 peek 点自定义文件夹行 → 写 customMailbox 过滤 key（完整 display_name）+ 切回邮件域', async () => {
    useNavShell.getState().setCollapsed('today', true)
    const { container, router } = await renderShell('/today')
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    fireEvent.focus(railCell(container, 'mail'))
    // 等 discover 那棵树（seed 树的根标签是 imap 原名 'Projects'，会误导下面的断言）。
    await waitFor(() => expect(peekMailRowLabels(container)).toContain('项目'), { timeout: 4000 })
    fireEvent.click(peekMailRow(container, '2026'))
    // 🔴 过滤 key 是完整 display_name（后端 email_metadata.mailbox 存完整解码路径）。
    expect(useEmailFilter.getState().customMailbox).toBe('项目/2026')
    // 文件夹行自己不导航（列表头本就在邮件域），peek 从别的域浮出 ⇒ 补切域。
    expect(navigate).toHaveBeenCalled()
    await waitFor(() => expect(container.querySelector('[data-nav-peek]')).toBeNull())
    navigate.mockRestore()
  })

  test('离开导轨 300ms 后关；切域时 peek 随之关', async () => {
    useNavShell.getState().setCollapsed('today', true)
    const { container } = await renderShell('/today')
    const cell = railCell(container, 'calendar')
    fireEvent.focus(cell)
    await waitFor(
      () => expect(container.querySelector('[data-nav-peek="calendar"]')).toBeTruthy(),
      {
        timeout: 1500
      }
    )
    fireEvent.blur(cell)
    expect(container.querySelector('[data-nav-peek="calendar"]')).toBeTruthy()
    await waitFor(() => expect(container.querySelector('[data-nav-peek]')).toBeNull(), {
      timeout: 1500
    })
  })
})

describe('状态点形状按 registry 单源（09-01 侧栏批）', () => {
  afterEach(() => cleanup())

  test('对话格：群聊有未读 → 6px dot（不是数字）；无未读 → 无', async () => {
    signals.groupUnread = 1
    const { container } = await renderShell('/today')
    await waitFor(() => {
      const badge = railCell(container, 'chats').querySelector('.railbadge')
      expect(badge?.getAttribute('data-shape')).toBe('dot')
      expect(badge?.textContent).toBe('')
    })
    cleanup()
    signals.groupUnread = 0
    const { container: quiet } = await renderShell('/today')
    await sleep(50)
    expect(railCell(quiet, 'chats').querySelector('.railbadge')).toBeNull()
  })

  test('事项格：关注计数为 0 且有进行中派发 → dot', async () => {
    signals.dispatches = 2
    const { container } = await renderShell('/today')
    await waitFor(() => {
      expect(
        railCell(container, 'matters').querySelector('.railbadge')?.getAttribute('data-shape')
      ).toBe('dot')
    })
  })
})

// Ensure screen import isn't tree-shaken (some lint configs flag unused
// imports even when used implicitly through testing-library helpers).
void screen
