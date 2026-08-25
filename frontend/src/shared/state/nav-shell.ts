// nav shell collapsed-state store (Sprint 11 V1.4 起; task 08-24-l4-nav-shell
// Step B 起语义 = DomainPanel 显隐)。
//
// 方案 B contract（DESIGN.md §2.11）：
//   - collapsed = 域二级栏（232px DomainPanel）收起；56px IconRail 常驻不折叠
//     ⇒ shell 总宽 288px (expanded) ↔ 56px (collapsed)
//   - persists to localStorage["mailagent.nav.panelCollapsed"]。老单栏时代的键
//     `mailagent.nav.collapsed` **有意不迁**（0825 dogfood 实锤：老「整栏收起」
//     偏好被沿用成「面板收起」，owner 首启即「文件夹列没了」——语义已经换了，
//     换键让所有人从展开态重新开始；老键留在 localStorage 里无害）
//   - cross-window sync via the `storage` event so a pop-out compose /
//     detail window stays in lockstep with the main inbox window
//
// 批 E-3 (RESPONSIVE-XCUT-02 / LAYOUT-CHROME-01) — responsive auto-collapse.
// The *effective* collapsed state is `belowLg || userCollapsed`:
//   - belowLg     = viewport < lg(1024); forces the rail-only shell so the
//                   chrome never breaks on narrow widths. Reuses ALL existing
//                   `[data-collapsed='true']` CSS — no new authored rules.
//   - userCollapsed = the user's manual fold preference (persisted), honoured
//                   at ≥lg. Toggling at <lg flips the pref but the panel stays
//                   forced-hidden (the shell is already rail-only there).
//
// Mirrors the broadcast convention used by appearance.ts (theme/accent).
// The module-level `storage` + `matchMedia` listeners install once per
// renderer process at import time; SSR-gated by typeof window check.

import { create } from 'zustand'

const KEY = 'mailagent.nav.panelCollapsed'

// Shell widths — must stay in sync with `.nav-rail`(56) + `.nav-panel`(232)
// in index.css. The shell itself is sized by authored CSS; this store mirrors
// the same width into the `--app-nav-w` custom property so detached
// fixed-position chrome that cannot read the zustand store — notably
// `#batch-bar.floating` (index.css §"Floating batch action bar") — reflows in
// lockstep when the panel collapses.
const NAV_W_EXPANDED = '288px'
const NAV_W_COLLAPSED = '56px'

// <lg auto-collapse breakpoint — aligns with Tailwind `lg`(1024) and the
// useMediaQuery shell breakpoints (EmailList lg:w-[340px] etc).
const BELOW_LG = '(max-width: 1023px)'

// Mirror collapsed state into the --app-nav-w CSS var. Gated on `document`
// (DOM-only API; no-op under SSR / non-renderer import contexts). The 220ms
// `left` transition on #batch-bar.floating (index.css) animates the realign.
function applyNavWidthVar(collapsed: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty(
    '--app-nav-w',
    collapsed ? NAV_W_COLLAPSED : NAV_W_EXPANDED
  )
}

function readUserPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

function writeUserPref(next: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, String(next))
  } catch {
    /* Safari private mode / iframe sandbox / quota — DOM API boundary;
     * silently skipped, state remains in the zustand store. */
  }
}

function readBelowLg(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.(BELOW_LG).matches === true
}

interface NavShellStore {
  /** Effective collapsed = belowLg || userCollapsed (see file header). */
  collapsed: boolean
  /** viewport <lg 的强制收起 —— toggle 解除不了；rail 的开合按钮据此隐藏。 */
  forced: boolean
  toggle: () => void
  setCollapsed: (next: boolean) => void
}

// Module-level latches feeding `effective()`. `belowLg` follows the viewport
// (matchMedia listener below); `userCollapsed` follows the persisted manual
// preference (toggle / setCollapsed / cross-window storage event).
let belowLg = readBelowLg()
let userCollapsed = readUserPref()
function effective(): boolean {
  return belowLg || userCollapsed
}

const initialCollapsed = effective()
// Sync the CSS var to the effective state on first load so the batch bar is
// already aligned before the user toggles anything / before any resize.
applyNavWidthVar(initialCollapsed)

export const useNavCollapsed = create<NavShellStore>((set) => ({
  collapsed: initialCollapsed,
  forced: belowLg,
  toggle: () => {
    // Flip the *manual* preference (persisted). At <lg the effective state
    // stays forced-collapsed (the rail is already icon-only there), so the
    // toggle has no visible effect until the viewport returns to ≥lg.
    userCollapsed = !userCollapsed
    writeUserPref(userCollapsed)
    const next = effective()
    applyNavWidthVar(next)
    set({ collapsed: next })
  },
  setCollapsed: (next) => {
    userCollapsed = next
    writeUserPref(next)
    const eff = effective()
    applyNavWidthVar(eff)
    set({ collapsed: eff })
  }
}))

// Responsive breakpoint linkage — recompute effective collapsed when the
// viewport crosses the lg boundary (window resize / zoom / web responsive).
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia(BELOW_LG)
  mq.addEventListener('change', (e) => {
    belowLg = e.matches
    const next = effective()
    applyNavWidthVar(next)
    useNavCollapsed.setState({ collapsed: next, forced: belowLg })
  })
}

// Cross-window sync. When another renderer window flips the same
// localStorage key, the `storage` event fires here so this store updates
// without a re-read. The event fires only when ANOTHER window writes —
// the originating window already updated via `setCollapsed` / `toggle`.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    userCollapsed = e.newValue === 'true'
    const next = effective()
    applyNavWidthVar(next)
    if (useNavCollapsed.getState().collapsed !== next) {
      useNavCollapsed.setState({ collapsed: next })
    }
  })
}
