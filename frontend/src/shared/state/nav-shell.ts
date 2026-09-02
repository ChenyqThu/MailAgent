// nav shell store（task 09-01-sidebar-fluid-optimization，owner 拍板 A′+C 混合）。
//
// 08-27 修正批把「二级栏折叠」整链删掉（二级栏恒固定 392）；本批按域记忆重新引入：
//   - 每个域各记一份 `{ collapsed, width }`（C：切域回放该域的记忆，左列边界会变，
//     变化由 index.css 的 `@property` 变量过渡消化 —— 见 nav shell 段头注释）；
//   - 折叠 / hover peek / 拖宽 / `[` `]` / 抽屉这些机制全域共享（A′）。
//
// 🔴 `--app-nav-w` / `--app-second-w` 的**唯一写入点**是本文件的 `applyNavWidthVars`：
// 顶栏左段、DomainPanel、六个 page 域的清单列、`#batch-bar.floating` 全部只读这两个
// 变量。别在组件里 setProperty（闸：tests/shared/nav-shell.test.ts 源码文本断言）。
//
// 持久化键 `mailagent.nav.domainPrefs`（JSON map）。老键 `mailagent.nav.panelCollapsed`
// 是单个布尔（全域一份），语义已换 —— 有意不迁，全员从「每域展开 336」重新开始。
// 跨窗同步走 `storage` 事件（同 group-collapse / pinned-folders 范式）。

import { create } from 'zustand'

// 只引类型：本模块是叶子 store，运行时不依赖 registry。
import type { NavDomain } from '@shared/navigation/registry'

export const RAIL_W = 56
export const SECOND_W_DEFAULT = 336
export const SECOND_W_MIN = 280
export const SECOND_W_MAX = 420
/** 抽屉态（远程 web <768）顶栏左段只剩汉堡钮。 */
export const DRAWER_TOPBAR_W = 44

const KEY = 'mailagent.nav.domainPrefs'

export interface DomainNavPref {
  collapsed: boolean
  width: number
}

/** 'fixed' = 桌面常驻左列；'drawer' = 远程 web <768 的 off-canvas 抽屉。 */
export type NavShellMode = 'fixed' | 'drawer'

type Prefs = Partial<Record<NavDomain, DomainNavPref>>

export function clampSecondWidth(px: number): number {
  if (!Number.isFinite(px)) return SECOND_W_DEFAULT
  return Math.min(SECOND_W_MAX, Math.max(SECOND_W_MIN, Math.round(px)))
}

/** 某域的记忆；没记过 = 展开 336（与 v2.31.1 逐像素一致）。 */
export function domainPref(prefs: Prefs, domain: NavDomain): DomainNavPref {
  return prefs[domain] ?? { collapsed: false, width: SECOND_W_DEFAULT }
}

function readPrefs(): Prefs {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Prefs = {}
    for (const [domain, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const v = value as { collapsed?: unknown; width?: unknown }
      out[domain as NavDomain] = {
        collapsed: v.collapsed === true,
        width: typeof v.width === 'number' ? clampSecondWidth(v.width) : SECOND_W_DEFAULT
      }
    }
    return out
  } catch {
    return {}
  }
}

function writePrefs(prefs: Prefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* quota / private mode — state stays in memory. */
  }
}

/** 当前域在当前形态下的两个宽度（px）。抽屉态：第二列按记忆宽（它在抽屉里可见），
 *  顶栏左段只留汉堡钮。 */
export function navWidths(
  prefs: Prefs,
  domain: NavDomain,
  mode: NavShellMode
): { second: number; nav: number } {
  const pref = domainPref(prefs, domain)
  if (mode === 'drawer') return { second: pref.width, nav: DRAWER_TOPBAR_W }
  const second = pref.collapsed ? 0 : pref.width
  return { second, nav: RAIL_W + second }
}

/** 🔴 唯一写入点。`:root` 的静态声明只是 JS 前的首帧默认值。 */
function applyNavWidthVars(prefs: Prefs, domain: NavDomain, mode: NavShellMode): void {
  if (typeof document === 'undefined') return
  const { second, nav } = navWidths(prefs, domain, mode)
  const style = document.documentElement.style
  style.setProperty('--app-second-w', `${second}px`)
  style.setProperty('--app-nav-w', `${nav}px`)
}

function applyDragging(dragging: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.toggleAttribute('data-nav-dragging', dragging)
}

interface NavShellStore {
  /** 当前域（Sidebar 按路由写；'/search' 不属于任何域，回落 mail）。 */
  domain: NavDomain
  prefs: Prefs
  mode: NavShellMode
  /** 抽屉态是否拉开。 */
  drawerOpen: boolean
  /** 折叠态 hover / 聚焦导轨格后浮出的域；null = 没有 peek。 */
  peekDomain: NavDomain | null
  /** 拖宽进行中（关掉变量过渡，跟手）。 */
  dragging: boolean
  setDomain(domain: NavDomain): void
  setMode(mode: NavShellMode): void
  toggleCollapsed(domain?: NavDomain): void
  setCollapsed(domain: NavDomain, next: boolean): void
  setWidth(domain: NavDomain, px: number): void
  resetWidth(domain: NavDomain): void
  setDragging(next: boolean): void
  openPeek(domain: NavDomain): void
  closePeek(): void
  setDrawerOpen(next: boolean): void
}

const initialPrefs = readPrefs()
applyNavWidthVars(initialPrefs, 'mail', 'fixed')

export const useNavShell = create<NavShellStore>((set, get) => {
  /** 写 pref → 持久化 → 若是当前域就同步变量。 */
  const commit = (domain: NavDomain, next: DomainNavPref): void => {
    const prefs: Prefs = { ...get().prefs, [domain]: next }
    writePrefs(prefs)
    set({ prefs })
    const { domain: current, mode } = get()
    if (domain === current) applyNavWidthVars(prefs, current, mode)
  }
  return {
    domain: 'mail',
    prefs: initialPrefs,
    mode: 'fixed',
    drawerOpen: false,
    peekDomain: null,
    dragging: false,
    setDomain: (domain) => {
      if (get().domain === domain) return
      // 切域：关 peek、关抽屉，回放该域的记忆。
      set({ domain, peekDomain: null, drawerOpen: false })
      applyNavWidthVars(get().prefs, domain, get().mode)
    },
    setMode: (mode) => {
      if (get().mode === mode) return
      set({ mode, drawerOpen: false, peekDomain: null })
      applyNavWidthVars(get().prefs, get().domain, mode)
    },
    toggleCollapsed: (domain) => {
      const target = domain ?? get().domain
      const pref = domainPref(get().prefs, target)
      set({ peekDomain: null })
      commit(target, { ...pref, collapsed: !pref.collapsed })
    },
    setCollapsed: (domain, next) => {
      const pref = domainPref(get().prefs, domain)
      if (pref.collapsed === next) return
      set({ peekDomain: null })
      commit(domain, { ...pref, collapsed: next })
    },
    setWidth: (domain, px) => {
      const pref = domainPref(get().prefs, domain)
      const width = clampSecondWidth(px)
      if (pref.width === width) return
      commit(domain, { ...pref, width })
    },
    resetWidth: (domain) => {
      const pref = domainPref(get().prefs, domain)
      if (pref.width === SECOND_W_DEFAULT) return
      commit(domain, { ...pref, width: SECOND_W_DEFAULT })
    },
    setDragging: (next) => {
      if (get().dragging === next) return
      applyDragging(next)
      set({ dragging: next })
    },
    openPeek: (domain) => {
      if (get().peekDomain === domain) return
      set({ peekDomain: domain })
    },
    closePeek: () => {
      if (get().peekDomain === null) return
      set({ peekDomain: null })
    },
    setDrawerOpen: (next) => {
      if (get().drawerOpen === next) return
      set({ drawerOpen: next, peekDomain: null })
    }
  }
})

// 跨窗同步：另一个渲染窗写了同一个键，这里回灌并重算变量（本窗自己的写入不触发 storage 事件）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const prefs = readPrefs()
    useNavShell.setState({ prefs })
    const { domain, mode } = useNavShell.getState()
    applyNavWidthVars(prefs, domain, mode)
  })
}

// ── 组件侧只读选择器（选原始值，避免每次 set 都换新对象触发重渲染）────────────────

/** 当前域第二列是否折叠。 */
export function useNavSecondCollapsed(): boolean {
  return useNavShell((s) => domainPref(s.prefs, s.domain).collapsed)
}

/** 当前域第二列的记忆宽（px）—— 内层定宽用它，外层读 `--app-second-w`。 */
export function useNavSecondWidth(): number {
  return useNavShell((s) => domainPref(s.prefs, s.domain).width)
}

/** 某个具体域是否折叠（page 域清单列知道自己属于哪个域，直接问）。 */
export function useDomainCollapsed(domain: NavDomain): boolean {
  return useNavShell((s) => domainPref(s.prefs, domain).collapsed)
}

export function useDomainWidth(domain: NavDomain): number {
  return useNavShell((s) => domainPref(s.prefs, domain).width)
}

/** test-only：清空记忆并回到默认态。生产代码不要调。 */
export function __resetNavShellForTest(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  }
  applyDragging(false)
  useNavShell.setState({
    domain: 'mail',
    prefs: {},
    mode: 'fixed',
    drawerOpen: false,
    peekDomain: null,
    dragging: false
  })
  applyNavWidthVars({}, 'mail', 'fixed')
}

export const NAV_SHELL_STORAGE_KEY = KEY
