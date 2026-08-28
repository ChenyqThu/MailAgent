// useTabRouteSync 的纯逻辑腿（08-27 P2 Lane W）：route → tab 收敛 + 激活槽域判定 +
// 域缺省落点派生（每域恰一格 rail，从 registry 派生不手抄映射表）。
// hook 本体（订阅接线）依赖 router context，由 dev 实测覆盖。

import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined
})

const { MAIN_SLOT, MAIN_PAGES, useTabWorkspace } =
  await import('../../src/shared/state/tab-workspace')
const { activeSlotDomain, domainDefaultEntry, reconcileRouteToTabs } =
  await import('../../src/shared/navigation/useTabRouteSync')
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

beforeEach(resetTabs)

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
})
