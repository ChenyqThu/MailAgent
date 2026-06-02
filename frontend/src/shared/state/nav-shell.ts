// Sprint 11 V1.4 — nav shell collapsed-state store.
//
// DESIGN.md §2.11 contract:
//   - 240px (expanded) ↔ 56px (collapsed)
//   - persists to localStorage["mailagent.nav.collapsed"]
//   - cross-window sync via the `storage` event so a pop-out compose /
//     detail window stays in lockstep with the main inbox window
//
// Mirrors the broadcast convention used by appearance.ts (theme/accent).
// The module-level `storage` listener installs once per renderer process
// at import time; SSR-gated by typeof window check. No leak in practice:
// the listener lives as long as the renderer process.

import { create } from 'zustand'

const KEY = 'mailagent.nav.collapsed'

// Sidebar widths — must stay in sync with `.app-nav` width in index.css
// (240px expanded / 56px collapsed; DESIGN.md §2.11). The sidebar itself is
// sized by `.app-nav[data-collapsed]` in CSS; this store mirrors the same
// width into the `--app-nav-w` custom property so detached fixed-position
// chrome that cannot read the zustand store — notably `#batch-bar.floating`
// (index.css §"Floating batch action bar") — reflows in lockstep when the
// sidebar collapses. Without it the batch bar stuck at the 240px fallback and
// floated ~184px right of its column once the sidebar shrank to 56px.
const NAV_W_EXPANDED = '240px'
const NAV_W_COLLAPSED = '56px'

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

function readPersisted(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

function writePersisted(next: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, String(next))
  } catch {
    /* Safari private mode / iframe sandbox / quota — DOM API boundary;
     * silently skipped, state remains in the zustand store. */
  }
}

interface NavShellStore {
  collapsed: boolean
  toggle: () => void
  setCollapsed: (next: boolean) => void
}

const initialCollapsed = readPersisted()
// Sync the CSS var to the persisted state on first load so the batch bar is
// already aligned before the user toggles anything.
applyNavWidthVar(initialCollapsed)

export const useNavCollapsed = create<NavShellStore>((set, get) => ({
  collapsed: initialCollapsed,
  toggle: () => {
    const next = !get().collapsed
    writePersisted(next)
    applyNavWidthVar(next)
    set({ collapsed: next })
  },
  setCollapsed: (next) => {
    writePersisted(next)
    applyNavWidthVar(next)
    set({ collapsed: next })
  }
}))

// Cross-window sync. When another renderer window flips the same
// localStorage key, the `storage` event fires here so this store updates
// without a re-read. The event fires only when ANOTHER window writes —
// the originating window already updated via `setCollapsed` / `toggle`.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const next = e.newValue === 'true'
    if (useNavCollapsed.getState().collapsed !== next) {
      applyNavWidthVar(next)
      useNavCollapsed.setState({ collapsed: next })
    }
  })
}
