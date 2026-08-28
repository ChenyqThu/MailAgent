// 「域 → 落点」的解析（task 08-27 P2 补批 Lane R）。
//
// 跨域切回落在**该域上次的落点**，不是恒落域缺省 entry —— 域内位置在 URL 里
// （邮件五视图 `/?view=flagged`、日历 `?view=month`、`/agents?tab=reports`），恒落缺省会把
// 「已加星标」重置成收件箱。记忆是会话内的，不持久化（跨会话首次进各域走缺省即可）。
//
// 🔴 回放的是 router 自己给过的 pathname + search（下面 recordRouteLocation 记的），
// 不是在这里手抄路径字面量 —— registry 仍是唯一把「域」落成具体路径的地方，无记录时
// 恒回落 navigateToNavEntry。
//
// 为什么单独成模块而不是留在 useTabRouteSync：读取面有两个消费者 —— 那个 hook 的
// store→route / boot 两腿，与 Sidebar 的导轨切域点击（rail 点击是「回邮件域」最常走的
// 路径）。让 Sidebar 去 import 那个 hook 模块，会把 tab-workspace / tab-workspace-bridge
// （顶层拉 i18n）整条 import 图拖进侧栏与它的测试。本模块运行时只依赖 registry。

// 只引类型：`import type` 编译期擦除，本模块运行时不依赖 router（同 registry 的做法）。
import type { useNavigate } from '@tanstack/react-router'

import {
  NAV_ENTRIES,
  navActiveDomain,
  navigateToNavEntry,
  navRailEntries,
  type NavDomain,
  type NavEntry
} from './registry'

type NavigateFn = ReturnType<typeof useNavigate>

/** 路由 search 的原样搬运形状：只从 router 拿、只原样递回 navigate，不在这里解释字段。 */
export type RouteSearch = Record<string, unknown>

/** `?tab=` 细分（过渡期 `/agents` 被 team 与 reports 两域共用，靠它归属）。 */
export function searchTabOf(search: unknown): string | undefined {
  const tab = (search as { tab?: unknown } | undefined)?.tab
  return typeof tab === 'string' ? tab : undefined
}

/** 域 → 该域的缺省落点 entry。每个域恰有一格 rail（导轨 8+2 已满员），直接从 registry
 *  派生 —— 不另抄一份 domain→path 映射表（会漂）。 */
export function domainDefaultEntry(domain: NavDomain): NavEntry | null {
  return navRailEntries(NAV_ENTRIES).find((e) => e.domain === domain) ?? null
}

/** 会话内记忆。 */
const lastLocationByDomain = new Map<NavDomain, { pathname: string; search: RouteSearch }>()

/** 记下当前 location 归属域的落点，返回归属域（不属于任何域 → null，不记）。
 *  route → tab 腿每次路由变化时调用。 */
export function recordRouteLocation(pathname: string, search: RouteSearch): NavDomain | null {
  const domain = navActiveDomain(NAV_ENTRIES, pathname, searchTabOf(search))
  if (domain === null) return null
  lastLocationByDomain.set(domain, { pathname, search })
  return domain
}

/** 导航到某个域：本会话到过就回放那次的 location，否则落该域缺省 entry。
 *  切域的三条路径（导轨格点击 / 激活槽变化 / boot）都走这里，别再各写各的目标。 */
export function navigateToDomain(navigate: NavigateFn, domain: NavDomain): void {
  const last = lastLocationByDomain.get(domain)
  if (last !== undefined) {
    void navigate({ to: last.pathname, search: last.search })
    return
  }
  const entry = domainDefaultEntry(domain)
  if (entry !== null) navigateToNavEntry(navigate, entry)
}

/** test-only：清空落点记忆，避免用例之间串味。生产代码不要调。 */
export function __resetDomainLocations(): void {
  lastLocationByDomain.clear()
}
