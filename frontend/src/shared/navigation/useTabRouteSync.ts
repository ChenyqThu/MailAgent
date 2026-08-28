// 标签工作区 ↔ 路由 双向同步（task 08-27 P2 Lane W）。挂载点 = RootLayout（router-instance）。
//
// 路由是唯一真相，同步是事件驱动的两条腿（各自只在不一致时动手，定点收敛不打环）：
//
//   store → route：激活槽变化（标签条点击 / 关标签后继承 / setMainPage）时，若目标域 ≠
//   当前路由域，经 registry 的 navigateToNavEntry 落地（路径字面量不出 registry）。
//
//   route → tab：路由域变化（rail 点击 / deeplink / 通知深链）时同步标签态 —— 页面域
//   setMainPage（页面型承载占用主标签）；对象域若激活标签不属于该域，激活该域
//   lastActiveAt 最近的标签，无标签则不动（维持域内空详情态，标签条高亮留在原处 ——
//   对象域的「空详情」在激活槽上没有表示法，硬拗成主标签反而会把承载页一起换掉）。
//
//   boot：启动时**标签侧赢一次**（PRD「关掉 app 再开……激活的还是上次那个」）——
//   路由恒从 '/' 起步，恢复的激活槽若在别的域，先导航过去；deeplink（若有）在其后
//   照常压过。
//
// 🔴 popout 窗不挂 router，本 hook 天然不在 popout 里跑，无需另设闸。

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'

import {
  MAIN_SLOT,
  TAB_KIND_DOMAIN,
  selectActiveTab,
  useTabWorkspace,
  type TabDescriptor,
  type TabKind,
  type TabWorkspaceState
} from '@shared/state/tab-workspace'
import {
  NAV_ENTRIES,
  navActiveDomain,
  navigateToNavEntry,
  navRailEntries,
  type NavDomain,
  type NavEntry
} from './registry'

/** 域 → 该域的缺省落点 entry。每个域恰有一格 rail（导轨 8+2 已满员），直接从 registry
 *  派生 —— 不另抄一份 domain→path 映射表（会漂）。 */
export function domainDefaultEntry(domain: NavDomain): NavEntry | null {
  return navRailEntries(NAV_ENTRIES).find((e) => e.domain === domain) ?? null
}

/** 激活槽归属的域：对象标签按 kind 查 TAB_KIND_DOMAIN，主标签 = mainPage。 */
export function activeSlotDomain(
  state: Pick<TabWorkspaceState, 'tabs' | 'active' | 'mainPage'>
): NavDomain {
  const tab = selectActiveTab(state)
  return tab === null ? state.mainPage : TAB_KIND_DOMAIN[tab.kind]
}

function mostRecentOfKind(tabs: readonly TabDescriptor[], kind: TabKind): TabDescriptor | null {
  let best: TabDescriptor | null = null
  for (const tab of tabs) {
    if (tab.kind !== kind) continue
    if (best === null || tab.lastActiveAt > best.lastActiveAt) best = tab
  }
  return best
}

/** route → tab 的一次收敛（纯 store 操作，不导航）。导出供单测。 */
export function reconcileRouteToTabs(domain: NavDomain): void {
  const state = useTabWorkspace.getState()
  if (domain === 'mail' || domain === 'matters') {
    const kind: TabKind = domain === 'mail' ? 'email' : 'matter'
    const active = selectActiveTab(state)
    if (active !== null && active.kind === kind) return
    const candidate = mostRecentOfKind(state.tabs, kind)
    if (candidate !== null) state.activateTab(candidate.id)
    return
  }
  // 页面域：占用主标签。setMainPage 隐含 active = MAIN_SLOT。
  if (state.mainPage !== domain || state.active !== MAIN_SLOT) state.setMainPage(domain)
}

function searchTabOf(search: unknown): string | undefined {
  const tab = (search as { tab?: unknown } | undefined)?.tab
  return typeof tab === 'string' ? tab : undefined
}

export function useTabRouteSync(): void {
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const searchTab = useRouterState({ select: (s) => searchTabOf(s.location.search) })

  // boot：标签侧赢一次。目标域与 '/' 相同则什么都不发生（最常见：上次就停在邮件标签上）。
  // lazy useState 只在首渲染求值一次（render 期写 ref 会撞 react-hooks/refs）。
  const [bootTarget] = useState<NavDomain | null>(() => {
    const target = activeSlotDomain(useTabWorkspace.getState())
    const current = navActiveDomain(NAV_ENTRIES, pathname, searchTab)
    return current !== null && current !== target ? target : null
  })
  const bootNavTarget = useRef(bootTarget)
  useEffect(() => {
    const target = bootNavTarget.current
    if (target === null) return
    const entry = domainDefaultEntry(target)
    if (entry !== null) navigateToNavEntry(navigate, entry)
    // 消费与否都只试一次；未到达前 route→tab 腿按下方 pending 判据让路。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // route → tab。boot 导航在途时（路由还停在出发点）不反向收敛，否则会把恢复的激活槽
  // 又改回出发域的标签。
  useEffect(() => {
    const domain = navActiveDomain(NAV_ENTRIES, pathname, searchTab)
    if (domain === null) return
    if (bootNavTarget.current !== null) {
      if (domain !== bootNavTarget.current) return
      bootNavTarget.current = null
      return // 到达 boot 目标域：激活槽本来就是这个域的，无需收敛。
    }
    reconcileRouteToTabs(domain)
  }, [pathname, searchTab])

  // store → route。订阅在 effect 里挂（StrictMode 双跑靠 cleanup 对冲）。
  useEffect(() => {
    return useTabWorkspace.subscribe((state, prev) => {
      if (state.active === prev.active && state.mainPage === prev.mainPage) return
      const target = activeSlotDomain(state)
      const loc = router.state.location
      const current = navActiveDomain(NAV_ENTRIES, loc.pathname, searchTabOf(loc.search))
      if (current === target) return
      const entry = domainDefaultEntry(target)
      if (entry !== null) navigateToNavEntry(navigate, entry)
    })
  }, [navigate, router])
}
