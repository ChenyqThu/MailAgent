// 标签工作区 ↔ 路由 双向同步（task 08-27 P2 Lane W）。挂载点 = RootLayout（router-instance）。
//
// 路由是唯一真相，同步是事件驱动的两条腿（各自只在不一致时动手，定点收敛不打环）：
//
//   store → route：激活槽变化（标签条点击 / 关标签后继承 / setMainPage）时，若目标域 ≠
//   当前路由域，经 domain-location 的 navigateToDomain 落地（路径字面量不出 registry）。
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
// 跨域切回落在**该域上次的落点**而不是域缺省 entry（解析与记忆在 ./domain-location，
// 导轨格点击共用同一份）—— 域内位置在 URL 里（邮件五视图 `/?view=flagged`、日历
// `?view=month`、报告 `/reports/<id>`），恒落缺省会把「已加星标」重置成收件箱。
//
// 搜索标签（kind='search'，P2 补批 Lane S）不归任何域，两腿各有一条特判：激活它 →
// navigate '/search'（绕过 navigateToDomain —— 那是域的解析）；pathname='/search'
// （deeplink / 刷新）→ 确保搜索单例存在并激活。'/search' 不进 per-域落点记忆
// （recordRouteLocation 对它返回 null 属预期 —— 搜索页不该被记成某个域的落点）。
//
// 🔴 popout 窗与 P5 轻窗（detached）都不挂 router，本 hook 天然不在它们里面跑，无需另设闸。

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
import { openSearchTab } from '@shared/state/tab-workspace-bridge'
import { navigateToDomain, recordRouteLocation } from './domain-location'
import { NAV_ENTRIES, navActiveDomain, type NavDomain } from './registry'

/** 搜索标签的承载路由。不是 NavPath（不进 registry：无 rail 格、无 jump 行、无深链
 *  白名单），路由注册在 router-instance 的 searchRoute —— 那边的 path 与这里必须同值，
 *  各自都是「自己那侧的必要字面量」（TanStack 的 typed `to` 也吃不了跨文件常量收敛）。 */
const SEARCH_ROUTE_PATH = '/search'

/** `activeSlotDomain` 的搜索槽哨兵 —— 搜索标签不归任何域，路由目标是 '/search' 专属面。 */
export const SEARCH_SLOT = 'search' as const

/** 激活槽的路由目标：十个域之一，或搜索面。 */
export type SlotRouteTarget = NavDomain | typeof SEARCH_SLOT

/** 激活槽归属的路由目标：对象标签按 kind 查 TAB_KIND_DOMAIN，搜索标签 = SEARCH_SLOT
 *  （无域），主标签 = mainPage。 */
export function activeSlotDomain(
  state: Pick<TabWorkspaceState, 'tabs' | 'active' | 'mainPage'>
): SlotRouteTarget {
  const tab = selectActiveTab(state)
  if (tab === null) return state.mainPage
  return tab.kind === 'search' ? SEARCH_SLOT : TAB_KIND_DOMAIN[tab.kind]
}

/** 订阅腿要不要校一次路由。主判据是「激活槽变了」；另有一支：**搜索单例被重新激活**
 *  （`active` 没变、`lastActiveAt` 变了）。
 *
 *  🔴 少了这一支，⌘T /「+」会有一种什么也不发生的局面：搜索标签已经激活、但路由已经
 *  不在 '/search' 了（rail 切到某个对象域、而那个域一个标签都没有时，激活槽按既有语义
 *  留在原处），此时再按 ⌘T 走 openTab 的 `activated` 支 —— 不改 `active`，只看 active
 *  变化就不会导航。⌘T 是「把我送到新标签页」的导航命令，必须恒到达。
 *
 *  对象标签**不**同样处理：再点一次同一封邮件不带导航意图，且它有列表冷启动自动重选
 *  这类非用户直接触发的重复 openTab，放开会变成从别的域被拽走。 */
export function needsRouteResync(
  state: Pick<TabWorkspaceState, 'tabs' | 'active' | 'mainPage'>,
  prev: Pick<TabWorkspaceState, 'tabs' | 'active' | 'mainPage'>
): boolean {
  if (state.active !== prev.active || state.mainPage !== prev.mainPage) return true
  const now = selectActiveTab(state)
  if (now === null || now.kind !== 'search') return false
  return now.lastActiveAt !== selectActiveTab(prev)?.lastActiveAt
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

export function useTabRouteSync(): void {
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // 取整个 search（不只 `?tab=`）：落点要原样记下来才能回放。TanStack 对
  // `location.search` 做结构共享（parseLocation 的 nullReplaceEqualDeep），内容不变时
  // 引用也不变 —— 放进下面的 effect 依赖不会每次路由通知都重跑。
  const search = useRouterState({ select: (s) => s.location.search })

  // boot：标签侧赢一次。目标域与 '/' 相同则什么都不发生（最常见：上次就停在邮件标签上）。
  // lazy useState 只在首渲染求值一次（render 期写 ref 会撞 react-hooks/refs）。
  const [bootTarget] = useState<SlotRouteTarget | null>(() => {
    const target = activeSlotDomain(useTabWorkspace.getState())
    // 恢复的激活槽是搜索标签：路由恒从 '/' 起步（≠ '/search'），恒需导航。
    if (target === SEARCH_SLOT) return pathname === SEARCH_ROUTE_PATH ? null : target
    const current = navActiveDomain(NAV_ENTRIES, pathname)
    return current !== null && current !== target ? target : null
  })
  const bootNavTarget = useRef(bootTarget)
  useEffect(() => {
    const target = bootNavTarget.current
    if (target === null) return
    if (target === SEARCH_SLOT) {
      // 搜索面不是域，绕过 navigateToDomain（那是「域 → 落点」的解析）。
      void navigate({ to: SEARCH_ROUTE_PATH })
      return
    }
    // 与 store→route 腿走同一个「域 → 落点」解析：boot 时记忆通常还是空的（落点由下方
    // route→tab 腿写，那条 effect 在本条之后跑），实际落缺省 entry；共用一条路径是为了
    // 不出现第二份解析判据。
    navigateToDomain(navigate, target)
    // 消费与否都只试一次；未到达前 route→tab 腿按下方 pending 判据让路。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // route → tab。boot 导航在途时（路由还停在出发点）不反向收敛，否则会把恢复的激活槽
  // 又改回出发域的标签。
  useEffect(() => {
    if (pathname === SEARCH_ROUTE_PATH) {
      // '/search' 不属于任何域也不进落点记忆；boot 目标是它时到达即消费。
      if (bootNavTarget.current !== null) {
        if (bootNavTarget.current !== SEARCH_SLOT) return
        bootNavTarget.current = null
        return // 到达 boot 目标：激活槽本来就是搜索标签，无需收敛。
      }
      // deeplink / 刷新：确保搜索单例存在并激活（已激活则不动；开/激活走 bridge 的
      // 同一入口，淘汰 toast 判据不另抄）。
      if (selectActiveTab(useTabWorkspace.getState())?.kind !== 'search') openSearchTab()
      return
    }
    // 记录本次落点（含在途的 boot 出发点：确实到过，回放它不会错）。
    const domain = recordRouteLocation(pathname, search)
    if (domain === null) return
    if (bootNavTarget.current !== null) {
      if (domain !== bootNavTarget.current) return
      bootNavTarget.current = null
      return // 到达 boot 目标域：激活槽本来就是这个域的，无需收敛。
    }
    reconcileRouteToTabs(domain)
  }, [pathname, search])

  // store → route。订阅在 effect 里挂（StrictMode 双跑靠 cleanup 对冲）。
  useEffect(() => {
    return useTabWorkspace.subscribe((state, prev) => {
      if (!needsRouteResync(state, prev)) return
      const target = activeSlotDomain(state)
      const loc = router.state.location
      if (target === SEARCH_SLOT) {
        // 激活搜索标签 → '/search'（特判腿；不是域，不走 navigateToDomain）。
        if (loc.pathname !== SEARCH_ROUTE_PATH) void navigate({ to: SEARCH_ROUTE_PATH })
        return
      }
      const current = navActiveDomain(NAV_ENTRIES, loc.pathname)
      if (current === target) return
      navigateToDomain(navigate, target)
    })
  }, [navigate, router])
}
