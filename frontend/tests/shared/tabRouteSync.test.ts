// useTabRouteSync 的纯逻辑腿（08-27 P2 Lane W）：route → tab 收敛 + 激活槽域判定 +
// 域缺省落点派生（每域恰一格 rail，从 registry 派生不手抄映射表）+ 每域最近落点的
// 记录与回放（P2 补批 Lane R）。
// hook 本体（订阅接线）依赖 router context，由 dev 实测覆盖。

import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined
})

const { MAIN_SLOT, MAIN_PAGES, SEARCH_TARGET_ID, useTabWorkspace } =
  await import('../../src/shared/state/tab-workspace')
const { SEARCH_SLOT, activeSlotDomain, needsRouteResync, reconcileRouteToTabs } =
  await import('../../src/shared/navigation/useTabRouteSync')
// 「域 → 落点」的记忆与解析在自己的叶子模块（Sidebar 的导轨切域点击也读它）。
const { __resetDomainLocations, domainDefaultEntry, navigateToDomain, recordRouteLocation } =
  await import('../../src/shared/navigation/domain-location')
const { NAV_DOMAINS } = await import('../../src/shared/navigation/registry')

function resetTabs(): void {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 8,
    closedStack: []
  })
}

beforeEach(() => {
  resetTabs()
  __resetDomainLocations()
})

describe('domainDefaultEntry', () => {
  // 🔴 域清单从 NAV_DOMAINS 派生而不是手抄十个名字：这条闸守的是
  // 「每个域恰有一格 rail」这条 useTabRouteSync 赖以工作的不变量，手抄清单会漏掉
  // 后来新增的域 —— 而它失效是**静默**的（boot 目标取不到 entry ⇒ route→tab 腿
  // 整个会话不再收敛，没有任何报错）。
  test('每个域都有一条缺省落点（rail 派生），且 domain 一致', () => {
    const domains = Object.keys(NAV_DOMAINS) as Array<keyof typeof NAV_DOMAINS>
    expect(domains.length).toBeGreaterThanOrEqual(10)
    for (const domain of domains) {
      const entry = domainDefaultEntry(domain)
      expect(entry, domain).not.toBeNull()
      expect(entry?.domain).toBe(domain)
    }
  })
})

describe('activeSlotDomain', () => {
  test('主标签 → mainPage；对象标签 → kind 对应域', () => {
    expect(activeSlotDomain(useTabWorkspace.getState())).toBe('today')
    useTabWorkspace.getState().setMainPage('calendar')
    expect(activeSlotDomain(useTabWorkspace.getState())).toBe('calendar')
    useTabWorkspace.getState().openTab('email', 1)
    expect(activeSlotDomain(useTabWorkspace.getState())).toBe('mail')
    useTabWorkspace.getState().openTab('matter', 2)
    expect(activeSlotDomain(useTabWorkspace.getState())).toBe('matters')
  })

  // 搜索标签无域：目标是 SEARCH_SLOT 哨兵（订阅腿据此绕过 navigateToDomain 直落
  // '/search'）。若这里误落某个域，激活搜索标签会被当成域切换导航走 —— 静默失效。
  test('搜索标签 → SEARCH_SLOT（不落任何域）', () => {
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    expect(activeSlotDomain(useTabWorkspace.getState())).toBe(SEARCH_SLOT)
    expect(Object.keys(NAV_DOMAINS)).not.toContain(SEARCH_SLOT)
  })
})

// 订阅腿的触发判据（check 轮补）。⌘T /「+」按在已经激活的搜索标签上时 openTab 走
// `activated` 支 —— active 不变，只看 active 变化就不导航；而路由此刻可能已经不在
// '/search'（rail 切到没有标签的对象域时激活槽留在原处）⇒ 那一按什么也不发生。
describe('needsRouteResync', () => {
  test('激活槽变了 → 要校', () => {
    const prev = useTabWorkspace.getState()
    useTabWorkspace.getState().openTab('email', 1, '邮件 1')
    expect(needsRouteResync(useTabWorkspace.getState(), prev)).toBe(true)
  })

  test('搜索单例被重新激活（active 不变、lastActiveAt 变）→ 要校', () => {
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    const prev = useTabWorkspace.getState()
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    const next = useTabWorkspace.getState()
    expect(next.active).toBe(prev.active) // 前提：openTab 走 activated 支
    expect(needsRouteResync(next, prev)).toBe(true)
  })

  test('对象标签被重新激活 → 不校（再点一次同一封邮件不带导航意图）', () => {
    useTabWorkspace.getState().openTab('email', 1, '邮件 1')
    const prev = useTabWorkspace.getState()
    useTabWorkspace.getState().openTab('email', 1, '邮件 1')
    expect(needsRouteResync(useTabWorkspace.getState(), prev)).toBe(false)
  })

  test('只是写字段（updateTab）→ 不校，免得无关提交把人从别的域拽走', () => {
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    const prev = useTabWorkspace.getState()
    useTabWorkspace.getState().updateTab('search:0', { scrollTop: 42 })
    expect(needsRouteResync(useTabWorkspace.getState(), prev)).toBe(false)
  })
})

describe('reconcileRouteToTabs', () => {
  test('页面域：占用主标签（setMainPage 隐含 active=main）', () => {
    useTabWorkspace.getState().openTab('email', 1)
    reconcileRouteToTabs('settings')
    const s = useTabWorkspace.getState()
    expect(s.active).toBe(MAIN_SLOT)
    expect(s.mainPage).toBe('settings')
    // 页面域词表与 MainPage 全集对齐（新增页面域漏接这里会红）
    expect(MAIN_PAGES).toContain('settings')
  })

  test('对象域：激活标签已属该域 → 不动', () => {
    useTabWorkspace.getState().openTab('email', 1)
    const before = useTabWorkspace.getState().tabs
    reconcileRouteToTabs('mail')
    expect(useTabWorkspace.getState().tabs).toBe(before)
    expect(useTabWorkspace.getState().active).toBe('email:1')
  })

  test('对象域：激活位在别处 → 激活该域 lastActiveAt 最近的标签', () => {
    useTabWorkspace.getState().openTab('email', 1)
    useTabWorkspace.getState().openTab('email', 2)
    useTabWorkspace.getState().openTab('matter', 9)
    // 人在事项标签上，rail 切回邮件域 → 最近用过的 email:2 接管
    reconcileRouteToTabs('mail')
    expect(useTabWorkspace.getState().active).toBe('email:2')
  })

  test('对象域：该域无标签 → 维持现状（域内空详情态，不硬拗主标签）', () => {
    useTabWorkspace.getState().openTab('matter', 9)
    reconcileRouteToTabs('mail')
    expect(useTabWorkspace.getState().active).toBe('matter:9')
  })

  test('搜索标签激活时 rail 切对象域 → 激活该域标签，搜索标签保留不关', () => {
    useTabWorkspace.getState().openTab('email', 1)
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '新标签页')
    reconcileRouteToTabs('mail')
    const s = useTabWorkspace.getState()
    expect(s.active).toBe('email:1')
    expect(s.tabs.some((t) => t.kind === 'search')).toBe(true)
  })
})

// 跨域切回落该域上次的落点（P2 补批 Lane R）。域内位置在 URL 里（邮件五视图 /?view=、
// 日历 ?view=、设置 ?tab=），恒落缺省 entry 会把「已加星标」重置成收件箱 —— owner 报的
// 就是这一条。
//
// boot 腿也走 navigateToDomain，但**吃不到记录**：落点由 route→tab 腿写，那条 effect 在
// boot effect 之后跑，首挂载时表必空 ⇒ boot 恒落缺省 entry（跨会话不要求恢复，符合需求）。
// 共用一条解析路径只是为了不出现第二份「域 → 落点」判据，故这里只测前两条。
describe('每域最近落点：记录与回放', () => {
  type NavigateArg = { to: string; search?: Record<string, unknown> }
  function lastNavigate(navigate: ReturnType<typeof vi.fn>): NavigateArg | undefined {
    return navigate.mock.calls.at(-1)?.[0] as NavigateArg | undefined
  }

  test('在「已加星标」切走再切回 → 回放 flagged，不是缺省的 inbox', () => {
    expect(recordRouteLocation('/', { view: 'flagged' })).toBe('mail')
    expect(recordRouteLocation('/matters', {})).toBe('matters')
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'mail')
    expect(lastNavigate(navigate)).toEqual({ to: '/', search: { view: 'flagged' } })
  })

  test('同域再访 → 后一次覆盖前一次', () => {
    recordRouteLocation('/', { view: 'flagged' })
    recordRouteLocation('/', { view: 'all' })
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'mail')
    expect(lastNavigate(navigate)).toEqual({ to: '/', search: { view: 'all' } })
  })

  test('无记录 → 落该域缺省 entry（邮件 = 收件箱，日历 = 周视图）', () => {
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'mail')
    expect(lastNavigate(navigate)).toEqual({ to: '/', search: { view: 'inbox' } })
    navigateToDomain(navigate as never, 'calendar')
    expect(lastNavigate(navigate)).toEqual({ to: '/admin/calendar', search: { view: 'week' } })
  })

  test('日历 ?view= 同样回放（不是只对邮件生效）', () => {
    expect(recordRouteLocation('/admin/calendar', { view: 'month' })).toBe('calendar')
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'calendar')
    expect(lastNavigate(navigate)).toEqual({ to: '/admin/calendar', search: { view: 'month' } })
  })

  // 08-27 P3：报告拿到自己的路由，团队与报告不再共用 `/agents`（`?tab=` 归属那套
  // 胶水随之退役）。落点各记各的这条不变，只是判据回到纯 pathname：报告域记的是
  // 「上次看的那一份」，切回来直接回那一份而不是清单缺省。
  test('团队与报告各记各的落点（报告回放到上次看的那一份）', () => {
    expect(recordRouteLocation('/reports/daily-2026-08-27', {})).toBe('reports')
    expect(recordRouteLocation('/agents', {})).toBe('agents')
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'reports')
    expect(lastNavigate(navigate)).toEqual({ to: '/reports/daily-2026-08-27', search: {} })
    navigateToDomain(navigate as never, 'agents')
    expect(lastNavigate(navigate)).toEqual({ to: '/agents', search: {} })
  })

  test('不属于任何域的 path → 不记（回放仍走缺省）', () => {
    expect(recordRouteLocation('/nowhere', {})).toBeNull()
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'mail')
    expect(lastNavigate(navigate)).toEqual({ to: '/', search: { view: 'inbox' } })
  })

  // '/search' 是搜索标签的专属面，不归任何域 —— 若它被记进某个域的落点，跨域切回
  // 那个域会落到搜索页（域内位置被搜索页顶掉）。
  test("'/search' 不属于任何域，也不进落点记忆", () => {
    expect(recordRouteLocation('/search', {})).toBeNull()
    const navigate = vi.fn()
    navigateToDomain(navigate as never, 'mail')
    expect(lastNavigate(navigate)).toEqual({ to: '/', search: { view: 'inbox' } })
  })
})
